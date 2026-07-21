// Reducer v6 test suite (docs/FLEETVIEW-SPEC.md §32.4 — Session.title). Boots
// the real server/server.mjs as a child process against a scratch
// FLEET_EVENTS_FILE and a scratch HOME, on port 4859 (never the live
// ~/.agenticade/events.jsonl, never 4747 which is the binface test rig, never
// 4858 which reducer-v5 holds — the suites run concurrently).
//
// The title path is enricher-driven, so like §31.2's model case these tests
// necessarily use real wall-clock timestamps: the enricher's session target
// gate requires `session.lastActivityAt` to be under 10 minutes old (§19.3),
// and a fixed 2026 date would silently disqualify the session from ever
// becoming an enrichment target.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SERVER_PATH = join(REPO_ROOT, "server", "server.mjs");

const PORT = 4859;
const BASE_URL = `http://127.0.0.1:${PORT}`;

let scratchDir;
let eventsFile;
let child;

function appendEvent(evt) {
  appendFileSync(eventsFile, JSON.stringify(evt) + "\n");
}

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

// A minimal transcript in the real shape: one usage-bearing assistant line
// plus the `custom-title` sidecar Claude Code rewrites on every rename.
function buildTranscript(nowMs, titles) {
  const lines = [
    JSON.stringify({
      type: "assistant",
      timestamp: new Date(nowMs).toISOString(),
      message: {
        id: "msg_v6_1",
        model: "claude-opus-4-8-20260201",
        usage: {
          input_tokens: 100,
          output_tokens: 200,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    }),
    ...titles.map((t) => JSON.stringify({ type: "custom-title", customTitle: t, sessionId: "x" })),
  ];
  return lines.join("\n") + "\n";
}

before(async () => {
  scratchDir = mkdtempSync(join(tmpdir(), "fleetview-reducer-v6-"));
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

describe("reducer v6 — session title from the transcript (§32.4)", () => {
  test("the last custom-title becomes session.title within one enricher tick, without bumping lastActivityAt", async () => {
    const SID = "v6-title-session";
    const nowMs = Date.now();
    const T0 = new Date(nowMs).toISOString();

    const transcriptPath = join(scratchDir, "titled-transcript.jsonl");
    // Two titles: the reader must land on the second, mirroring a real
    // transcript where the line is rewritten rather than replaced.
    writeFileSync(transcriptPath, buildTranscript(nowMs, ["Working title", "Delegated otter plan"]));

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
    assert.equal(findSession(snap, SID).title, null, "title is blank until the enricher reports one");

    // Default enrichment.intervalMs is 5000ms (fleet.config.json); the first
    // tick can land anywhere in that window depending on server boot timing.
    snap = await waitForSnapshot((s) => findSession(s, SID)?.title != null, 20000);
    const session = findSession(snap, SID);
    assert.equal(session.title, "Delegated otter plan", "last custom-title wins");
    assert.equal(session.lastActivityAt, T0, "a title must never bump session lastActivityAt");
  });

  test("a session whose transcript carries no custom-title keeps title null", async () => {
    const SID = "v6-untitled-session";
    const nowMs = Date.now();
    const T0 = new Date(nowMs).toISOString();

    const transcriptPath = join(scratchDir, "untitled-transcript.jsonl");
    writeFileSync(transcriptPath, buildTranscript(nowMs, []));

    appendEvent({
      v: 1,
      source: "claude-code",
      t: T0,
      kind: "session.start",
      sessionId: SID,
      cwd: REPO_ROOT,
      transcriptPath,
    });

    // Wait for the enricher to demonstrably reach this transcript (it reports
    // usage from the same lines), then assert the title stayed null rather
    // than being guessed at.
    const snap = await waitForSnapshot((s) => findSession(s, SID)?.tokens != null, 20000);
    assert.equal(findSession(snap, SID).title, null, "blank-until-known, never guessed");
  });
});
