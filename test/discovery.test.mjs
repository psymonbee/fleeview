// Agent auto-discovery test suite (docs/FLEETVIEW-SPEC.md §22, §29.3).
// Two layers: unit tests directly against server/discovery.mjs's
// parseFrontmatter/scanAgentDir (no server involved), and an integration
// layer that boots the real server/server.mjs as a child process against a
// scratch FLEET_EVENTS_FILE and a scratch HOME (never the live
// ~/.lumenade/events.jsonl or ~/.claude/settings.json), on port 4856. That
// mirrors test/reducer-usage.test.mjs's harness: drive the server by
// appending neutral events to the events file and reading back the SSE
// snapshot over HTTP.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { parseFrontmatter, scanAgentDir } from "../server/discovery.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SERVER_PATH = join(REPO_ROOT, "server", "server.mjs");

// ---------------------------------------------------------------------------
// Unit: parseFrontmatter
// ---------------------------------------------------------------------------

describe("parseFrontmatter", () => {
  test("valid frontmatter reads name/description/model", () => {
    const text = ["---", "name: scribe", "description: writes things", "model: sonnet", "---", "", "body"].join(
      "\n"
    );
    assert.deepEqual(parseFrontmatter(text), {
      name: "scribe",
      description: "writes things",
      model: "sonnet",
    });
  });

  test("no frontmatter (doesn't start with `---`) -> null", () => {
    assert.equal(parseFrontmatter("# Just a heading\n\nSome body text.\n"), null);
  });

  test("unterminated fence -> null", () => {
    assert.equal(parseFrontmatter("---\nname: scribe\nmodel: sonnet\n"), null);
  });

  test("quoted values (single and double) are unwrapped", () => {
    const text = ["---", 'name: "scribe agent"', "model: 'sonnet'", "---"].join("\n");
    assert.deepEqual(parseFrontmatter(text), { name: "scribe agent", model: "sonnet" });
  });

  test("unknown keys are ignored", () => {
    const text = ["---", "name: scribe", "color: blue", "unknown-key: whatever", "---"].join("\n");
    assert.deepEqual(parseFrontmatter(text), { name: "scribe" });
  });

  test("CRLF line endings are tolerated", () => {
    const text = ["---", "name: scribe", "model: sonnet", "---", "body"].join("\r\n");
    assert.deepEqual(parseFrontmatter(text), { name: "scribe", model: "sonnet" });
  });

  test("empty file -> null", () => {
    assert.equal(parseFrontmatter(""), null);
  });
});

// ---------------------------------------------------------------------------
// Unit: scanAgentDir
// ---------------------------------------------------------------------------

describe("scanAgentDir", () => {
  let scanDir;

  before(() => {
    scanDir = mkdtempSync(join(tmpdir(), "fleetview-discovery-scan-"));
  });

  after(() => {
    if (scanDir) rmSync(scanDir, { recursive: true, force: true });
  });

  test("missing dir -> {} (never throws)", () => {
    assert.deepEqual(scanAgentDir(join(scanDir, "does-not-exist")), {});
  });

  test("non-.md files are ignored", () => {
    const dir = join(scanDir, "non-md");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "notes.txt"), "---\nname: nope\n---\n");
    writeFileSync(join(dir, "real.md"), "---\nname: real-agent\n---\n");
    assert.deepEqual(scanAgentDir(dir), { "real-agent": { label: "real-agent" } });
  });

  test("filename stem is used as name when frontmatter has no `name`", () => {
    const dir = join(scanDir, "stem-fallback");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "helper.md"), "---\nmodel: sonnet\n---\n");
    assert.deepEqual(scanAgentDir(dir), { helper: { label: "helper", model: "sonnet" } });
  });
});

// ---------------------------------------------------------------------------
// Integration: booted server (§29.3 acceptance criterion 3)
// ---------------------------------------------------------------------------

const PORT = 4856;
const BASE_URL = `http://127.0.0.1:${PORT}`;

let scratchDir;
let eventsFile;
let scratchHome;
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

function findAgent(snapshot, id) {
  return snapshot.agents.find((a) => a.id === id);
}

before(async () => {
  scratchDir = mkdtempSync(join(tmpdir(), "fleetview-discovery-"));
  eventsFile = join(scratchDir, "events.jsonl");
  scratchHome = join(scratchDir, "home");

  // Seed a discovered agent under the scratch HOME *before* the server boots
  // -- user-level discovery only scans once, at boot (§22).
  const userAgentsDir = join(scratchHome, ".claude", "agents");
  mkdirSync(userAgentsDir, { recursive: true });
  writeFileSync(join(userAgentsDir, "scribe.md"), "---\nmodel: sonnet\n---\n\nA scribe agent.\n");

  child = spawn(process.execPath, [SERVER_PATH], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      FLEET_EVENTS_FILE: eventsFile,
      HOME: scratchHome, // test seam: server's homedir()-derived boot scan hits this
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  await waitForHealthz();
});

after(() => {
  if (child) child.kill();
  if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
});

describe("resolveAgentMeta precedence (§22)", () => {
  const SESSION_ID = "discovery-session";

  test("discovered agent (no config/DEFAULT_CONFIG entry) resolves label/model/provider from ~/.claude/agents", async () => {
    const T0 = "2026-01-03T00:00:00.000Z";
    const T1 = "2026-01-03T00:00:01.000Z";

    // scribe is not a name present in the repo's fleet.config.json (that
    // file's `agents` block is trimmed to codex-runner/codex-direct) nor in
    // DEFAULT_CONFIG.agents -- only discovery can supply its meta.
    appendEvent({
      v: 1,
      source: "demo",
      t: T0,
      kind: "session.start",
      sessionId: SESSION_ID,
      cwd: REPO_ROOT,
    });
    appendEvent({
      v: 1,
      source: "demo",
      t: T1,
      kind: "agent.start",
      sessionId: SESSION_ID,
      agentId: "agent-scribe",
      agentType: "scribe",
    });

    const snap = await waitForSnapshot((s) => findAgent(s, "agent-scribe") != null);
    const agent = findAgent(snap, "agent-scribe");
    assert.equal(agent.label, "scribe");
    assert.equal(agent.model, "Claude Sonnet 5");
    assert.equal(agent.provider, "anthropic");
  });

  test("agentType present in the on-disk repo fleet.config.json still resolves from file config", async () => {
    const T0 = "2026-01-03T00:00:02.000Z";

    appendEvent({
      v: 1,
      source: "demo",
      t: T0,
      kind: "agent.start",
      sessionId: SESSION_ID,
      agentId: "agent-codex-runner",
      agentType: "codex-runner",
    });

    const snap = await waitForSnapshot((s) => findAgent(s, "agent-codex-runner") != null);
    const agent = findAgent(snap, "agent-codex-runner");
    assert.equal(agent.label, "Codex relay");
    assert.equal(agent.model, "OpenAI Codex");
    assert.equal(agent.provider, "openai");
  });

  test("codex:-prefixed sessionId with an unknown agentType gets the openai fallback accent", async () => {
    const CODEX_SESSION_ID = "codex:some-thread-id";
    const T0 = "2026-01-03T00:00:03.000Z";

    appendEvent({
      v: 1,
      source: "codex",
      t: T0,
      kind: "agent.start",
      sessionId: CODEX_SESSION_ID,
      agentId: "agent-codex-unknown",
      agentType: "totally-unrecognized-type",
    });

    const snap = await waitForSnapshot((s) => findAgent(s, "agent-codex-unknown") != null);
    const agent = findAgent(snap, "agent-codex-unknown");
    assert.equal(agent.provider, "openai");
    assert.equal(agent.label, "totally-unrecognized-type");
  });
});
