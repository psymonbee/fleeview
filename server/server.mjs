#!/usr/bin/env node
// FleetView server: static file server for public/ + SSE fleet state at
// GET /events + GET /healthz + GET /agents/:id/log + GET /sessions/:id/log
// (§25). Tails the neutral events JSONL file (docs/FLEETVIEW-SPEC.md §8),
// reduces it into Session/AgentRun/Plan state (§11, §24, §25, §26), and
// pushes updates to connected clients (§12). Zero npm dependencies —
// node:http / node:fs only.

import http from "node:http";
import {
  createReadStream,
  existsSync,
  statSync,
  readFileSync,
  watch as fsWatch,
} from "node:fs";
import { open as fsOpen } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { scanAgentDir } from "./discovery.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");
const CONFIG_PATH = path.resolve(__dirname, "..", "fleet.config.json");
const PORT = Number(process.env.PORT) || 4747;
const EVENTS_FILE =
  process.env.FLEET_EVENTS_FILE ||
  path.join(homedir(), ".lumenade", "events.jsonl");

const PING_INTERVAL_MS = 15000;
const POLL_INTERVAL_MS = 1000;
const AGENT_MAX_AGE_MS = 60 * 60 * 1000; // 1h
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h
const PENDING_SPAWN_CAP = 20;
const PENDING_SPAWN_TTL_MS = 10 * 60 * 1000; // 10 min
const LOG_RING_CAP = 50;
const ERROR_INFERENCE_MS = 2500;

// ---------------------------------------------------------------------------
// Config — fleet.config.json, shallow-merged over identical built-in
// defaults (§10). Missing/corrupt file -> defaults, still boots.
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = {
  hub: { title: "Orchestrator" },
  agents: {
    builder: { label: "Builder", model: "Claude Sonnet 5", provider: "anthropic" },
    checker: { label: "Checker", model: "Claude Opus 4.8", provider: "anthropic" },
    "codex-runner": { label: "Codex relay", model: "OpenAI Codex", provider: "openai" },
    "codex-direct": { label: "Codex (direct)", model: "OpenAI Codex", provider: "openai" },
  },
  fallbackAgent: { model: "Claude", provider: "anthropic" },
  modelNames: {
    "claude-fable-5": "Claude Fable 5",
    "claude-opus-4-8": "Claude Opus 4.8",
    "claude-sonnet-5": "Claude Sonnet 5",
    "claude-haiku-4-5": "Claude Haiku 4.5",
  },
  // Bare aliases (as agent frontmatter uses, e.g. `model: sonnet`) resolved
  // to a canonical model id before modelNames prettification (§22).
  // `inherit` and unknown aliases pass through untouched.
  modelAliases: {
    sonnet: "claude-sonnet-5",
    opus: "claude-opus-4-8",
    haiku: "claude-haiku-4-5",
    fable: "claude-fable-5",
  },
  stallThresholdMs: 120000,
  narration: {
    enabled: false,
    model: "haiku",
    debounceMs: 15000,
    minNewLines: 3,
    maxConcurrent: 1,
    timeoutMs: 30000,
  },
  // Token/cost enrichment (§19.4). USD per MTok, verified against current API
  // pricing 2026-07-17 (cache read = 0.1x input; 5-minute cache write = 1.25x
  // input). Do not change these numbers without re-verifying against current
  // API pricing.
  enrichment: {
    enabled: true,
    intervalMs: 5000,
    pricing: {
      "claude-fable-5": { in: 10, out: 50, cacheRead: 1, cacheWrite: 12.5 },
      "claude-opus-4-8": { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
      "claude-sonnet-5": { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      "claude-haiku-4-5": { in: 1, out: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    },
  },
};

// Returns { config, fileAgents }: `config` is the usual shallow merge over
// DEFAULT_CONFIG; `fileAgents` is the on-disk file's own `agents` map (or
// `null` if the file didn't provide one) -- resolveAgentMeta (§22) needs to
// tell "explicit user-file config.agents entry" apart from DEFAULT_CONFIG's
// built-in `agents`, which a plain shallow merge collapses into one.
function loadConfig() {
  let fileConfig = null;
  try {
    const raw = readFileSync(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      fileConfig = parsed;
    }
  } catch {
    // Missing or corrupt — fall through to defaults, still boots.
  }
  const config = fileConfig ? { ...DEFAULT_CONFIG, ...fileConfig } : { ...DEFAULT_CONFIG };
  const fileAgents =
    fileConfig && Object.prototype.hasOwnProperty.call(fileConfig, "agents") ? fileConfig.agents : null;
  return { config, fileAgents };
}

const { config, fileAgents: fileConfigAgents } = loadConfig();

// ---------------------------------------------------------------------------
// Agent auto-discovery (§22) -- user-level scanned once at boot; project-
// level re-scanned per session.start (rare event; that IS the entire cadence
// story, no watchers). Project-level entries shadow user-level ones by name.
// homedir() (not process.env.HOME directly) is the test seam: tests spawn
// this server with a scratch HOME so boot-scan hits a scratch agents dir.
// ---------------------------------------------------------------------------

const discoveredUserAgents = scanAgentDir(path.join(homedir(), ".claude", "agents"));
/** @type {Map<string, object>} sessionId -> discovered project-level agents */
let discoveredProjectAgents = new Map();

function lookupDiscovered(agentType, sessionId) {
  const project = sessionId ? discoveredProjectAgents.get(sessionId) : null;
  if (project && Object.prototype.hasOwnProperty.call(project, agentType)) return project[agentType];
  if (Object.prototype.hasOwnProperty.call(discoveredUserAgents, agentType)) {
    return discoveredUserAgents[agentType];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Agent metadata resolution (§22 resolveAgentMeta, amends §10)
// ---------------------------------------------------------------------------

// Trailing date-suffix on model ids, e.g. "claude-opus-4-8-20260201".
const DATE_SUFFIX_RE = /-\d{4}-?\d{2}-?\d{2}$|-\d{8}$/;

function prettifyModel(modelId) {
  if (typeof modelId !== "string" || modelId === "") return modelId;
  const names = config.modelNames || {};
  if (Object.prototype.hasOwnProperty.call(names, modelId)) return names[modelId];

  const stripped = modelId.replace(DATE_SUFFIX_RE, "");
  let best = null;
  for (const key of Object.keys(names)) {
    if (stripped === key || stripped.startsWith(key)) {
      if (!best || key.length > best.length) best = key;
    }
  }
  if (best) return names[best];
  return modelId; // raw id — no match anywhere
}

// Bare alias (agent frontmatter's `model: sonnet`) -> canonical model id,
// resolved *before* prettifyModel. `inherit`/unknown aliases pass through.
function resolveModelAlias(modelId) {
  if (typeof modelId !== "string" || modelId === "") return modelId;
  const aliases = config.modelAliases || {};
  return Object.prototype.hasOwnProperty.call(aliases, modelId) ? aliases[modelId] : modelId;
}

// Provider inference for discovered agents: "anthropic" unless the
// alias-resolved model id starts gpt/o[0-9]/codex -> "openai".
const OPENAI_MODEL_RE = /^(gpt|o[0-9]|codex)/;
function inferProvider(resolvedModelId) {
  if (typeof resolvedModelId === "string" && OPENAI_MODEL_RE.test(resolvedModelId)) return "openai";
  return "anthropic";
}

// Precedence (§22, replacing §10's 3-step):
// 1. event model, alias-resolved then prettified -- overrides whichever
//    base tier below supplies label/provider/model, always on top;
// 2. else user-file config.agents[agentType] (fileConfigAgents: an agents
//    map actually present in the on-disk fleet.config.json);
// 3. else discovered entry (project-level, then user-level), model
//    alias-resolved + prettified, provider inferred;
// 4. else built-in default agents entry (DEFAULT_CONFIG.agents, kept at all
//    four entries so the demo and preserved v3 configs render identically);
// 5. else {label: agentType, ...fallbackAgent} -- with the codex exception:
//    a `codex:`-prefixed sessionId gets fallback provider "openai".
function resolveAgentMeta(agentType, eventModel, sessionId) {
  let base;
  if (fileConfigAgents && Object.prototype.hasOwnProperty.call(fileConfigAgents, agentType)) {
    base = fileConfigAgents[agentType];
  } else {
    const discovered = lookupDiscovered(agentType, sessionId);
    if (discovered) {
      const resolvedModelId =
        discovered.model !== undefined ? resolveModelAlias(discovered.model) : undefined;
      base = {
        label: discovered.label,
        provider: inferProvider(resolvedModelId),
        model: resolvedModelId !== undefined ? prettifyModel(resolvedModelId) : undefined,
      };
    } else if (Object.prototype.hasOwnProperty.call(DEFAULT_CONFIG.agents, agentType)) {
      base = DEFAULT_CONFIG.agents[agentType];
    } else {
      const isCodexSession = typeof sessionId === "string" && sessionId.startsWith("codex:");
      base = {
        label: agentType,
        ...(config.fallbackAgent || {}),
        ...(isCodexSession ? { provider: "openai" } : {}),
      };
    }
  }

  const meta = { label: base.label, provider: base.provider, model: base.model };
  if (eventModel) meta.model = prettifyModel(resolveModelAlias(eventModel));
  return meta;
}

// ---------------------------------------------------------------------------
// State (§11)
// ---------------------------------------------------------------------------

/** @type {Map<string, object>} sessionId -> Session */
let sessions = new Map();
/** @type {Map<string, object>} agentId -> AgentRun */
let agents = new Map();
/** @type {Map<string, Array<object>>} sessionId -> legacy fuzzy pending-spawn list */
let pendingSpawns = new Map();
/** codex-direct synthesized-id counters, per session */
let codexCounters = new Map();
/** @type {Map<string, object>} sessionId -> Plan */
let plans = new Map();
/** @type {Map<string, Array<object>>} agentId -> LogEntry ring (cap 50) */
let agentLogs = new Map();
/** @type {Map<string, Array<object>>} sessionId -> LogEntry ring (cap 50, §25) */
let sessionLogs = new Map();
/** @type {Map<string, Map<string, object>>} agentId -> callId -> open call */
let openCalls = new Map();
/** @type {Map<string, object>} agentId -> {description, model, agentType, parentAgentId?, t, sessionId} */
let exactPending = new Map();

/** SSE subscriber response objects */
const subscribers = new Set();

function resetState() {
  sessions = new Map();
  agents = new Map();
  pendingSpawns = new Map();
  codexCounters = new Map();
  plans = new Map();
  agentLogs = new Map();
  sessionLogs = new Map();
  openCalls = new Map();
  exactPending = new Map();
  discoveredProjectAgents = new Map();
}

function clip(str, max) {
  if (typeof str !== "string") return str;
  return str.length > max ? str.slice(0, max) : str;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

function getOrCreateSession(sessionId, t, cwd) {
  let session = sessions.get(sessionId);
  if (!session) {
    session = {
      id: sessionId,
      cwd: cwd ?? null,
      startedAt: t,
      lastActivityAt: t,
      turnActive: false,
      ended: false,
      transcriptPath: null,
      tokens: null,
      costUsd: null,
      model: null, // §31.2
      title: null, // §32.4
      currentActivity: null, // §25
      capabilities: [], // §26
    };
    sessions.set(sessionId, session);
    broadcast({ type: "session", session });
  }
  return session;
}

// ---------------------------------------------------------------------------
// Legacy fuzzy pending-spawn list (v1 behavior, kept for spawn-pending
// without agentId)
// ---------------------------------------------------------------------------

function pushPendingSpawn(sessionId, spawn) {
  let list = pendingSpawns.get(sessionId);
  if (!list) {
    list = [];
    pendingSpawns.set(sessionId, list);
  }
  list.push(spawn);
  if (list.length > PENDING_SPAWN_CAP) {
    list.splice(0, list.length - PENDING_SPAWN_CAP);
  }
}

// Returns the claimed spawn record (§24: carries parentAgentId when the
// fuzzy PreToolUse event had one) or null when nothing matched/remained.
function claimPendingSpawn(sessionId, agentType, nowMs) {
  const list = pendingSpawns.get(sessionId);
  if (!list || list.length === 0) return null;

  // Expire stale entries first.
  for (let i = list.length - 1; i >= 0; i--) {
    const age = nowMs - Date.parse(list[i].t);
    if (Number.isFinite(age) && age > PENDING_SPAWN_TTL_MS) {
      list.splice(i, 1);
    }
  }
  if (list.length === 0) return null;

  let idx = list.findIndex((s) => s.agentType === agentType);
  if (idx === -1) idx = 0;
  const [claimed] = list.splice(idx, 1);
  return claimed || null;
}

// Exact-claim spawn-pending removes its PreToolUse (legacy fuzzy) twin so the
// eventual agent.start doesn't double-claim it.
function removeMatchingPendingSpawn(sessionId, description) {
  const list = pendingSpawns.get(sessionId);
  if (!list || list.length === 0) return;
  const idx = list.findIndex((s) => s.description === description);
  if (idx !== -1) list.splice(idx, 1);
}

// ---------------------------------------------------------------------------
// Agent log ring + open-call tracking
// ---------------------------------------------------------------------------

function pushLogEntry(agentId, entry) {
  let list = agentLogs.get(agentId);
  if (!list) {
    list = [];
    agentLogs.set(agentId, list);
  }
  list.push(entry);
  if (list.length > LOG_RING_CAP) {
    list.splice(0, list.length - LOG_RING_CAP);
  }
}

// §25: per-session log ring, same cap/shape convention as pushLogEntry.
function pushSessionLogEntry(sessionId, entry) {
  let list = sessionLogs.get(sessionId);
  if (!list) {
    list = [];
    sessionLogs.set(sessionId, list);
  }
  list.push(entry);
  if (list.length > LOG_RING_CAP) {
    list.splice(0, list.length - LOG_RING_CAP);
  }
}

function addFile(files, file) {
  const next = (files || []).filter((f) => f !== file);
  next.unshift(file);
  if (next.length > 5) next.length = 5;
  return next;
}

function upsertAgent(agent) {
  agents.set(agent.id, agent);
  broadcast({ type: "agent", agent });
}

// §24 self-reference guard: an agent can never be its own parent.
function sanitizeParentId(parentId, selfId) {
  if (parentId == null) return null;
  return parentId === selfId ? null : parentId;
}

// §26: derive a capability tag from a tool name -- mcp__<server>__<tool> ->
// {kind: "mcp", name: <server>} (first "__"-delimited segment after the
// "mcp__" prefix); tool === "Skill" with a non-empty hint -> {kind: "skill",
// name: hint}. Anything else -> null (no capability signal).
function deriveCapability(tool, hint) {
  if (typeof tool !== "string") return null;
  if (tool.startsWith("mcp__")) {
    const rest = tool.slice("mcp__".length);
    const idx = rest.indexOf("__");
    const server = idx === -1 ? rest : rest.slice(0, idx);
    return server ? { kind: "mcp", name: server } : null;
  }
  if (tool === "Skill" && typeof hint === "string" && hint.length > 0) {
    return { kind: "skill", name: hint };
  }
  return null;
}

// §26: insertion-ordered, deduped (kind:name) append onto record.capabilities,
// cap 8 (first 8 win). No-op when tag is null or already present or the cap
// is already full.
function addCapabilityTag(record, tag) {
  if (!tag) return;
  if (!Array.isArray(record.capabilities)) record.capabilities = [];
  const key = `${tag.kind}:${tag.name}`;
  if (record.capabilities.some((c) => `${c.kind}:${c.name}` === key)) return;
  if (record.capabilities.length >= 8) return;
  record.capabilities.push(tag);
}

// Null agentId only ever occurs for codex-direct (S1 finding, §9): pair it
// to the oldest still-running codex-direct AgentRun in the session. Used by
// both agent.activity (a null-id activity belongs to whichever codex-direct
// call is currently open) and agent.end.
function findOldestRunningCodexDirect(sessionId) {
  let oldest = null;
  for (const a of agents.values()) {
    if (a.sessionId === sessionId && a.agentType === "codex-direct" && a.status === "running") {
      if (!oldest || Date.parse(a.startedAt) < Date.parse(oldest.startedAt)) oldest = a;
    }
  }
  return oldest;
}

// ---------------------------------------------------------------------------
// Plan / matchPlanStep (§11 deterministic fuzzy match)
// ---------------------------------------------------------------------------

function getOrCreatePlan(sessionId, t) {
  let plan = plans.get(sessionId);
  if (!plan) {
    plan = { sessionId, steps: [], doc: null, updatedAt: t };
    plans.set(sessionId, plan);
  }
  return plan;
}

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "to",
  "in",
  "for",
  "with",
  "on",
  "by",
]);

function normalizeTokens(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .filter((tok) => tok.length >= 3 && !STOPWORDS.has(tok));
}

const STATUS_RANK = { active: 2, pending: 1, done: 0 };

function betterCandidate(candidate, current) {
  if (!current) return true;
  if (candidate.score !== current.score) return candidate.score > current.score;
  const cr = STATUS_RANK[candidate.step.status] ?? -1;
  const kr = STATUS_RANK[current.step.status] ?? -1;
  if (cr !== kr) return cr > kr;
  return false; // earlier step order already wins by iterating forward with strict `>`
}

function matchPlanStep(sessionId, description) {
  const plan = plans.get(sessionId);
  if (!plan || plan.steps.length === 0) return null;

  const descTokens = normalizeTokens(description);
  if (descTokens.length === 0) return null;
  const descNorm = descTokens.join(" ");
  const descSet = new Set(descTokens);

  // Tier 1: substring containment (either direction) wins immediately.
  let containmentBest = null;
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    const stepTokens = normalizeTokens(step.subject);
    const stepNorm = stepTokens.join(" ");
    if (!stepNorm) continue;
    if (descNorm.includes(stepNorm) || stepNorm.includes(descNorm)) {
      const candidate = { step, score: 1 };
      if (betterCandidate(candidate, containmentBest)) containmentBest = candidate;
    }
  }
  if (containmentBest) return containmentBest.step.id;

  // Tier 2: token-overlap score |A n B| / min(|A|,|B|), best >= 0.5 wins.
  let overlapBest = null;
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    const stepTokens = normalizeTokens(step.subject);
    if (stepTokens.length === 0) continue;
    const stepSet = new Set(stepTokens);
    let inter = 0;
    for (const tok of stepSet) if (descSet.has(tok)) inter++;
    const denom = Math.min(descSet.size, stepSet.size);
    const score = denom === 0 ? 0 : inter / denom;
    if (score >= 0.5) {
      const candidate = { step, score };
      if (betterCandidate(candidate, overlapBest)) overlapBest = candidate;
    }
  }
  return overlapBest ? overlapBest.step.id : null;
}

// ---------------------------------------------------------------------------
// Reduction: neutral event -> state mutation (§11)
// ---------------------------------------------------------------------------

function applyEvent(evt) {
  if (!evt || typeof evt !== "object") return;
  if (evt.v !== 1) return; // v1-format (or any non-v1) lines die quietly here
  const kind = evt.kind;
  if (typeof kind !== "string") return;
  const sessionId = evt.sessionId;
  if (!sessionId) return;
  const t = typeof evt.t === "string" ? evt.t : new Date().toISOString();
  const nowMs = Date.parse(t) || Date.now();

  const session = getOrCreateSession(sessionId, t, evt.cwd);
  // Every event touches session freshness -- except agent.usage (§19.2):
  // token bookkeeping must never mask a stall.
  if (kind !== "agent.usage") session.lastActivityAt = t;

  switch (kind) {
    case "session.start": {
      session.cwd = evt.cwd ?? session.cwd;
      session.turnActive = false;
      session.ended = false;
      session.transcriptPath = evt.transcriptPath ?? session.transcriptPath;
      // §22: re-scan project-level agent discovery on every session.start
      // (rare event -- that's the entire re-scan cadence, no watchers).
      if (typeof session.cwd === "string" && session.cwd) {
        discoveredProjectAgents.set(sessionId, scanAgentDir(path.join(session.cwd, ".claude", "agents")));
      }
      broadcast({ type: "session", session });
      break;
    }

    case "session.end": {
      session.ended = true;
      session.turnActive = false;
      broadcast({ type: "session", session });
      break;
    }

    case "turn.start": {
      session.turnActive = true;
      broadcast({ type: "session", session });
      break;
    }

    case "turn.end": {
      session.turnActive = false;
      session.currentActivity = null; // §25: delegation/turn-end clears the readout
      broadcast({ type: "session", session });
      break;
    }

    // §25: pre-plan orchestrator activity -- a main-loop tool call with no
    // agent involved. Bumps session freshness (handled above, generically)
    // but must NEVER touch any agent's lastActivityAt -- agent stall
    // detection stays agent-local.
    case "session.activity": {
      const activity = { tool: evt.tool, t };
      if (evt.hint !== undefined) activity.hint = evt.hint;
      if (evt.file !== undefined) activity.file = evt.file;
      session.currentActivity = activity;

      const entry = { t, tool: evt.tool };
      if (evt.hint !== undefined) entry.hint = evt.hint;
      if (evt.file !== undefined) entry.file = evt.file;
      pushSessionLogEntry(sessionId, entry);

      // §26: derive a capability tag from this activity's tool.
      addCapabilityTag(session, deriveCapability(evt.tool, evt.hint));

      broadcast({ type: "session", session });
      broadcast({ type: "session-activity", sessionId, entry }); // §31.3
      break;
    }

    case "agent.spawn-pending": {
      const agentId = evt.agentId;
      if (agentId) {
        // Exact claim.
        const description = evt.description ?? "";
        const existing = agents.get(agentId);
        if (existing) {
          if (evt.description !== undefined) existing.description = evt.description;
          if (evt.model !== undefined) existing.model = prettifyModel(evt.model);
          // §24: an exact spawn-pending's parentAgentId is authoritative --
          // it overwrites a fuzzy-set parentId, and still applies even if
          // this agent already ended (post-mortem link).
          if (evt.parentAgentId !== undefined) {
            existing.parentId = sanitizeParentId(evt.parentAgentId, agentId);
          }
          existing.stepId = matchPlanStep(sessionId, existing.description);
          broadcast({ type: "agent", agent: existing });
        } else {
          exactPending.set(agentId, {
            description,
            model: evt.model,
            agentType: evt.agentType,
            parentAgentId: evt.parentAgentId,
            t,
            sessionId,
          });
        }
        removeMatchingPendingSpawn(sessionId, description);
      } else {
        // Legacy fuzzy-claim entry — v1 behavior.
        pushPendingSpawn(sessionId, {
          agentType: evt.agentType ?? "claude",
          description: evt.description ?? "",
          parentAgentId: evt.parentAgentId,
          t,
        });

        // §31.1: a main-loop fuzzy spawn-pending with neither agentId nor
        // parentAgentId is the moment of delegation -- synthesize a
        // "delegate" activity so the orchestrator's card keeps narrating
        // through spawns (supersedes §25's clear). Spawn-pendings carrying
        // parentAgentId are a subagent's own delegation, not orchestrator
        // work -- leave currentActivity untouched.
        if (!evt.agentId && !evt.parentAgentId) {
          const hint = clip(evt.description ?? evt.agentType ?? "", 120);
          const activity = { tool: "delegate", hint, t };
          session.currentActivity = activity;

          const entry = { t, tool: "delegate", hint };
          pushSessionLogEntry(sessionId, entry);
          broadcast({ type: "session-activity", sessionId, entry }); // §31.3
        }
      }

      broadcast({ type: "session", session });
      break;
    }

    case "agent.start": {
      let agentId = evt.agentId;
      const agentType = evt.agentType;

      if (agentId == null) {
        if (agentType === "codex-direct") {
          const counter = (codexCounters.get(sessionId) ?? 0) + 1;
          codexCounters.set(sessionId, counter);
          agentId = `codex:${sessionId}:${counter}`;
        } else {
          break; // no synthesis rule for other null-id agent types
        }
      }

      const exact = exactPending.get(agentId);
      if (exact) exactPending.delete(agentId);

      let description;
      let claimedFuzzy = null;
      if (evt.description !== undefined) {
        description = evt.description;
      } else if (exact && exact.description !== undefined) {
        description = exact.description;
      } else {
        claimedFuzzy = claimPendingSpawn(sessionId, agentType, nowMs);
        description = claimedFuzzy ? claimedFuzzy.description : "";
      }

      let rawModel = evt.model;
      if (rawModel === undefined && exact) rawModel = exact.model;

      // §24 lineage: agent.start's own parentAgentId wins (declared but
      // unused by today's adapters), else the exact spawn-pending's, else
      // the fuzzy pending entry's (transferred at claim time). Self-
      // reference is sanitized once below, against this agent's own id.
      let parentAgentId;
      if (evt.parentAgentId !== undefined) {
        parentAgentId = evt.parentAgentId;
      } else if (exact && exact.parentAgentId !== undefined) {
        parentAgentId = exact.parentAgentId;
      } else if (claimedFuzzy && claimedFuzzy.parentAgentId !== undefined) {
        parentAgentId = claimedFuzzy.parentAgentId;
      }

      const meta = resolveAgentMeta(agentType, rawModel, sessionId);

      let agent = agents.get(agentId);
      if (!agent) {
        agent = {
          id: agentId,
          sessionId,
          agentType,
          label: meta.label,
          provider: meta.provider,
          model: meta.model,
          description: description ?? "",
          currentActivity: null,
          status: "running",
          startedAt: t,
          endedAt: null,
          lastActivityAt: t,
          lastErrorAt: null,
          files: [],
          stepId: null,
          finalMessage: null,
          narrative: null,
          narrativeAt: null,
          transcriptPath: evt.transcriptPath ?? null, // §28b
          tokens: null,
          costUsd: null,
          parentId: sanitizeParentId(parentAgentId, agentId), // §24
          capabilities: [], // §26
        };
      } else {
        agent.agentType = agentType;
        agent.label = meta.label;
        agent.provider = meta.provider;
        agent.model = meta.model;
        agent.description = description ?? agent.description;
        agent.status = "running";
        agent.lastActivityAt = t;
        if (evt.transcriptPath !== undefined) agent.transcriptPath = evt.transcriptPath; // §28b
        if (parentAgentId !== undefined) agent.parentId = sanitizeParentId(parentAgentId, agentId); // §24
      }

      agent.stepId = matchPlanStep(sessionId, agent.description);
      upsertAgent(agent);
      break;
    }

    case "agent.activity": {
      let agentId = evt.agentId;
      if (agentId == null) {
        // Null-id activity belongs to the codex-direct call currently open
        // in this session (mirrors agent.end's null-id pairing, §11).
        const resolved = findOldestRunningCodexDirect(sessionId);
        if (!resolved) break;
        agentId = resolved.id;
      }
      const agent = agents.get(agentId);
      if (!agent) break; // start should always precede activity; ignore orphans

      const phase = evt.phase;
      const tool = evt.tool;
      const callId = evt.callId;

      // §26: derive a capability tag from this activity's tool, regardless
      // of phase (tool is present on both start and end).
      addCapabilityTag(agent, deriveCapability(tool, evt.hint));

      let calls = openCalls.get(agentId);
      if (!calls) {
        calls = new Map();
        openCalls.set(agentId, calls);
      }

      if (phase === "start") {
        agent.lastActivityAt = t;
        const hint = evt.hint || "";
        agent.currentActivity = clip(`${tool}: ${hint}`, 60);
        if (evt.file) agent.files = addFile(agent.files, evt.file);

        const entry = { t, tool };
        if (evt.hint !== undefined) entry.hint = evt.hint;
        if (evt.file !== undefined) entry.file = evt.file;
        if (evt.error) entry.error = true;
        pushLogEntry(agentId, entry);

        // Error inference: any OTHER call for this agent still open and
        // older than 2500ms is now known to have failed (Claude Code agents
        // are sequential; parallel-batch PreToolUse lines land well inside
        // 2.5s).
        for (const [oid, open] of calls) {
          const age = nowMs - (Date.parse(open.t) || nowMs);
          if (age > ERROR_INFERENCE_MS) {
            if (open.entry) open.entry.error = true;
            agent.lastErrorAt = t;
            calls.delete(oid);
            broadcast({ type: "agent", agent });
            if (open.entry) broadcast({ type: "activity", agentId, entry: open.entry });
          }
        }

        // Explicit error:true on the event itself — same marking, hint from event.
        if (evt.error) {
          agent.lastErrorAt = t;
        }

        if (callId != null) {
          calls.set(callId, { t, tool, hint: evt.hint, entry });
        }

        broadcast({ type: "agent", agent });
        broadcast({ type: "activity", agentId, entry });
      } else if (phase === "end") {
        // Closes the open call (removes it from error-inference tracking)
        // and records its own LogEntry — kept separate from the phase:start
        // entry so the ring/drawer reads as a call-opened/call-closed
        // journal rather than one line silently mutating in place.
        if (callId != null && calls.has(callId)) {
          calls.delete(callId);
        }
        agent.lastActivityAt = t;

        const entry = { t, tool };
        if (evt.ms !== undefined) entry.ms = evt.ms;
        if (evt.error) entry.error = true;
        pushLogEntry(agentId, entry);
        if (evt.error) agent.lastErrorAt = t;

        broadcast({ type: "agent", agent });
        broadcast({ type: "activity", agentId, entry });
      }
      break;
    }

    case "agent.end": {
      let agent = null;
      if (evt.agentId != null) {
        agent = agents.get(evt.agentId);
      } else if (evt.agentType === "codex-direct") {
        agent = findOldestRunningCodexDirect(sessionId);
      }
      if (!agent) break;

      agent.status = "done";
      agent.endedAt = t;
      agent.currentActivity = null;
      if (evt.finalMessage !== undefined) agent.finalMessage = evt.finalMessage;
      if (evt.transcriptPath !== undefined) agent.transcriptPath = evt.transcriptPath;

      // Any still-open calls are unresolved -> mark errored (no lastErrorAt
      // bump — the card is done; the drawer shows the red line).
      const calls = openCalls.get(agent.id);
      if (calls && calls.size > 0) {
        for (const [, open] of calls) {
          if (open.entry) open.entry.error = true;
        }
        calls.clear();
      }

      broadcast({ type: "agent", agent });
      break;
    }

    // Token/cost enrichment (§19.2). agentId: null applies to the Session,
    // else to that AgentRun (upsert semantics). Unknown agentId -> skip
    // silently (the run may already have been pruned). Deliberately does
    // NOT touch lastActivityAt at either level -- see the conditional bump
    // above; token bookkeeping must never mask a stall.
    case "agent.usage": {
      const tokens = evt.tokens ?? null;
      const costUsd = evt.costUsd !== undefined ? evt.costUsd : null;

      if (evt.agentId == null) {
        session.tokens = tokens;
        session.costUsd = costUsd;
        // §31.2: optional model, only-present-fields -- never clears a
        // known model.
        if (evt.model !== undefined) session.model = prettifyModel(resolveModelAlias(evt.model));
        broadcast({ type: "session", session });
      } else {
        const agent = agents.get(evt.agentId);
        if (!agent) break; // unknown agent -- skip silently
        agent.tokens = tokens;
        agent.costUsd = costUsd;
        if (evt.model !== undefined) agent.model = prettifyModel(resolveModelAlias(evt.model));
        broadcast({ type: "agent", agent });
      }
      break;
    }

    case "plan.step": {
      const stepId = evt.stepId;
      if (stepId == null) break;
      const plan = getOrCreatePlan(sessionId, t);
      let step = plan.steps.find((s) => s.id === stepId);

      if (evt.deleted) {
        if (step) plan.steps = plan.steps.filter((s) => s.id !== stepId);
      } else {
        if (!step) {
          step = { id: stepId, subject: "", status: "pending", updatedAt: t };
          plan.steps.push(step);
        }
        if (evt.subject !== undefined) step.subject = evt.subject;
        if (evt.status !== undefined) step.status = evt.status;
        step.updatedAt = t;
      }
      plan.updatedAt = t;

      // Re-run matchPlanStep for running agents that still have no stepId.
      for (const agent of agents.values()) {
        if (agent.sessionId === sessionId && agent.status === "running" && agent.stepId == null) {
          const matched = matchPlanStep(sessionId, agent.description);
          if (matched != null) {
            agent.stepId = matched;
            broadcast({ type: "agent", agent });
          }
        }
      }

      broadcast({ type: "plan", plan });
      break;
    }

    case "plan.doc": {
      const plan = getOrCreatePlan(sessionId, t);
      plan.doc = evt.markdown;
      plan.updatedAt = t;
      broadcast({ type: "plan", plan });
      break;
    }

    default:
      return; // unknown kind — silently skip
  }

  pruneOldRecords(nowMs);
}

function pruneOldRecords(nowMs) {
  for (const [id, agent] of agents) {
    if (agent.endedAt) {
      const age = nowMs - (Date.parse(agent.endedAt) || nowMs);
      if (Number.isFinite(age) && age > AGENT_MAX_AGE_MS) {
        agents.delete(id);
        agentLogs.delete(id);
        openCalls.delete(id);
        exactPending.delete(id);
        if (enricher) enricher.forget(enrichmentKey("agent", id));
      }
    }
  }
  for (const [id, session] of sessions) {
    const age = nowMs - (Date.parse(session.lastActivityAt) || nowMs);
    if (Number.isFinite(age) && age > SESSION_MAX_AGE_MS) {
      sessions.delete(id);
      if (enricher) enricher.forget(enrichmentKey("session", id));
      for (const [agentId, agent] of agents) {
        if (agent.sessionId === id) {
          agents.delete(agentId);
          agentLogs.delete(agentId);
          openCalls.delete(agentId);
          exactPending.delete(agentId);
          if (enricher) enricher.forget(enrichmentKey("agent", agentId));
        }
      }
      for (const [pendingId, pending] of exactPending) {
        if (pending.sessionId === id) exactPending.delete(pendingId);
      }
      pendingSpawns.delete(id);
      codexCounters.delete(id);
      plans.delete(id);
      sessionLogs.delete(id); // §25
    }
  }
}

// ---------------------------------------------------------------------------
// Narrator integration (server/narrator.mjs, §14). Guarded behind
// config.narration.enabled; zero behavior change while disabled (module is
// still imported, but createNarrator() is never called and no interval is
// armed).
// ---------------------------------------------------------------------------

import { createNarrator } from "./narrator.mjs";
let narrator = null;
if (config.narration && config.narration.enabled) {
  narrator = createNarrator({
    config,
    getRunningAgents: () => Array.from(agents.values()).filter((a) => a.status === "running"),
    getNewLogEntries: (agentId, sinceT) =>
      (agentLogs.get(agentId) || []).filter((e) => !sinceT || e.t > sinceT),
    onNarrative: (agentId, text) => {
      const agent = agents.get(agentId);
      if (!agent) return;
      agent.narrative = text;
      agent.narrativeAt = new Date().toISOString();
      broadcast({ type: "agent", agent });
    },
  });
}
if (narrator) {
  setInterval(() => narrator.tick(), 5000);
}

// ---------------------------------------------------------------------------
// Enricher integration (server/enrich.mjs, §19.3). Guarded behind
// config.enrichment.enabled; zero behavior change while disabled. Reads
// transcript files directly and writes token/cost state back via onUsage —
// never appends to the events file, never bumps lastActivityAt.
// ---------------------------------------------------------------------------

import { createEnricher } from "./enrich.mjs";

// Shared key format between getTargets/onUsage/forget below -- distinct
// prefixes so a session key can never collide with an agent id (codex-direct
// agent ids already contain ":", so a bare id would not be safely parseable).
function enrichmentKey(scope, id) {
  return `${scope}:${id}`;
}

// dirname(session.transcriptPath)/<sessionId>/subagents/agent-<agentId>.jsonl
// -- convention verified on disk 2026-07-17.
function deriveAgentTranscriptPath(session, agentId) {
  if (!session || !session.transcriptPath) return null;
  return path.join(
    path.dirname(session.transcriptPath),
    session.id,
    "subagents",
    `agent-${agentId}.jsonl`
  );
}

const AGENT_ENRICH_SWEEP_MS = 60 * 1000; // final sweep window after agent.end
const SESSION_ENRICH_ACTIVE_MS = 10 * 60 * 1000; // main transcript activity window

// Enumerates enrichment targets fresh each tick (§19.3): running agents plus
// agents that ended <60s ago (final sweep), each with a resolvable transcript
// path gated on existsSync (which naturally excludes demo/codex agents that
// never wrote a real transcript); sessions with a transcriptPath active <10min
// ago (main transcript -> session/hub tokens).
function getEnrichmentTargets() {
  const nowMs = Date.now();
  const targets = [];

  for (const agent of agents.values()) {
    const recentlyEnded =
      agent.status === "done" &&
      agent.endedAt &&
      nowMs - (Date.parse(agent.endedAt) || nowMs) < AGENT_ENRICH_SWEEP_MS;
    if (agent.status !== "running" && !recentlyEnded) continue;

    const filePath =
      agent.transcriptPath || deriveAgentTranscriptPath(sessions.get(agent.sessionId), agent.id);
    if (!filePath || !existsSync(filePath)) continue;

    targets.push({ key: enrichmentKey("agent", agent.id), path: filePath });
  }

  for (const session of sessions.values()) {
    if (!session.transcriptPath) continue;
    const age = nowMs - (Date.parse(session.lastActivityAt) || nowMs);
    if (!Number.isFinite(age) || age >= SESSION_ENRICH_ACTIVE_MS) continue;
    if (!existsSync(session.transcriptPath)) continue;

    targets.push({ key: enrichmentKey("session", session.id), path: session.transcriptPath });
  }

  return targets;
}

// Sets fields + broadcasts -- deliberately never touches lastActivityAt
// (§19.2's no-bump rule applies identically to the enricher's writes).
// §31.2: 4th arg `model` (raw id, most-recent qualifying line) -- the
// SESSION branch prettifies + sets it when non-null, never clearing a known
// model. The AGENT branch ignores it: agent models come from spawn payloads
// / discovery meta (§22 resolveAgentMeta) and the enricher must not fight
// that resolution.
function onEnrichmentUsage(key, tokens, costUsd, model) {
  const sep = key.indexOf(":");
  if (sep === -1) return;
  const scope = key.slice(0, sep);
  const id = key.slice(sep + 1);

  if (scope === "session") {
    const session = sessions.get(id);
    if (!session) return;
    session.tokens = tokens;
    session.costUsd = costUsd;
    if (model != null) session.model = prettifyModel(resolveModelAlias(model));
    broadcast({ type: "session", session });
  } else if (scope === "agent") {
    const agent = agents.get(id);
    if (!agent) return;
    agent.tokens = tokens;
    agent.costUsd = costUsd;
    broadcast({ type: "agent", agent });
  }
}

// §32.4: the session's own name, read out of the transcript we already tail.
// Session-scoped only -- agent transcripts carry no custom-title, and agent
// naming stays with spawn payloads / §22 discovery meta for the same reason
// the model does. Like usage, this never touches lastActivityAt.
function onEnrichmentTitle(key, title) {
  if (!key.startsWith("session:")) return;
  const session = sessions.get(key.slice("session:".length));
  if (!session || session.title === title) return;
  session.title = title;
  broadcast({ type: "session", session });
}

let enricher = null;
if (config.enrichment && config.enrichment.enabled) {
  enricher = createEnricher({
    config,
    getTargets: getEnrichmentTargets,
    onUsage: onEnrichmentUsage,
    onTitle: onEnrichmentTitle,
  });
}
if (enricher) {
  const intervalMs = (config.enrichment && config.enrichment.intervalMs) || 5000;
  setInterval(() => enricher.tick(), intervalMs);
}

// ---------------------------------------------------------------------------
// SSE broadcast
// ---------------------------------------------------------------------------

function broadcast(change) {
  if (subscribers.size === 0) return;
  const data = `event: fleet\ndata: ${JSON.stringify(change)}\n\n`;
  for (const res of subscribers) {
    res.write(data);
  }
}

function sendSnapshot(res) {
  const snapshot = {
    sessions: Array.from(sessions.values()),
    agents: Array.from(agents.values()),
    plans: Array.from(plans.values()),
    config: {
      hubTitle: (config.hub && config.hub.title) || "Orchestrator",
      stallThresholdMs: config.stallThresholdMs,
    },
  };
  res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
}

// ---------------------------------------------------------------------------
// Events file tailing
// ---------------------------------------------------------------------------

let tailOffset = 0;
let tailing = false;

async function tailOnce() {
  if (tailing) return;
  tailing = true;
  try {
    if (!existsSync(EVENTS_FILE)) {
      if (tailOffset !== 0) {
        // File disappeared — reset and wait for it to come back.
        resetState();
        tailOffset = 0;
      }
      return;
    }

    const stat = statSync(EVENTS_FILE);
    if (stat.size < tailOffset) {
      // Truncated or rotated — rebuild from scratch.
      resetState();
      tailOffset = 0;
    }

    if (stat.size === tailOffset) return;

    const fh = await fsOpen(EVENTS_FILE, "r");
    try {
      const length = stat.size - tailOffset;
      const buf = Buffer.alloc(length);
      await fh.read(buf, 0, length, tailOffset);

      // Only consume up through the last newline — a poll could in theory
      // land between two separate appends, leaving a not-yet-flushed partial
      // line at the tail. Buffer it for the next tick rather than risk
      // treating a truncated line as garbage and losing it.
      const lastNewline = buf.lastIndexOf(0x0a);
      if (lastNewline === -1) {
        return; // no complete line yet
      }

      const complete = buf.subarray(0, lastNewline + 1).toString("utf8");
      tailOffset += lastNewline + 1;

      for (const line of complete.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let evt;
        try {
          evt = JSON.parse(trimmed);
        } catch {
          continue; // skip unparseable lines
        }
        applyEvent(evt);
      }
    } finally {
      await fh.close();
    }
  } catch {
    // Tolerate transient read errors (e.g. file mid-write); retry next tick.
  } finally {
    tailing = false;
  }
}

async function rebuildFromScratch() {
  resetState();
  tailOffset = 0;
  await tailOnce();
}

function startTailing() {
  // Initial full read.
  rebuildFromScratch();

  // Poll fallback — always runs regardless of fs.watch support.
  setInterval(() => {
    tailOnce();
  }, POLL_INTERVAL_MS);

  // fs.watch on the containing directory for lower-latency updates.
  const dir = path.dirname(EVENTS_FILE);
  try {
    if (!existsSync(dir)) {
      // Directory may not exist yet; poll fallback will pick it up once the
      // events file (and its dir) is created.
      return;
    }
    const watcher = fsWatch(dir, (_eventType, filename) => {
      if (!filename || filename === path.basename(EVENTS_FILE)) {
        tailOnce();
      }
    });
    watcher.on("error", () => {
      // Ignore — poll fallback keeps working.
    });
  } catch {
    // Ignore — poll fallback keeps working.
  }
}

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
};

function serveStatic(req, res, urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const relPath = decoded === "/" || decoded === "/index.html" ? "index.html" : decoded.replace(/^\/+/, "");
  const resolved = path.resolve(PUBLIC_DIR, relPath);

  // No directory traversal: resolved path must stay under PUBLIC_DIR.
  if (resolved !== PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }

  if (!existsSync(resolved) || statSync(resolved).isDirectory()) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }

  const ext = path.extname(resolved);
  const contentType = CONTENT_TYPES[ext] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": contentType });
  createReadStream(resolved).pipe(res);
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const AGENT_LOG_RE = /^\/agents\/([^/]+)\/log$/;
const SESSION_LOG_RE = /^\/sessions\/([^/]+)\/log$/;

const server = http.createServer((req, res) => {
  const urlPath = req.url || "/";
  const pathname = urlPath.split("?")[0];

  if (pathname === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({ ok: true, sessions: sessions.size, agents: agents.size })
    );
    return;
  }

  if (urlPath === "/events" || urlPath.startsWith("/events?")) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    sendSnapshot(res);
    subscribers.add(res);

    const pingInterval = setInterval(() => {
      res.write(": ping\n\n");
    }, PING_INTERVAL_MS);

    req.on("close", () => {
      clearInterval(pingInterval);
      subscribers.delete(res);
    });
    return;
  }

  const logMatch = pathname.match(AGENT_LOG_RE);
  if (logMatch) {
    const agentId = decodeURIComponent(logMatch[1]);
    const entries = agentLogs.get(agentId) || [];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ agentId, entries }));
    return;
  }

  const sessionLogMatch = pathname.match(SESSION_LOG_RE);
  if (sessionLogMatch) {
    const sessionId = decodeURIComponent(sessionLogMatch[1]);
    const entries = sessionLogs.get(sessionId) || [];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ sessionId, entries }));
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    serveStatic(req, res, urlPath);
    return;
  }

  res.writeHead(405, { "Content-Type": "text/plain" });
  res.end("Method not allowed");
});

server.listen(PORT, () => {
  startTailing();
});
