// Reducer v3 token/cost enrichment test suite (docs/FLEETVIEW-SPEC.md §19,
// §21.1). Boots the real server/server.mjs as a child process against a
// scratch FLEET_EVENTS_FILE and a scratch HOME, on a 48xx port (never the
// live ~/.lumenade/events.jsonl or ~/.claude/settings.json). Drives it by
// appending neutral events to the events file and reading back the SSE
// snapshot over HTTP -- the same interface a real client uses.
//
// All event timestamps are explicit ISO strings (the reducer trusts evt.t,
// §11/§20) so lastActivityAt assertions are deterministic regardless of how
// fast this test happens to run.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, appendFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SERVER_PATH = join(REPO_ROOT, "server", "server.mjs");

const PORT = 4855;
const BASE_URL = `http://127.0.0.1:${PORT}`;

let scratchDir;
let eventsFile;
let child;

function appendEvent(evt) {
  appendFileSync(eventsFile, JSON.stringify(evt) + "\n");
}

// Reads exactly the first SSE block ("event: snapshot\ndata: {...}\n\n")
// off a fresh /events connection, then closes the connection.
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

before(async () => {
  scratchDir = mkdtempSync(join(tmpdir(), "fleetview-reducer-usage-"));
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

describe("reducer v3 — agent.usage (§19.2)", () => {
  const SESSION_ID = "usage-session";
  const AGENT_ID = "agentA";

  test("upserts agent tokens/costUsd, session tokens/costUsd (null agentId), retains transcriptPath, never bumps lastActivityAt", async () => {
    const T0 = "2026-01-02T00:00:00.000Z";
    const T1 = "2026-01-02T00:00:01.000Z";
    const T2 = "2026-01-02T00:00:02.000Z"; // last event that legitimately bumps freshness
    const T3 = "2026-01-02T00:00:03.000Z"; // agent-level agent.usage
    const T4 = "2026-01-02T00:00:04.000Z"; // session-level agent.usage (agentId: null)
    const T5 = "2026-01-02T00:00:05.000Z"; // agent.end -- normal event, bumps again

    const sessionTranscriptPath = join(scratchDir, "does-not-exist", "usage-session.jsonl");
    const agentTranscriptPath = join(
      scratchDir,
      "does-not-exist",
      "usage-session",
      "subagents",
      `agent-${AGENT_ID}.jsonl`
    );

    appendEvent({
      v: 1,
      source: "demo",
      t: T0,
      kind: "session.start",
      sessionId: SESSION_ID,
      cwd: REPO_ROOT,
      transcriptPath: sessionTranscriptPath,
    });
    appendEvent({
      v: 1,
      source: "demo",
      t: T1,
      kind: "agent.start",
      sessionId: SESSION_ID,
      agentId: AGENT_ID,
      agentType: "builder",
    });
    appendEvent({
      v: 1,
      source: "demo",
      t: T2,
      kind: "agent.activity",
      sessionId: SESSION_ID,
      agentId: AGENT_ID,
      phase: "start",
      callId: "call-1",
      tool: "Write",
      hint: "writing things",
    });

    // Snapshot after T2: both session and agent lastActivityAt should read T2.
    let snap = await waitForSnapshot((s) => {
      const agent = findAgent(s, AGENT_ID);
      return agent && agent.lastActivityAt === T2;
    });
    const sessionAfterT2 = findSession(snap, SESSION_ID);
    const agentAfterT2 = findAgent(snap, AGENT_ID);
    assert.equal(sessionAfterT2.lastActivityAt, T2);
    assert.equal(agentAfterT2.lastActivityAt, T2);
    assert.equal(sessionAfterT2.transcriptPath, sessionTranscriptPath, "session.start's transcriptPath is retained");

    // Agent-level agent.usage: must set tokens/costUsd but NOT bump either
    // lastActivityAt.
    appendEvent({
      v: 1,
      source: "demo",
      t: T3,
      kind: "agent.usage",
      sessionId: SESSION_ID,
      agentId: AGENT_ID,
      tokens: { in: 100, out: 200, cacheRead: 5, cacheWrite: 6 },
      costUsd: 0.0123,
    });

    snap = await waitForSnapshot((s) => {
      const agent = findAgent(s, AGENT_ID);
      return agent && agent.tokens != null;
    });
    let session = findSession(snap, SESSION_ID);
    let agent = findAgent(snap, AGENT_ID);
    assert.deepEqual(agent.tokens, { in: 100, out: 200, cacheRead: 5, cacheWrite: 6 });
    assert.equal(agent.costUsd, 0.0123);
    assert.equal(agent.lastActivityAt, T2, "agent.usage must not bump agent lastActivityAt");
    assert.equal(session.lastActivityAt, T2, "agent.usage must not bump session lastActivityAt");
    assert.equal(session.tokens, null, "session-level tokens untouched by an agent-scoped usage event");

    // Session-level agent.usage (agentId: null): must set Session tokens/
    // costUsd, again without bumping lastActivityAt anywhere.
    appendEvent({
      v: 1,
      source: "demo",
      t: T4,
      kind: "agent.usage",
      sessionId: SESSION_ID,
      agentId: null,
      tokens: { in: 1000, out: 2000, cacheRead: 50, cacheWrite: 60 },
      costUsd: 0.5,
    });

    snap = await waitForSnapshot((s) => {
      const sess = findSession(s, SESSION_ID);
      return sess && sess.tokens != null;
    });
    session = findSession(snap, SESSION_ID);
    agent = findAgent(snap, AGENT_ID);
    assert.deepEqual(session.tokens, { in: 1000, out: 2000, cacheRead: 50, cacheWrite: 60 });
    assert.equal(session.costUsd, 0.5);
    assert.equal(session.lastActivityAt, T2, "session-level agent.usage must not bump session lastActivityAt");
    assert.equal(agent.lastActivityAt, T2, "session-level agent.usage must not bump agent lastActivityAt either");
    // Agent-level fields from the previous event must be undisturbed.
    assert.deepEqual(agent.tokens, { in: 100, out: 200, cacheRead: 5, cacheWrite: 6 });

    // An agent.usage for an unknown agentId is skipped silently -- no throw,
    // no new agent materializes, existing state untouched.
    appendEvent({
      v: 1,
      source: "demo",
      t: "2026-01-02T00:00:04.500Z",
      kind: "agent.usage",
      sessionId: SESSION_ID,
      agentId: "does-not-exist",
      tokens: { in: 1, out: 1, cacheRead: 0, cacheWrite: 0 },
    });

    // agent.end: a normal event, so it DOES bump lastActivityAt, and it
    // retains evt.transcriptPath (authoritative, §19.1).
    appendEvent({
      v: 1,
      source: "demo",
      t: T5,
      kind: "agent.end",
      sessionId: SESSION_ID,
      agentId: AGENT_ID,
      finalMessage: "all done",
      transcriptPath: agentTranscriptPath,
    });

    snap = await waitForSnapshot((s) => {
      const a = findAgent(s, AGENT_ID);
      return a && a.status === "done";
    });
    session = findSession(snap, SESSION_ID);
    agent = findAgent(snap, AGENT_ID);

    assert.equal(findAgent(snap, "does-not-exist"), undefined, "unknown agentId never materialized an agent");
    assert.equal(agent.transcriptPath, agentTranscriptPath, "agent.end's transcriptPath is retained");
    assert.equal(agent.status, "done");
    // agent.end never touched agent.lastActivityAt even pre-v3 (only
    // agent.start/agent.activity do) -- unrelated to §19.2's no-bump rule.
    assert.equal(agent.lastActivityAt, T2);
    assert.equal(session.lastActivityAt, T5, "agent.end is a normal (non-usage) event and DOES bump session freshness");
    // Tokens/cost set earlier must survive through agent.end untouched.
    assert.deepEqual(agent.tokens, { in: 100, out: 200, cacheRead: 5, cacheWrite: 6 });
    assert.equal(agent.costUsd, 0.0123);
  });
});

describe("reducer v3 — back-compat with v2-era event streams", () => {
  const SESSION_ID = "v2-session";
  const AGENT_ID = "agentB";

  test("a v2-era stream (no agent.usage events, no transcriptPath) reduces identically -- new fields default null, nothing throws", async () => {
    const T0 = "2026-01-02T01:00:00.000Z";
    const T1 = "2026-01-02T01:00:01.000Z";
    const T2 = "2026-01-02T01:00:02.000Z";
    const T3 = "2026-01-02T01:00:03.000Z";

    // Deliberately omit transcriptPath everywhere, exactly like a pre-v3
    // adapter payload would.
    appendEvent({
      v: 1,
      source: "claude-code",
      t: T0,
      kind: "session.start",
      sessionId: SESSION_ID,
      cwd: REPO_ROOT,
    });
    appendEvent({ v: 1, source: "claude-code", t: T1, kind: "turn.start", sessionId: SESSION_ID });
    appendEvent({
      v: 1,
      source: "claude-code",
      t: T2,
      kind: "agent.start",
      sessionId: SESSION_ID,
      agentId: AGENT_ID,
      agentType: "checker",
    });
    appendEvent({
      v: 1,
      source: "claude-code",
      t: T2,
      kind: "agent.activity",
      sessionId: SESSION_ID,
      agentId: AGENT_ID,
      phase: "start",
      callId: "call-b1",
      tool: "Read",
      hint: "reading things",
    });
    appendEvent({
      v: 1,
      source: "claude-code",
      t: T3,
      kind: "agent.end",
      sessionId: SESSION_ID,
      agentId: AGENT_ID,
      finalMessage: "checked out",
    });

    const snap = await waitForSnapshot((s) => {
      const a = findAgent(s, AGENT_ID);
      return a && a.status === "done";
    });
    const session = findSession(snap, SESSION_ID);
    const agent = findAgent(snap, AGENT_ID);

    assert.equal(session.transcriptPath, null);
    assert.equal(session.tokens, null);
    assert.equal(session.costUsd, null);
    assert.equal(agent.transcriptPath, null);
    assert.equal(agent.tokens, null);
    assert.equal(agent.costUsd, null);
    assert.equal(agent.status, "done");
    assert.equal(agent.finalMessage, "checked out");
    assert.equal(agent.label, "Checker");
  });
});
