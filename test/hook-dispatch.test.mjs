// Hook argv-dispatch suite (docs/FLEETVIEW-SPEC.md §18.4). Spawns the real
// hooks/emit-event.mjs with a scratch FLEET_EVENTS_FILE. The no-arg default
// must behave exactly like v2 (the live wiring passes no argument), and
// codex-notify must never read stdin (a held-open stdin must not hang it).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, "..", "hooks", "emit-event.mjs");
const FIXTURES = join(__dirname, "fixtures");

function scratchFile() {
  return join(mkdtempSync(join(tmpdir(), "fleetview-hook-test-")), "events.jsonl");
}

function runHook({ args = [], input, env = {} } = {}) {
  const eventsFile = scratchFile();
  const result = spawnSync(process.execPath, [HOOK, ...args], {
    input,
    encoding: "utf8",
    timeout: 5000,
    env: { ...process.env, FLEET_EVENTS_FILE: eventsFile, ...env },
  });
  const lines = existsSync(eventsFile)
    ? readFileSync(eventsFile, "utf8").trim().split("\n").filter(Boolean)
    : [];
  rmSync(dirname(eventsFile), { recursive: true, force: true });
  return { result, lines };
}

describe("hook dispatch — claude-code default (no argv arg)", () => {
  test("SubagentStart fixture appends one claude-code agent.start line", () => {
    const fixture = readFileSync(join(FIXTURES, "subagent-start.json"), "utf8");
    const { result, lines } = runHook({ input: fixture });
    assert.equal(result.status, 0);
    assert.equal(lines.length, 1);
    const event = JSON.parse(lines[0]);
    assert.equal(event.v, 1);
    assert.equal(event.source, "claude-code");
    assert.equal(event.kind, "agent.start");
  });

  test("garbage stdin exits 0 and writes nothing", () => {
    const { result, lines } = runHook({ input: "not json {{" });
    assert.equal(result.status, 0);
    assert.equal(lines.length, 0);
  });
});

describe("hook dispatch — codex mode", () => {
  test("subagent-start-SYNTHETIC appends a source:codex line with namespaced ids", () => {
    const fixture = readFileSync(
      join(FIXTURES, "codex", "subagent-start-SYNTHETIC.json"),
      "utf8"
    );
    const { result, lines } = runHook({ args: ["codex"], input: fixture });
    assert.equal(result.status, 0);
    assert.equal(lines.length, 1);
    const event = JSON.parse(lines[0]);
    assert.equal(event.source, "codex");
    assert.equal(event.kind, "agent.start");
    assert.ok(event.sessionId.startsWith("codex:"));
    assert.ok(event.agentId.startsWith("codex:"));
  });

  test("unmapped codex event (pre-compact) writes nothing, exits 0", () => {
    const fixture = readFileSync(
      join(FIXTURES, "codex", "pre-compact-SYNTHETIC.json"),
      "utf8"
    );
    const { result, lines } = runHook({ args: ["codex"], input: fixture });
    assert.equal(result.status, 0);
    assert.equal(lines.length, 0);
  });
});

describe("hook dispatch — codex-notify mode", () => {
  const capture = JSON.parse(
    readFileSync(join(FIXTURES, "codex", "notify-turn-ended.json"), "utf8")
  );
  const notifyJson = capture.__argv[1]; // the genuine argv payload string

  test("payload in argv appends one turn.end line", () => {
    const { result, lines } = runHook({ args: ["codex-notify", notifyJson] });
    assert.equal(result.status, 0);
    assert.equal(lines.length, 1);
    const event = JSON.parse(lines[0]);
    assert.equal(event.kind, "turn.end");
    assert.equal(event.source, "codex");
    assert.ok(event.sessionId.startsWith("codex:"));
  });

  test("does not read stdin — exits promptly with stdin held open", async () => {
    const eventsFile = scratchFile();
    const child = spawn(process.execPath, [HOOK, "codex-notify", notifyJson], {
      stdio: ["pipe", "ignore", "ignore"],
      env: { ...process.env, FLEET_EVENTS_FILE: eventsFile },
    });
    // Deliberately never write to or close child.stdin.
    const exited = await new Promise((resolveExit) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolveExit(false);
      }, 3000);
      child.on("exit", () => {
        clearTimeout(timer);
        resolveExit(true);
      });
    });
    assert.ok(exited, "hook must exit without waiting on stdin");
    const lines = readFileSync(eventsFile, "utf8").trim().split("\n").filter(Boolean);
    rmSync(dirname(eventsFile), { recursive: true, force: true });
    assert.equal(lines.length, 1);
  });

  test("missing payload argument writes nothing, exits 0", () => {
    const { result, lines } = runHook({ args: ["codex-notify"] });
    assert.equal(result.status, 0);
    assert.equal(lines.length, 0);
  });
});

describe("hook dispatch — guards", () => {
  test("unknown adapter arg writes nothing, exits 0", () => {
    const fixture = readFileSync(join(FIXTURES, "subagent-start.json"), "utf8");
    const { result, lines } = runHook({ args: ["mystery-harness"], input: fixture });
    assert.equal(result.status, 0);
    assert.equal(lines.length, 0);
  });

  test("FLEET_IGNORE=1 writes nothing in every mode", () => {
    const claudeFixture = readFileSync(join(FIXTURES, "subagent-start.json"), "utf8");
    const codexFixture = readFileSync(
      join(FIXTURES, "codex", "subagent-start-SYNTHETIC.json"),
      "utf8"
    );
    const capture = JSON.parse(
      readFileSync(join(FIXTURES, "codex", "notify-turn-ended.json"), "utf8")
    );
    const cases = [
      { input: claudeFixture },
      { args: ["codex"], input: codexFixture },
      { args: ["codex-notify", capture.__argv[1]] },
    ];
    for (const c of cases) {
      const { result, lines } = runHook({ ...c, env: { FLEET_IGNORE: "1" } });
      assert.equal(result.status, 0);
      assert.equal(lines.length, 0);
    }
  });
});
