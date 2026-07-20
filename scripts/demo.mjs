#!/usr/bin/env node
// FleetView v2 demo: appends NEUTRAL v2 events (schema §8) directly to the
// events file, telling a scripted ~60s orchestration story under session id
// demo-<pid>. Unlike a real hook, this writes finished neutral events itself
// (no adapter involved) — but every line still carries the exact envelope
// {v:1, source:"demo", t, kind, sessionId} the adapters would produce, so it
// exercises the real v2 reducer end to end.
//
// Usage: node scripts/demo.mjs [--fast]

import { mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";

const FAST = process.argv.includes("--fast");
const SESSION_ID = `demo-${process.pid}`;
const CWD = "/Users/simon/lumenADE";

const EVENTS_FILE =
  process.env.FLEET_EVENTS_FILE || `${homedir()}/.agenticade/events.jsonl`;

mkdirSync(dirname(EVENTS_FILE), { recursive: true });

function sleep(ms) {
  if (FAST) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let callSeq = 0;
function nextCallId(agentId) {
  callSeq += 1;
  return `${agentId}-call-${callSeq}`;
}

// Appends one neutral v2 event and prints a one-line progress summary.
// `tOverride` (ISO string) lets the stalled-agent beat backdate events —
// the server trusts evt.t, so this is how we fake a 3-minute-old agent.
// That trust is load-bearing for the demo; don't "fix" it into using
// wall-clock time for those two events.
function emit(kind, extra = {}, tOverride) {
  const t = tOverride ?? new Date().toISOString();
  const evt = { v: 1, source: "demo", t, kind, sessionId: SESSION_ID, ...extra };
  appendFileSync(EVENTS_FILE, JSON.stringify(evt) + "\n");
  console.log(`[demo] ${describe(evt)}`);
}

function describe(evt) {
  switch (evt.kind) {
    case "agent.spawn-pending":
      return `spawn-pending ${evt.agentType}${evt.agentId ? " -> " + evt.agentId : ""}`;
    case "agent.start":
      return `agent.start ${evt.agentId ?? "(null)"} [${evt.agentType}]`;
    case "agent.activity":
      return `activity ${evt.agentId ?? "(null)"} ${evt.phase} ${evt.tool}${
        evt.file ? " " + evt.file : ""
      }${evt.error ? " ERROR" : ""}`;
    case "agent.end":
      return `agent.end ${evt.agentId ?? "(null)"} [${evt.agentType ?? ""}]`;
    case "agent.usage":
      return `usage ${evt.agentId ?? "(session)"} in=${evt.tokens.in} out=${evt.tokens.out}${
        evt.costUsd != null ? ` est.$${evt.costUsd.toFixed(4)}` : ""
      }`;
    case "plan.step":
      return `plan.step ${evt.stepId}${evt.status ? " -> " + evt.status : ""}`;
    case "plan.doc":
      return "plan.doc";
    case "session.activity":
      return `session.activity ${evt.tool}${evt.hint ? " " + evt.hint : ""}`;
    default:
      return evt.kind;
  }
}

async function main() {
  // ---- 1. session opens, plan drops in ----------------------------------
  emit("session.start", { cwd: CWD });
  await sleep(700);
  emit("turn.start");
  await sleep(1000);

  // ---- 1a. pre-plan session activity (§25) — hub shows real work instead
  // of dead air while the orchestrator reads before committing to a plan;
  // the first agent.spawn-pending beat below clears it (reducer behavior —
  // we just emit the reads).
  emit("session.activity", { tool: "Read", hint: "README.md", file: "README.md" });
  await sleep(450);
  emit("session.activity", { tool: "Grep", hint: "grep -rn FLEETVIEW-SPEC docs/" });
  await sleep(500);
  emit("session.activity", { tool: "Bash", hint: "git log --oneline -5" });
  await sleep(600);
  // capability chip (§26) — session-level Skill call so the hub's own chip
  // row (not just an agent card's) has something to render (§31.4)
  emit("session.activity", { tool: "Skill", hint: "code-review" });
  await sleep(500);

  emit("plan.doc", {
    markdown:
      "## FleetView v2 rollout\n\n" +
      "- Build SSE fleet server\n" +
      "- Build fleet canvas UI\n" +
      "- Wire event adapters\n" +
      "- Ship v2 demo storyline\n",
  });
  await sleep(500);

  const STEPS = [
    { stepId: "plan-1", subject: "Build SSE fleet server" },
    { stepId: "plan-2", subject: "Build fleet canvas UI" },
    { stepId: "plan-3", subject: "Wire event adapters" },
    { stepId: "plan-4", subject: "Ship v2 demo storyline" },
  ];
  for (const step of STEPS) {
    emit("plan.step", { stepId: step.stepId, subject: step.subject, status: "pending" });
    await sleep(250);
  }
  await sleep(1200);

  // ---- 2. builder spawns via the exact-claim path -----------------------
  emit("plan.step", { stepId: "plan-1", status: "active" });
  await sleep(1300);

  emit("agent.spawn-pending", { agentType: "builder", description: "Build SSE fleet server" });
  await sleep(500);
  emit("agent.spawn-pending", {
    agentType: "builder",
    description: "Build SSE fleet server",
    agentId: "demo-b1",
    model: "claude-sonnet-5",
  });
  await sleep(900);
  emit("agent.start", { agentId: "demo-b1", agentType: "builder" });
  await sleep(1500);

  // pair 1 — writes the server, carries file:
  let cid = nextCallId("demo-b1");
  emit("agent.activity", {
    agentId: "demo-b1",
    phase: "start",
    callId: cid,
    tool: "Write",
    hint: "Write server/server.mjs",
    file: "server/server.mjs",
  });
  await sleep(4000);
  emit("agent.activity", { agentId: "demo-b1", phase: "end", callId: cid, tool: "Write", ms: 4000 });
  await sleep(600);

  // usage beat 1 — early, small numbers
  emit("agent.usage", {
    agentId: "demo-b1",
    tokens: { in: 2000, out: 10000, cacheRead: 150000, cacheWrite: 8000 },
    costUsd: 0.231,
  });
  await sleep(400);

  // pair 2 — sanity check
  cid = nextCallId("demo-b1");
  emit("agent.activity", {
    agentId: "demo-b1",
    phase: "start",
    callId: cid,
    tool: "Bash",
    hint: "node --check server/server.mjs",
  });
  await sleep(2500);
  emit("agent.activity", { agentId: "demo-b1", phase: "end", callId: cid, tool: "Bash", ms: 2500 });
  await sleep(600);

  // pair 3 — touches the UI file too (sets up the collision with demo-c1)
  cid = nextCallId("demo-b1");
  emit("agent.activity", {
    agentId: "demo-b1",
    phase: "start",
    callId: cid,
    tool: "Edit",
    hint: "Edit public/index.html — wire SSE client",
    file: "public/index.html",
  });
  await sleep(3200);
  emit("agent.activity", { agentId: "demo-b1", phase: "end", callId: cid, tool: "Edit", ms: 3200 });
  await sleep(600);

  // usage beat 2 — rising
  emit("agent.usage", {
    agentId: "demo-b1",
    tokens: { in: 2800, out: 35000, cacheRead: 300000, cacheWrite: 13000 },
    costUsd: 0.6722,
  });
  await sleep(400);

  // ---- 2b. demo-b1 spawns a nested sub-agent (§24) -----------------------
  // Pre-side link: fuzzy spawn-pending carries parentAgentId while the
  // child runs (no child id exists yet — mirrors the parent's PreToolUse
  // firing immediately before the child's SubagentStart). The exact link
  // (Post-side) only arrives after the child's SubagentStop in the live S3
  // probe, so it's emitted below after demo-n1's agent.end, not before.
  emit("agent.spawn-pending", {
    agentType: "Explore",
    description: "Find reusable event-schema helpers for the SSE endpoint",
    parentAgentId: "demo-b1",
  });
  await sleep(500);
  emit("agent.start", { agentId: "demo-n1", agentType: "Explore" });
  await sleep(900);

  // activity 1 — local search
  cid = nextCallId("demo-n1");
  emit("agent.activity", {
    agentId: "demo-n1",
    phase: "start",
    callId: cid,
    tool: "Grep",
    hint: "grep -rn schema server/",
  });
  await sleep(1100);
  emit("agent.activity", { agentId: "demo-n1", phase: "end", callId: cid, tool: "Grep", ms: 1100 });
  await sleep(400);

  // activity 2 — capability chip (§26): MCP tool call renders "mcp:github"
  cid = nextCallId("demo-n1");
  emit("agent.activity", {
    agentId: "demo-n1",
    phase: "start",
    callId: cid,
    tool: "mcp__github__search_code",
    hint: 'search_code "agent.spawn-pending schema"',
  });
  await sleep(1300);
  emit("agent.activity", {
    agentId: "demo-n1",
    phase: "end",
    callId: cid,
    tool: "mcp__github__search_code",
    ms: 1300,
  });
  await sleep(500);

  emit("agent.end", {
    agentId: "demo-n1",
    agentType: "Explore",
    finalMessage: "No reusable schema helper found upstream — building fresh in server/server.mjs is right.",
  });
  await sleep(400);

  // exact post-link (§9 PostToolUse path) — arrives after the child ended,
  // same ordering the live S3 probe captured for synchronous nested spawns;
  // an exact claim overwrites the fuzzy-set parentId (authoritative repair).
  emit("agent.spawn-pending", {
    agentId: "demo-n1",
    parentAgentId: "demo-b1",
    agentType: "Explore",
    description: "Find reusable event-schema helpers for the SSE endpoint",
    model: "claude-haiku-4-5",
  });
  await sleep(600);

  // persistence beat (§31.5) — orchestrator keeps working while the fleet
  // story continues; activity persists through spawns per §13/§31.4
  emit("session.activity", { tool: "Read", hint: "server/server.mjs" });
  await sleep(500);

  // ---- 3. codex lane spawns via the fuzzy-claim path (in parallel) ------
  emit("agent.spawn-pending", { agentType: "codex-runner", description: "Build fleet canvas UI" });
  await sleep(500);
  emit("agent.start", { agentId: "demo-c1", agentType: "codex-runner" });
  await sleep(1500);

  // touches public/index.html while demo-b1 is still running it too — collision
  cid = nextCallId("demo-c1");
  emit("agent.activity", {
    agentId: "demo-c1",
    phase: "start",
    callId: cid,
    tool: "Bash",
    hint: "codex exec --full-auto 'build public/index.html'",
    file: "public/index.html",
  });
  await sleep(4600);
  emit("agent.activity", { agentId: "demo-c1", phase: "end", callId: cid, tool: "Bash", ms: 4600 });
  await sleep(700);

  // pair 4 (builder) — an explicit failure...
  cid = nextCallId("demo-b1");
  emit("agent.activity", {
    agentId: "demo-b1",
    phase: "start",
    callId: cid,
    tool: "Bash",
    hint: "curl -sf localhost:4747/events",
  });
  await sleep(1600);
  emit("agent.activity", {
    agentId: "demo-b1",
    phase: "end",
    callId: cid,
    tool: "Bash",
    ms: 1600,
    error: true,
  });
  await sleep(700);

  // ...and pair 5 — the recovery.
  cid = nextCallId("demo-b1");
  emit("agent.activity", {
    agentId: "demo-b1",
    phase: "start",
    callId: cid,
    tool: "Bash",
    hint: "curl -sf localhost:4747/events (retry)",
  });
  await sleep(1400);
  emit("agent.activity", { agentId: "demo-b1", phase: "end", callId: cid, tool: "Bash", ms: 1400 });
  await sleep(900);

  // usage beat 3 — rising further, past the recovery
  emit("agent.usage", {
    agentId: "demo-b1",
    tokens: { in: 3400, out: 65000, cacheRead: 450000, cacheWrite: 17000 },
    costUsd: 1.184,
  });
  await sleep(400);

  // capability chip (§26) — Skill call renders a "skill:code-review" chip
  cid = nextCallId("demo-b1");
  emit("agent.activity", {
    agentId: "demo-b1",
    phase: "start",
    callId: cid,
    tool: "Skill",
    hint: "code-review",
  });
  await sleep(1300);
  emit("agent.activity", { agentId: "demo-b1", phase: "end", callId: cid, tool: "Skill", ms: 1300 });
  await sleep(500);

  // second codex activity
  cid = nextCallId("demo-c1");
  emit("agent.activity", {
    agentId: "demo-c1",
    phase: "start",
    callId: cid,
    tool: "Bash",
    hint: "codex exec --full-auto 'wire SSE client'",
  });
  await sleep(3800);
  emit("agent.activity", { agentId: "demo-c1", phase: "end", callId: cid, tool: "Bash", ms: 3800 });
  await sleep(800);

  // demo-c1's one usage beat — OpenAI Codex has no entry in the Anthropic
  // pricing table, so a real enricher would report tokens with a null cost;
  // mirror that here rather than fabricating a rate.
  emit("agent.usage", {
    agentId: "demo-c1",
    tokens: { in: 1500, out: 4200, cacheRead: 0, cacheWrite: 0 },
    costUsd: null,
  });
  await sleep(400);

  // ---- 4. a stalled agent, backdated so it renders stalled immediately --
  const stallBase = Date.now();
  emit(
    "agent.start",
    { agentId: "demo-s1", agentType: "claude" },
    new Date(stallBase - 180_000).toISOString()
  );
  await sleep(400);
  emit(
    "agent.activity",
    {
      agentId: "demo-s1",
      phase: "start",
      callId: nextCallId("demo-s1"),
      tool: "Bash",
      hint: "grep -r stallThresholdMs server/",
    },
    new Date(stallBase - 150_000).toISOString()
  );
  await sleep(1400);

  // ---- 5. step 1 done, step 2 active; builder wraps up -------------------
  emit("plan.step", { stepId: "plan-1", status: "done" });
  await sleep(500);
  emit("plan.step", { stepId: "plan-2", status: "active" });
  await sleep(700);

  // usage beat 4 — final tally just before agent.end; in+out must clear 96k
  emit("agent.usage", {
    agentId: "demo-b1",
    tokens: { in: 4000, out: 93000, cacheRead: 600000, cacheWrite: 20000 },
    costUsd: 1.662,
  });
  await sleep(400);

  emit("agent.end", {
    agentId: "demo-b1",
    agentType: "builder",
    finalMessage: "Server boots clean; SSE snapshot and fleet events verified against spec.",
  });
  await sleep(1500);

  // persistence beat (§31.5) — orchestrator activity continues past a
  // subagent's end, keeping the hub alive between wrap-up and the next step
  emit("session.activity", { tool: "Grep", hint: "grep -rn agent.end server/reducer.mjs" });
  await sleep(500);

  // session-level usage beat (agentId: null) — main-loop transcript totals,
  // distinct from any single subagent's tally; carries `model` (§31.2b) so
  // the hub subtitle picks up "Claude Opus 4.8" mid-demo (§31.4)
  emit("agent.usage", {
    agentId: null,
    tokens: { in: 8000, out: 45000, cacheRead: 900000, cacheWrite: 30000 },
    costUsd: 1.0815,
    model: "claude-opus-4-8",
  });
  await sleep(500);

  // ---- 6. null-id codex-direct pair ---------------------------------------
  emit("agent.start", {
    agentId: null,
    agentType: "codex-direct",
    description: "Smoke test SSE endpoint",
  });
  await sleep(700);
  cid = nextCallId("codex-direct");
  emit("agent.activity", {
    agentId: null,
    phase: "start",
    callId: cid,
    tool: "Bash",
    hint: "codex exec --full-auto 'smoke test /events'",
  });
  await sleep(3000);
  emit("agent.activity", { agentId: null, phase: "end", callId: cid, tool: "Bash", ms: 3000 });
  await sleep(600);
  emit("agent.end", {
    agentId: null,
    agentType: "codex-direct",
    finalMessage: "Smoke test passed — SSE snapshot received.",
  });
  await sleep(1300);

  // capability chip (§26) — session-level mcp__* activity so the hub's own
  // chip row (not just an agent card's) has something to render (§31.4)
  emit("session.activity", { tool: "mcp__github__search_code", hint: 'search_code "SSE reconnect handling"' });
  await sleep(500);

  // ---- 7. wrap up: remaining agents and steps finish, turn ends ----------
  emit("plan.step", { stepId: "plan-2", status: "done" });
  await sleep(500);
  emit("plan.step", { stepId: "plan-3", status: "active" });
  await sleep(500);

  emit("agent.end", {
    agentId: "demo-c1",
    agentType: "codex-runner",
    finalMessage: "Canvas renders hub + agent cards, wired to /events, zero console errors.",
  });
  await sleep(800);
  emit("agent.end", {
    agentId: "demo-s1",
    agentType: "claude",
    finalMessage: "Investigation closed — false alarm, no repro.",
  });
  await sleep(800);

  emit("plan.step", { stepId: "plan-3", status: "done" });
  await sleep(500);
  emit("plan.step", { stepId: "plan-4", status: "active" });
  await sleep(500);
  emit("plan.step", { stepId: "plan-4", status: "done" });
  await sleep(1500);

  // persistence beat (§31.5) — one more beat right before turn.end so the
  // hub's activity-clear-on-turn.end transition is visible in the demo
  emit("session.activity", { tool: "Bash", hint: "npm test -- --run" });
  await sleep(1500);

  emit("turn.end");

  console.log(`[demo] done — session ${SESSION_ID}`);
}

main();
