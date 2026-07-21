// Reducer v4 test suite (docs/FLEETVIEW-SPEC.md §24 lineage, §25 session
// activity, §26 capability chips). Boots the real server/server.mjs as a
// child process against a scratch FLEET_EVENTS_FILE and a scratch HOME, on
// port 4857 (never the live ~/.agenticade/events.jsonl or
// ~/.claude/settings.json). Drives it by appending neutral events to the
// events file and reading back the SSE snapshot / log endpoints over HTTP --
// the same interface a real client uses.
//
// All event timestamps are explicit ISO strings (the reducer trusts evt.t,
// §11/§20) so ordering/freshness assertions are deterministic regardless of
// how fast this test happens to run.

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

const PORT = 4857;
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
  scratchDir = mkdtempSync(join(tmpdir(), "fleetview-reducer-v4-"));
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
// §24 -- nested-spawn lineage. Ids below are the parent/child ids from the
// live S3 probe captures in test/fixtures/nested-*.json: parent agent_id
// "ac87ff2ff3d145aad" (a running general-purpose agent), child agentId
// "a035ab21c1995b9cd" (tool_response.agentId from the PostToolUse Agent
// call), agentType "general-purpose", description "Read note.txt", model
// "claude-opus-4-8[1m]" (resolvedModel).
// ---------------------------------------------------------------------------

describe("reducer v4 — nested-spawn lineage (§24)", () => {
  const SESSION_ID = "lineage-session";
  const PARENT_ID = "ac87ff2ff3d145aad";
  const CHILD_ID = "a035ab21c1995b9cd";

  test("fuzzy-pre -> start: parentId set at agent.start time", async () => {
    const T0 = "2026-02-01T00:00:00.000Z";
    const T1 = "2026-02-01T00:00:01.000Z";
    const T2 = "2026-02-01T00:00:02.000Z";

    appendEvent({
      v: 1,
      source: "claude-code",
      t: T0,
      kind: "session.start",
      sessionId: SESSION_ID,
      cwd: REPO_ROOT,
    });
    // Parent must exist so it's a plausible spawner, though the reducer
    // doesn't require it -- parentId is stored regardless of whether the
    // parent agent record exists.
    appendEvent({
      v: 1,
      source: "claude-code",
      t: T0,
      kind: "agent.start",
      sessionId: SESSION_ID,
      agentId: PARENT_ID,
      agentType: "general-purpose",
    });
    // Fuzzy spawn-pending (PreToolUse Agent, no child id yet) carries the
    // parent's own agent_id as parentAgentId.
    appendEvent({
      v: 1,
      source: "claude-code",
      t: T1,
      kind: "agent.spawn-pending",
      sessionId: SESSION_ID,
      agentType: "general-purpose",
      description: "Read note.txt",
      parentAgentId: PARENT_ID,
    });
    // Child SubagentStart -- no agentType/description/parent on the payload
    // itself; the reducer must fuzzy-claim the pending entry above.
    appendEvent({
      v: 1,
      source: "claude-code",
      t: T2,
      kind: "agent.start",
      sessionId: SESSION_ID,
      agentId: CHILD_ID,
      agentType: "general-purpose",
    });

    const snap = await waitForSnapshot((s) => findAgent(s, CHILD_ID) != null);
    const child = findAgent(snap, CHILD_ID);
    assert.equal(child.parentId, PARENT_ID, "fuzzy-claimed parentAgentId transferred to agent.parentId at agent.start");
    assert.equal(child.description, "Read note.txt", "fuzzy claim also transferred description as before");
  });

  test("start -> exact-post: parentId set once the exact spawn-pending arrives later", async () => {
    const SID = "lineage-session-2";
    const PARENT = "parent-2";
    const CHILD = "child-2";
    const T0 = "2026-02-01T01:00:00.000Z";
    const T1 = "2026-02-01T01:00:01.000Z";
    const T2 = "2026-02-01T01:00:02.000Z";

    appendEvent({ v: 1, source: "claude-code", t: T0, kind: "session.start", sessionId: SID, cwd: REPO_ROOT });
    // Child SubagentStart fires first (S3 probe ordering: Pre-fuzzy, then
    // SubagentStart/Stop, then the parent's PostToolUse-exact arrives last).
    appendEvent({
      v: 1,
      source: "claude-code",
      t: T0,
      kind: "agent.start",
      sessionId: SID,
      agentId: CHILD,
      agentType: "general-purpose",
    });

    let snap = await waitForSnapshot((s) => findAgent(s, CHILD) != null);
    assert.equal(findAgent(snap, CHILD).parentId, null, "no lineage info yet -- parentId defaults null");

    // Exact spawn-pending (parent's PostToolUse) arrives after agent.start --
    // the "existing agent" update branch of the spawn-pending case.
    appendEvent({
      v: 1,
      source: "claude-code",
      t: T1,
      kind: "agent.spawn-pending",
      sessionId: SID,
      agentId: CHILD,
      agentType: "general-purpose",
      description: "Read note.txt",
      parentAgentId: PARENT,
      model: "claude-opus-4-8[1m]",
    });

    snap = await waitForSnapshot((s) => {
      const a = findAgent(s, CHILD);
      return a && a.parentId === PARENT;
    });
    const child = findAgent(snap, CHILD);
    assert.equal(child.parentId, PARENT, "exact spawn-pending's parentAgentId set after agent.start");
    assert.equal(child.description, "Read note.txt");

    // Sanity: a later, unrelated event doesn't disturb parentId.
    appendEvent({ v: 1, source: "claude-code", t: T2, kind: "turn.end", sessionId: SID });
    snap = await waitForSnapshot((s) => findSession(s, SID)?.turnActive === false);
    assert.equal(findAgent(snap, CHILD).parentId, PARENT);
  });

  test("exact overwrites a fuzzy-set parentId (authoritative repair)", async () => {
    const SID = "lineage-session-3";
    const FUZZY_PARENT = "fuzzy-parent";
    const EXACT_PARENT = "exact-parent";
    const CHILD = "child-3";
    const T0 = "2026-02-01T02:00:00.000Z";
    const T1 = "2026-02-01T02:00:01.000Z";
    const T2 = "2026-02-01T02:00:02.000Z";
    const T3 = "2026-02-01T02:00:03.000Z";

    appendEvent({ v: 1, source: "claude-code", t: T0, kind: "session.start", sessionId: SID, cwd: REPO_ROOT });
    appendEvent({
      v: 1,
      source: "claude-code",
      t: T0,
      kind: "agent.spawn-pending",
      sessionId: SID,
      agentType: "general-purpose",
      description: "race case",
      parentAgentId: FUZZY_PARENT,
    });
    appendEvent({
      v: 1,
      source: "claude-code",
      t: T1,
      kind: "agent.start",
      sessionId: SID,
      agentId: CHILD,
      agentType: "general-purpose",
    });

    let snap = await waitForSnapshot((s) => findAgent(s, CHILD) != null);
    assert.equal(findAgent(snap, CHILD).parentId, FUZZY_PARENT, "fuzzy-set parentId first");

    // The exact spawn-pending's parentAgentId (a possibly-different, more
    // authoritative parent) must overwrite the fuzzy-set value.
    appendEvent({
      v: 1,
      source: "claude-code",
      t: T2,
      kind: "agent.spawn-pending",
      sessionId: SID,
      agentId: CHILD,
      agentType: "general-purpose",
      description: "race case",
      parentAgentId: EXACT_PARENT,
    });

    snap = await waitForSnapshot((s) => {
      const a = findAgent(s, CHILD);
      return a && a.parentId === EXACT_PARENT;
    });
    assert.equal(findAgent(snap, CHILD).parentId, EXACT_PARENT, "exact overwrote the fuzzy-set parentId");

    // Belt-and-braces: an unrelated turn.end afterward doesn't revert it.
    appendEvent({ v: 1, source: "claude-code", t: T3, kind: "turn.end", sessionId: SID });
    snap = await waitForSnapshot((s) => findSession(s, SID)?.turnActive === false);
    assert.equal(findAgent(snap, CHILD).parentId, EXACT_PARENT);
  });

  test("exact spawn-pending arriving after agent.end still sets parentId (post-mortem link)", async () => {
    const SID = "lineage-session-4";
    const PARENT = "parent-4";
    const CHILD = "child-4";
    const T0 = "2026-02-01T03:00:00.000Z";
    const T1 = "2026-02-01T03:00:01.000Z";
    const T2 = "2026-02-01T03:00:02.000Z";

    appendEvent({ v: 1, source: "claude-code", t: T0, kind: "session.start", sessionId: SID, cwd: REPO_ROOT });
    appendEvent({
      v: 1,
      source: "claude-code",
      t: T0,
      kind: "agent.start",
      sessionId: SID,
      agentId: CHILD,
      agentType: "general-purpose",
    });
    appendEvent({
      v: 1,
      source: "claude-code",
      t: T1,
      kind: "agent.end",
      sessionId: SID,
      agentId: CHILD,
      finalMessage: "done before the parent's Post arrived",
    });

    let snap = await waitForSnapshot((s) => findAgent(s, CHILD)?.status === "done");
    assert.equal(findAgent(snap, CHILD).parentId, null);

    // Exact spawn-pending arrives well after SubagentStop (S3-observed
    // ordering for synchronous nested spawns) -- must still update parentId.
    appendEvent({
      v: 1,
      source: "claude-code",
      t: T2,
      kind: "agent.spawn-pending",
      sessionId: SID,
      agentId: CHILD,
      agentType: "general-purpose",
      parentAgentId: PARENT,
    });

    snap = await waitForSnapshot((s) => {
      const a = findAgent(s, CHILD);
      return a && a.parentId === PARENT;
    });
    const child = findAgent(snap, CHILD);
    assert.equal(child.parentId, PARENT, "post-mortem link: parentId set even though the agent already ended");
    assert.equal(child.status, "done", "status untouched by the post-mortem spawn-pending");
  });

  test("self-reference guard: parentId === agentId is treated as null", async () => {
    const SID = "lineage-session-5";
    const CHILD = "self-ref-agent";
    const T0 = "2026-02-01T04:00:00.000Z";
    const T1 = "2026-02-01T04:00:01.000Z";

    appendEvent({ v: 1, source: "claude-code", t: T0, kind: "session.start", sessionId: SID, cwd: REPO_ROOT });
    appendEvent({
      v: 1,
      source: "claude-code",
      t: T0,
      kind: "agent.spawn-pending",
      sessionId: SID,
      agentType: "general-purpose",
      description: "self ref via fuzzy claim",
      parentAgentId: CHILD, // pathological: same id as the agent about to start
    });
    appendEvent({
      v: 1,
      source: "claude-code",
      t: T0,
      kind: "agent.start",
      sessionId: SID,
      agentId: CHILD,
      agentType: "general-purpose",
    });

    let snap = await waitForSnapshot((s) => findAgent(s, CHILD) != null);
    assert.equal(findAgent(snap, CHILD).parentId, null, "self-reference via fuzzy claim sanitized to null");

    // Also check the exact-claim self-reference path (existing-agent branch).
    // parentId itself doesn't visibly change (already null), so wait on
    // session freshness (every event bumps it) to know this line was applied.
    appendEvent({
      v: 1,
      source: "claude-code",
      t: T1,
      kind: "agent.spawn-pending",
      sessionId: SID,
      agentId: CHILD,
      agentType: "general-purpose",
      parentAgentId: CHILD,
    });
    snap = await waitForSnapshot((s) => findSession(s, SID)?.lastActivityAt === T1);
    assert.equal(findAgent(snap, CHILD).parentId, null, "self-reference via exact claim also sanitized to null");
  });

  test("agent with parentId pointing at an unknown id keeps it (UI handles fallback)", async () => {
    const SID = "lineage-session-6";
    const CHILD = "orphan-child";
    const UNKNOWN_PARENT = "no-such-agent-anywhere";
    const T0 = "2026-02-01T05:00:00.000Z";

    appendEvent({ v: 1, source: "claude-code", t: T0, kind: "session.start", sessionId: SID, cwd: REPO_ROOT });
    appendEvent({
      v: 1,
      source: "claude-code",
      t: T0,
      kind: "agent.spawn-pending",
      sessionId: SID,
      agentType: "general-purpose",
      description: "orphan parent",
      parentAgentId: UNKNOWN_PARENT,
    });
    appendEvent({
      v: 1,
      source: "claude-code",
      t: T0,
      kind: "agent.start",
      sessionId: SID,
      agentId: CHILD,
      agentType: "general-purpose",
    });

    const snap = await waitForSnapshot((s) => findAgent(s, CHILD) != null);
    assert.equal(findAgent(snap, CHILD).parentId, UNKNOWN_PARENT, "unresolved parent id kept as-is, not nulled");
    assert.equal(findAgent(snap, UNKNOWN_PARENT), undefined, "no agent record materializes for the unknown parent");
  });
});

// ---------------------------------------------------------------------------
// §25 -- session.activity (pre-plan orchestrator readout)
// ---------------------------------------------------------------------------

describe("reducer v4 — session.activity (§25)", () => {
  const SESSION_ID = "activity-session";

  test("sets currentActivity, synthesizes delegate on fuzzy spawn-pending (§31.1), cleared by turn.end", async () => {
    const T0 = "2026-03-01T00:00:00.000Z";
    const T1 = "2026-03-01T00:00:01.000Z";
    const T2 = "2026-03-01T00:00:02.000Z";
    const T3 = "2026-03-01T00:00:03.000Z";
    const T4 = "2026-03-01T00:00:04.000Z";

    appendEvent({ v: 1, source: "claude-code", t: T0, kind: "session.start", sessionId: SESSION_ID, cwd: REPO_ROOT });
    appendEvent({ v: 1, source: "claude-code", t: T1, kind: "turn.start", sessionId: SESSION_ID });
    appendEvent({
      v: 1,
      source: "claude-code",
      t: T2,
      kind: "session.activity",
      sessionId: SESSION_ID,
      tool: "Read",
      hint: "reading plan.md",
      file: "plan.md",
    });

    let snap = await waitForSnapshot((s) => findSession(s, SESSION_ID)?.currentActivity != null);
    let session = findSession(snap, SESSION_ID);
    assert.deepEqual(session.currentActivity, { tool: "Read", hint: "reading plan.md", file: "plan.md", t: T2 });

    // A fuzzy agent.spawn-pending (no agentId, no parentAgentId) is the
    // moment of delegation -- §31.1 synthesizes a "delegate" activity
    // instead of clearing currentActivity (supersedes §25's spawn-clear).
    appendEvent({
      v: 1,
      source: "claude-code",
      t: T3,
      kind: "agent.spawn-pending",
      sessionId: SESSION_ID,
      agentType: "builder",
      description: "go build it",
    });

    snap = await waitForSnapshot((s) => findSession(s, SESSION_ID)?.currentActivity?.tool === "delegate");
    session = findSession(snap, SESSION_ID);
    assert.deepEqual(
      session.currentActivity,
      { tool: "delegate", hint: "go build it", t: T3 },
      "fuzzy spawn-pending synthesizes a delegate activity, not a clear"
    );

    // The delegate synthesis also pushes a session log ring entry, appearing
    // after the earlier Read entry.
    const logAfterDelegate = await fetchJson(`/sessions/${SESSION_ID}/log`);
    assert.equal(logAfterDelegate.entries.length, 2, "Read entry, then delegate entry");
    assert.deepEqual(logAfterDelegate.entries[0], {
      t: T2,
      tool: "Read",
      hint: "reading plan.md",
      file: "plan.md",
    });
    assert.deepEqual(logAfterDelegate.entries[1], { t: T3, tool: "delegate", hint: "go build it" });

    // Set it again, then confirm turn.end also clears it.
    appendEvent({
      v: 1,
      source: "claude-code",
      t: T4,
      kind: "session.activity",
      sessionId: SESSION_ID,
      tool: "Bash",
      hint: "ls -la",
    });
    snap = await waitForSnapshot((s) => findSession(s, SESSION_ID)?.currentActivity?.tool === "Bash");
    assert.notEqual(findSession(snap, SESSION_ID).currentActivity, null);

    appendEvent({ v: 1, source: "claude-code", t: "2026-03-01T00:00:05.000Z", kind: "turn.end", sessionId: SESSION_ID });
    snap = await waitForSnapshot((s) => findSession(s, SESSION_ID)?.currentActivity == null && findSession(s, SESSION_ID)?.turnActive === false);
    assert.equal(findSession(snap, SESSION_ID).currentActivity, null, "turn.end clears currentActivity");
  });

  test("GET /sessions/:id/log returns the ring entries; ring caps at 50", async () => {
    const SID = "activity-log-session";
    const T0 = "2026-03-02T00:00:00.000Z";
    appendEvent({ v: 1, source: "claude-code", t: T0, kind: "session.start", sessionId: SID, cwd: REPO_ROOT });

    for (let i = 0; i < 55; i++) {
      appendEvent({
        v: 1,
        source: "claude-code",
        t: new Date(Date.parse(T0) + (i + 1) * 1000).toISOString(),
        kind: "session.activity",
        sessionId: SID,
        tool: "Read",
        hint: `line ${i}`,
      });
    }

    await waitForSnapshot((s) => findSession(s, SID)?.currentActivity?.hint === "line 54");

    const log = await fetchJson(`/sessions/${SID}/log`);
    assert.equal(log.sessionId, SID);
    assert.equal(log.entries.length, 50, "ring caps at 50");
    assert.equal(log.entries[0].hint, "line 5", "oldest 5 entries evicted (55 pushed, cap 50)");
    assert.equal(log.entries[49].hint, "line 54", "newest entry retained");

    // Unknown session id -> empty entries, not an error.
    const unknown = await fetchJson(`/sessions/does-not-exist/log`);
    assert.deepEqual(unknown, { sessionId: "does-not-exist", entries: [] });
  });
});

// ---------------------------------------------------------------------------
// §26 -- capability chips
// ---------------------------------------------------------------------------

describe("reducer v4 — capability chips (§26)", () => {
  test("mcp__codex__foo agent.activity -> agent capabilities [{kind:mcp,name:codex}], deduped across repeats", async () => {
    const SID = "cap-session-1";
    const AGENT_ID = "cap-agent-1";
    const T0 = "2026-04-01T00:00:00.000Z";
    const T1 = "2026-04-01T00:00:01.000Z";
    const T2 = "2026-04-01T00:00:02.000Z";
    const T3 = "2026-04-01T00:00:03.000Z";

    appendEvent({ v: 1, source: "claude-code", t: T0, kind: "session.start", sessionId: SID, cwd: REPO_ROOT });
    appendEvent({
      v: 1,
      source: "claude-code",
      t: T0,
      kind: "agent.start",
      sessionId: SID,
      agentId: AGENT_ID,
      agentType: "builder",
    });
    appendEvent({
      v: 1,
      source: "claude-code",
      t: T1,
      kind: "agent.activity",
      sessionId: SID,
      agentId: AGENT_ID,
      phase: "start",
      callId: "call-1",
      tool: "mcp__codex__foo",
      hint: "doing codex things",
    });
    appendEvent({
      v: 1,
      source: "claude-code",
      t: T2,
      kind: "agent.activity",
      sessionId: SID,
      agentId: AGENT_ID,
      phase: "end",
      callId: "call-1",
      tool: "mcp__codex__foo",
      ms: 100,
    });
    // Repeat -- must dedupe, not produce a second entry.
    appendEvent({
      v: 1,
      source: "claude-code",
      t: T3,
      kind: "agent.activity",
      sessionId: SID,
      agentId: AGENT_ID,
      phase: "start",
      callId: "call-2",
      tool: "mcp__codex__foo",
      hint: "doing more codex things",
    });

    const snap = await waitForSnapshot((s) => {
      const a = findAgent(s, AGENT_ID);
      return a && a.capabilities && a.capabilities.length > 0;
    });
    const agent = findAgent(snap, AGENT_ID);
    assert.deepEqual(agent.capabilities, [{ kind: "mcp", name: "codex" }]);
  });

  test("Skill activity with hint -> skill tag; cap holds at 8", async () => {
    const SID = "cap-session-2";
    const AGENT_ID = "cap-agent-2";
    const T0 = "2026-04-02T00:00:00.000Z";

    appendEvent({ v: 1, source: "claude-code", t: T0, kind: "session.start", sessionId: SID, cwd: REPO_ROOT });
    appendEvent({
      v: 1,
      source: "claude-code",
      t: T0,
      kind: "agent.start",
      sessionId: SID,
      agentId: AGENT_ID,
      agentType: "builder",
    });

    // 1 Skill capability + 9 distinct mcp capabilities = 10 distinct tags
    // offered; only the first 8 (insertion order) should stick.
    appendEvent({
      v: 1,
      source: "claude-code",
      t: "2026-04-02T00:00:01.000Z",
      kind: "agent.activity",
      sessionId: SID,
      agentId: AGENT_ID,
      phase: "start",
      callId: "call-skill",
      tool: "Skill",
      hint: "dataviz",
    });

    for (let i = 0; i < 9; i++) {
      appendEvent({
        v: 1,
        source: "claude-code",
        t: `2026-04-02T00:00:${String(2 + i).padStart(2, "0")}.000Z`,
        kind: "agent.activity",
        sessionId: SID,
        agentId: AGENT_ID,
        phase: "start",
        callId: `call-mcp-${i}`,
        tool: `mcp__server${i}__thing`,
        hint: "x",
      });
    }

    const snap = await waitForSnapshot((s) => {
      const a = findAgent(s, AGENT_ID);
      return a && a.capabilities && a.capabilities.length >= 8;
    });
    const agent = findAgent(snap, AGENT_ID);
    assert.equal(agent.capabilities.length, 8, "cap holds at 8 even though 10 distinct tags were offered");
    assert.deepEqual(agent.capabilities[0], { kind: "skill", name: "dataviz" }, "skill tag inserted first, kept");
    assert.deepEqual(agent.capabilities[7], { kind: "mcp", name: "server6" }, "8th distinct tag (server6) is the last one that fit");
    assert.equal(
      agent.capabilities.some((c) => c.name === "server7" || c.name === "server8"),
      false,
      "9th/10th distinct tags did not fit under the cap"
    );
  });

  test("session.activity contributes to Session.capabilities", async () => {
    const SID = "cap-session-3";
    const T0 = "2026-04-03T00:00:00.000Z";
    const T1 = "2026-04-03T00:00:01.000Z";
    const T2 = "2026-04-03T00:00:02.000Z";

    appendEvent({ v: 1, source: "claude-code", t: T0, kind: "session.start", sessionId: SID, cwd: REPO_ROOT });
    appendEvent({
      v: 1,
      source: "claude-code",
      t: T1,
      kind: "session.activity",
      sessionId: SID,
      tool: "mcp__codex__bar",
      hint: "asking codex",
    });
    appendEvent({
      v: 1,
      source: "claude-code",
      t: T2,
      kind: "session.activity",
      sessionId: SID,
      tool: "Skill",
      hint: "deep-research",
    });

    const snap = await waitForSnapshot((s) => {
      const sess = findSession(s, SID);
      return sess && sess.capabilities && sess.capabilities.length === 2;
    });
    const session = findSession(snap, SID);
    assert.deepEqual(session.capabilities, [
      { kind: "mcp", name: "codex" },
      { kind: "skill", name: "deep-research" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Regression: v3's agent.usage no-bump rule, and stall behavior, must both
// survive v4's additions untouched.
// ---------------------------------------------------------------------------

describe("reducer v4 — regression guards", () => {
  test("agent.usage still never bumps lastActivityAt alongside v4 fields", async () => {
    const SID = "regress-usage-session";
    const AGENT_ID = "regress-usage-agent";
    const T0 = "2026-05-01T00:00:00.000Z";
    const T1 = "2026-05-01T00:00:01.000Z";
    const T2 = "2026-05-01T00:00:02.000Z";

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
    assert.equal(findAgent(snap, AGENT_ID).lastActivityAt, T1);

    appendEvent({
      v: 1,
      source: "claude-code",
      t: T2,
      kind: "agent.usage",
      sessionId: SID,
      agentId: AGENT_ID,
      tokens: { in: 1, out: 1, cacheRead: 0, cacheWrite: 0 },
      costUsd: 0.001,
    });

    snap = await waitForSnapshot((s) => findAgent(s, AGENT_ID)?.tokens != null);
    assert.equal(findAgent(snap, AGENT_ID).lastActivityAt, T1, "agent.usage still must not bump lastActivityAt");
  });

  test("a stalled agent stays stalled when session.activity events arrive afterwards (stall detection is agent-local)", async () => {
    const SID = "regress-stall-session";
    const AGENT_ID = "regress-stall-agent";
    const T0 = "2026-05-02T00:00:00.000Z";
    const T1 = "2026-05-02T00:00:01.000Z";
    // Well past any plausible stallThresholdMs (default 120000ms).
    const LATER = "2026-05-02T01:00:00.000Z";

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
    assert.equal(findAgent(snap, AGENT_ID).lastActivityAt, T1);

    // Main-loop session.activity events keep arriving (the orchestrator is
    // doing pre-plan work in a DIFFERENT part of the session) but must never
    // touch this agent's lastActivityAt -- the demo's stalled-agent beat is
    // the regression canary this test stands in for.
    appendEvent({
      v: 1,
      source: "claude-code",
      t: LATER,
      kind: "session.activity",
      sessionId: SID,
      tool: "Read",
      hint: "still poking around, agent is stalled",
    });

    snap = await waitForSnapshot((s) => findSession(s, SID)?.currentActivity != null);
    assert.equal(findSession(snap, SID).lastActivityAt, LATER, "session freshness DOES bump on session.activity");
    assert.equal(
      findAgent(snap, AGENT_ID).lastActivityAt,
      T1,
      "agent lastActivityAt is untouched by session.activity -- stall detection stays agent-local"
    );
  });
});
