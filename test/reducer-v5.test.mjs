// Reducer v5 test suite (docs/FLEETVIEW-SPEC.md §31 — orchestrator card,
// session model, session-activity SSE). Boots the real server/server.mjs as
// a child process against a scratch FLEET_EVENTS_FILE and a scratch HOME, on
// port 4858 (never the live ~/.agenticade/events.jsonl or
// ~/.claude/settings.json, never port 4747 which is the binface test rig).
// Drives it by appending neutral events to the events file and reading back
// the SSE snapshot / log endpoints over HTTP -- the same interface a real
// client uses.
//
// All event timestamps are explicit ISO strings (the reducer trusts evt.t,
// §11/§20) so ordering/freshness assertions are deterministic regardless of
// how fast this test happens to run -- except the live-enricher case (§19.3
// integration), which necessarily uses real wall-clock timestamps: the
// enricher's session target gate requires `session.lastActivityAt` to be
// less than 10 minutes old relative to real time (§19.3), so a fixed 2026
// date would silently disqualify the session from ever being enriched.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SERVER_PATH = join(REPO_ROOT, "server", "server.mjs");

const PORT = 4858;
const BASE_URL = `http://127.0.0.1:${PORT}`;

let scratchDir;
let eventsFile;
let child;

function appendEvent(evt) {
  appendFileSync(eventsFile, JSON.stringify(evt) + "\n");
}

// Reads exactly the first SSE block ("event: snapshot\ndata: {...}\n\n") off
// a fresh /events connection, then closes the connection.
async function fetchSnapshot() {
  const res = await fetch(`${BASE_URL}/events`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const idx = buf.indexOf("\n\n");
      if (idx !== -1) {
        const block = buf.slice(0, idx);
        const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
        if (dataLine) return JSON.parse(dataLine.slice("data: ".length));
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  throw new Error("connection closed before a snapshot arrived");
}

async function waitForSnapshot(predicate, timeoutMs = 8000) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    last = await fetchSnapshot();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for snapshot condition; last snapshot: ${JSON.stringify(last)}`);
}

async function waitForHealthz(timeoutMs = 8000) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE_URL}/healthz`);
      if (res.ok) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server never became healthy: ${lastErr}`);
}

function findSession(snapshot, id) {
  return snapshot.sessions.find((s) => s.id === id);
}
function findAgent(snapshot, id) {
  return snapshot.agents.find((a) => a.id === id);
}

async function fetchJson(pathname) {
  const res = await fetch(`${BASE_URL}${pathname}`);
  return res.json();
}

before(async () => {
  scratchDir = mkdtempSync(join(tmpdir(), "fleetview-reducer-v5-"));
  eventsFile = join(scratchDir, "events.jsonl");
  const scratchHome = join(scratchDir, "home");
  mkdirSync(scratchHome, { recursive: true });

  child = spawn(process.execPath, [SERVER_PATH], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      FLEET_EVENTS_FILE: eventsFile,
      HOME: scratchHome,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  await waitForHealthz();
});

after(() => {
  if (child) child.kill();
  if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (1) turn.start -> session turnActive
// ---------------------------------------------------------------------------

describe("reducer v5 — turn.start baseline", () => {
  test("turn.start sets session.turnActive = true", async () => {
    const SID = "v5-turnstart-session";
    const T0 = "2026-06-01T00:00:00.000Z";
    const T1 = "2026-06-01T00:00:01.000Z";

    appendEvent({ v: 1, source: "claude-code", t: T0, kind: "session.start", sessionId: SID, cwd: REPO_ROOT });
    appendEvent({ v: 1, source: "claude-code", t: T1, kind: "turn.start", sessionId: SID });

    const snap = await waitForSnapshot((s) => findSession(s, SID)?.turnActive === true);
    assert.equal(findSession(snap, SID).turnActive, true);
  });
});

// ---------------------------------------------------------------------------
// (2) Delegate synthesis guard (§31.1) -- exact/nested spawn-pendings leave
// currentActivity untouched; a fuzzy (neither agentId nor parentAgentId)
// spawn-pending synthesizes a "delegate" activity + session log ring entry.
// ---------------------------------------------------------------------------

describe("reducer v5 — delegate synthesis guard (§31.1)", () => {
  test("exact (agentId) and nested (parentAgentId) spawn-pendings leave currentActivity byte-identical; fuzzy synthesizes delegate", async () => {
    const SID = "v5-delegate-session";
    const EXACT_AGENT = "v5-delegate-exact-agent";
    const T0 = "2026-06-02T00:00:00.000Z";
    const T1 = "2026-06-02T00:00:01.000Z";
    const T2 = "2026-06-02T00:00:02.000Z"; // session.activity -- baseline currentActivity
    const T3 = "2026-06-02T00:00:03.000Z"; // exact spawn-pending (agentId) -- must not touch
    const T4 = "2026-06-02T00:00:04.000Z"; // nested spawn-pending (parentAgentId, no agentId) -- must not touch
    const T5 = "2026-06-02T00:00:05.000Z"; // fuzzy spawn-pending (neither) -- synthesizes delegate

    appendEvent({ v: 1, source: "claude-code", t: T0, kind: "session.start", sessionId: SID, cwd: REPO_ROOT });
    appendEvent({ v: 1, source: "claude-code", t: T1, kind: "turn.start", sessionId: SID });
    appendEvent({
      v: 1,
      source: "claude-code",
      t: T2,
      kind: "session.activity",
      sessionId: SID,
      tool: "Read",
      hint: "reading fixtures",
      file: "fixtures/dedupe.jsonl",
    });

    let snap = await waitForSnapshot((s) => findSession(s, SID)?.currentActivity != null);
    const baseline = findSession(snap, SID).currentActivity;
    assert.deepEqual(baseline, { tool: "Read", hint: "reading fixtures", file: "fixtures/dedupe.jsonl", t: T2 });

    // Exact spawn-pending (agentId present, no existing agent record yet --
    // the exactPending branch) must not touch currentActivity at all.
    appendEvent({
      v: 1,
      source: "claude-code",
      t: T3,
      kind: "agent.spawn-pending",
      sessionId: SID,
      agentId: EXACT_AGENT,
      agentType: "builder",
      description: "exact claim",
    });
    snap = await waitForSnapshot((s) => findSession(s, SID)?.lastActivityAt === T3);
    assert.deepEqual(findSession(snap, SID).currentActivity, baseline, "exact spawn-pending leaves currentActivity byte-identical");

    // Nested spawn-pending (no agentId, but parentAgentId present -- a
    // subagent's own delegation, not orchestrator work) must also leave
    // currentActivity untouched.
    appendEvent({
      v: 1,
      source: "claude-code",
      t: T4,
      kind: "agent.spawn-pending",
      sessionId: SID,
      agentType: "builder",
      description: "nested claim",
      parentAgentId: EXACT_AGENT,
    });
    snap = await waitForSnapshot((s) => findSession(s, SID)?.lastActivityAt === T4);
    assert.deepEqual(findSession(snap, SID).currentActivity, baseline, "nested spawn-pending leaves currentActivity byte-identical");

    // Fuzzy spawn-pending (neither agentId nor parentAgentId) -- the moment
    // of delegation -- synthesizes a "delegate" activity instead of clearing.
    appendEvent({
      v: 1,
      source: "claude-code",
      t: T5,
      kind: "agent.spawn-pending",
      sessionId: SID,
      agentType: "builder",
      description: "please go build the thing now",
    });
    snap = await waitForSnapshot((s) => findSession(s, SID)?.currentActivity?.tool === "delegate");
    assert.deepEqual(findSession(snap, SID).currentActivity, {
      tool: "delegate",
      hint: "please go build the thing now",
      t: T5,
    });

    // The delegate synthesis also pushes a session log ring entry -- the
    // exact/nested spawn-pendings above must not have pushed anything, so
    // the ring holds exactly [Read entry, delegate entry] in that order.
    const log = await fetchJson(`/sessions/${SID}/log`);
    assert.equal(log.entries.length, 2, "exact/nested spawn-pendings pushed nothing; only Read + delegate");
    assert.deepEqual(log.entries[0], { t: T2, tool: "Read", hint: "reading fixtures", file: "fixtures/dedupe.jsonl" });
    assert.deepEqual(log.entries[1], { t: T5, tool: "delegate", hint: "please go build the thing now" });
  });
});

// ---------------------------------------------------------------------------
// (3) agent.usage optional model (§31.2) -- prettified, only-present-fields,
// never bumps lastActivityAt (pattern: test/reducer-usage.test.mjs:122).
// ---------------------------------------------------------------------------

describe("reducer v5 — agent.usage model (§31.2)", () => {
  test("agentId: null -> session.model set (prettified), lastActivityAt not bumped", async () => {
    const SID = "v5-usage-model-session";
    const T0 = "2026-06-03T00:00:00.000Z";
    const T1 = "2026-06-03T00:00:01.000Z"; // last event that legitimately bumps freshness
    const T2 = "2026-06-03T00:00:02.000Z"; // agent.usage, agentId null, must not bump

    appendEvent({ v: 1, source: "claude-code", t: T0, kind: "session.start", sessionId: SID, cwd: REPO_ROOT });
    appendEvent({ v: 1, source: "claude-code", t: T1, kind: "turn.start", sessionId: SID });

    let snap = await waitForSnapshot((s) => findSession(s, SID)?.lastActivityAt === T1);
    assert.equal(findSession(snap, SID).lastActivityAt, T1);

    appendEvent({
      v: 1,
      source: "claude-code",
      t: T2,
      kind: "agent.usage",
      sessionId: SID,
      agentId: null,
      tokens: { in: 10, out: 20, cacheRead: 0, cacheWrite: 0 },
      costUsd: 0.01,
      model: "claude-opus-4-8",
    });

    snap = await waitForSnapshot((s) => findSession(s, SID)?.model != null);
    const session = findSession(snap, SID);
    assert.equal(session.model, "Claude Opus 4.8");
    assert.equal(session.lastActivityAt, T1, "agent.usage's optional model must not bump lastActivityAt");
  });

  test("agentId set -> that agent.model set (prettified), lastActivityAt not bumped", async () => {
    const SID = "v5-usage-model-session-2";
    const AGENT_ID = "v5-usage-model-agent";
    const T0 = "2026-06-04T00:00:00.000Z";
    const T1 = "2026-06-04T00:00:01.000Z"; // agent.start -- last legit bump for session and agent
    const T2 = "2026-06-04T00:00:02.000Z"; // agent.usage with model -- must not bump either

    appendEvent({ v: 1, source: "claude-code", t: T0, kind: "session.start", sessionId: SID, cwd: REPO_ROOT });
    appendEvent({
      v: 1,
      source: "claude-code",
      t: T1,
      kind: "agent.start",
      sessionId: SID,
      agentId: AGENT_ID,
      agentType: "builder",
    });

    let snap = await waitForSnapshot((s) => findAgent(s, AGENT_ID)?.lastActivityAt === T1);
    assert.equal(findSession(snap, SID).lastActivityAt, T1);
    assert.equal(findAgent(snap, AGENT_ID).lastActivityAt, T1);

    appendEvent({
      v: 1,
      source: "claude-code",
      t: T2,
      kind: "agent.usage",
      sessionId: SID,
      agentId: AGENT_ID,
      tokens: { in: 1, out: 2, cacheRead: 0, cacheWrite: 0 },
      costUsd: 0.001,
      model: "claude-opus-4-8",
    });

    snap = await waitForSnapshot((s) => findAgent(s, AGENT_ID)?.model === "Claude Opus 4.8");
    const session = findSession(snap, SID);
    const agent = findAgent(snap, AGENT_ID);
    assert.equal(agent.model, "Claude Opus 4.8");
    assert.equal(agent.lastActivityAt, T1, "agent.usage's optional model must not bump agent lastActivityAt");
    assert.equal(session.lastActivityAt, T1, "agent.usage never bumps session lastActivityAt either, regardless of agentId");
  });
});

// ---------------------------------------------------------------------------
// (4) Live-enricher integration (§31.2, §19.3) -- depends on server/enrich.mjs
// reporting a 4th onUsage arg (Builder A's concurrent change). Reuses the
// CONTENT of test/fixtures/transcripts/dedupe.jsonl, rewritten with
// current-clock `timestamp` fields; more importantly the session.start
// event's own `t` must be current-clock too, since that is what feeds
// session.lastActivityAt, which is what the enricher's <10-min session
// target gate actually checks (§19.3) -- a fixed historical date would
// silently disqualify the session from ever becoming an enrichment target.
// ---------------------------------------------------------------------------

function buildLiveTranscript(nowMs) {
  const fixturePath = join(REPO_ROOT, "test", "fixtures", "transcripts", "dedupe.jsonl");
  const raw = readFileSync(fixturePath, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const rewritten = lines.map((line, i) => {
    const obj = JSON.parse(line);
    obj.timestamp = new Date(nowMs + i * 500).toISOString();
    return JSON.stringify(obj);
  });
  return rewritten.join("\n") + "\n";
}

describe("reducer v5 — live enricher integration (§31.2, §19.3)", () => {
  test("a real transcript's most-recent qualifying model becomes session.model within one enricher tick, without bumping lastActivityAt", async () => {
    const SID = "v5-live-enrich-session";
    const nowMs = Date.now();
    const T0 = new Date(nowMs).toISOString();

    const transcriptPath = join(scratchDir, "live-transcript.jsonl");
    writeFileSync(transcriptPath, buildLiveTranscript(nowMs));

    appendEvent({
      v: 1,
      source: "claude-code",
      t: T0,
      kind: "session.start",
      sessionId: SID,
      cwd: REPO_ROOT,
      transcriptPath,
    });

    let snap = await waitForSnapshot((s) => findSession(s, SID)?.lastActivityAt === T0);
    assert.equal(findSession(snap, SID).lastActivityAt, T0);
    assert.equal(findSession(snap, SID).model, null, "model is blank until the enricher reports one");

    // Default enrichment.intervalMs is 5000ms (fleet.config.json); the first
    // tick can land anywhere in that window depending on server boot timing,
    // so give this a generous timeout.
    snap = await waitForSnapshot((s) => findSession(s, SID)?.model != null, 20000);
    const session = findSession(snap, SID);
    // dedupe.jsonl's last qualifying assistant line (msg_3) carries model
    // "claude-opus-4-8-20260201" -- date-suffix-stripped and prettified.
    assert.equal(session.model, "Claude Opus 4.8", "most-recent qualifying model, prettified");
    assert.equal(session.lastActivityAt, T0, "enrichment must never bump session lastActivityAt");
  });
});

// ---------------------------------------------------------------------------
// (5) GET /sessions/:id/log shape unchanged for unknown session ids.
// ---------------------------------------------------------------------------

describe("reducer v5 — log endpoint shape unchanged", () => {
  test("unknown session id -> {sessionId, entries: []}", async () => {
    const unknown = await fetchJson(`/sessions/v5-does-not-exist/log`);
    assert.deepEqual(unknown, { sessionId: "v5-does-not-exist", entries: [] });
  });
});
