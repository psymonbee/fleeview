// Codex adapter test suite (docs/FLEETVIEW-SPEC.md §18). Fixtures without a
// suffix are real payloads captured live via user-level config.toml hooks
// (§18.5, probes of 2026-07-19; paths sanitized). Fixtures marked -SYNTHETIC
// are schema-exact shapes with fabricated values for the events no probe has
// fired yet (subagents, compaction, permission requests). Every payload
// fixture is validated against the binary-extracted schema's `required` +
// `properties` lists so field drift fails loudly. notify-turn-ended.json is
// a live capture of the separate notify mechanism (argv, not stdin).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { translate, translateNotify } from "../adapters/codex.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "fixtures", "codex");
const SCHEMAS_DIR = join(FIXTURES_DIR, "schemas");

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function loadFixture(name) {
  return loadJson(join(FIXTURES_DIR, name));
}

// Every hook-payload fixture, live-captured and synthetic alike; the notify
// capture is excluded (different mechanism, different shape).
const payloadFixtures = readdirSync(FIXTURES_DIR).filter(
  (f) => f.endsWith(".json") && f !== "notify-turn-ended.json"
);

// hook_event_name -> schema basename (PascalCase -> kebab-case)
function schemaFor(hookEventName) {
  const kebab = hookEventName.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  return loadJson(join(SCHEMAS_DIR, `${kebab}.command.input.json`));
}

describe("codex fixtures match the binary-extracted schemas", () => {
  for (const name of payloadFixtures) {
    test(`${name} carries every schema-required field`, () => {
      const fixture = loadFixture(name);
      const schema = schemaFor(fixture.hook_event_name);
      assert.equal(schema.properties.hook_event_name.const, fixture.hook_event_name);
      for (const field of schema.required) {
        assert.ok(field in fixture, `${name} missing required field ${field}`);
      }
      // additionalProperties is false in every schema — a fixture field the
      // schema doesn't know about means the fixture (or our reading) drifted.
      for (const field of Object.keys(fixture)) {
        assert.ok(field in schema.properties, `${name} has unknown field ${field}`);
      }
    });
  }
});

describe("codex adapter envelope", () => {
  for (const name of payloadFixtures) {
    test(`${name} -> v1 envelope, source codex, namespaced sessionId`, () => {
      const events = translate(loadFixture(name));
      assert.ok(Array.isArray(events));
      for (const event of events) {
        assert.equal(event.v, 1);
        assert.equal(event.source, "codex");
        assert.ok(!Number.isNaN(Date.parse(event.t)), "t is ISO");
        assert.ok(event.sessionId.startsWith("codex:"), "sessionId namespaced");
        if (event.agentId !== undefined && event.agentId !== null) {
          assert.ok(event.agentId.startsWith("codex:"), "agentId namespaced");
        }
      }
    });
  }
});

describe("codex adapter mapping (§18.3)", () => {
  test("session-start (live capture) -> session.start with cwd + transcriptPath", () => {
    const events = translate(loadFixture("session-start.json"));
    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event.kind, "session.start");
    assert.equal(event.cwd, "/Users/user");
    assert.ok(event.transcriptPath.endsWith(".jsonl"));
  });

  test("user-prompt-submit (live capture) -> turn.start", () => {
    const events = translate(loadFixture("user-prompt-submit.json"));
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "turn.start");
  });

  test("stop (live capture) -> turn.end", () => {
    const events = translate(loadFixture("stop.json"));
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "turn.end");
  });

  test("subagent-start -> agent.start with namespaced id, type, model", () => {
    const events = translate(loadFixture("subagent-start-SYNTHETIC.json"));
    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event.kind, "agent.start");
    assert.equal(event.agentId, "codex:019f0000-cccc-7000-8000-000000000003");
    assert.equal(event.agentType, "worker");
    assert.equal(event.model, "gpt-5.5");
  });

  test("subagent-stop -> agent.end with finalMessage + transcriptPath", () => {
    const events = translate(loadFixture("subagent-stop-SYNTHETIC.json"));
    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event.kind, "agent.end");
    assert.equal(event.agentId, "codex:019f0000-cccc-7000-8000-000000000003");
    assert.equal(event.finalMessage, "Subtask complete: refactored the parser.");
    assert.ok(event.transcriptPath.includes("rollout-"));
  });

  test("pre-tool-use with agent_id -> phase:start activity with callId + hint", () => {
    const events = translate(loadFixture("pre-tool-use-agent-SYNTHETIC.json"));
    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event.kind, "agent.activity");
    assert.equal(event.phase, "start");
    assert.equal(event.callId, "exec-00000000-0000-4000-8000-000000000001");
    assert.equal(event.tool, "Bash");
    assert.equal(event.hint, "Run the unit tests");
  });

  test("post-tool-use with agent_id -> phase:end activity", () => {
    const events = translate(loadFixture("post-tool-use-agent-SYNTHETIC.json"));
    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event.kind, "agent.activity");
    assert.equal(event.phase, "end");
    assert.equal(event.callId, "exec-00000000-0000-4000-8000-000000000001");
  });

  test("main-loop pre-tool-use (live capture, no agent_id) -> session.activity (§25 parity)", () => {
    const events = translate(loadFixture("pre-tool-use-mainloop.json"));
    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event.kind, "session.activity");
    assert.equal(event.tool, "Bash");
    assert.equal(event.hint, "echo probe");
    assert.equal(event.sessionId, "codex:019f7ba3-31e6-7e10-b4a2-21cb760d927e");
  });

  test("main-loop post-tool-use (live capture, no agent_id) -> [] (§18.3)", () => {
    const events = translate(loadFixture("post-tool-use-mainloop.json"));
    assert.deepEqual(events, []);
  });

  test("permission-request -> session.activity {tool:'permission', hint: tool_name} (§28c)", () => {
    const events = translate(loadFixture("permission-request-SYNTHETIC.json"));
    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event.kind, "session.activity");
    assert.equal(event.tool, "permission");
    assert.equal(event.hint, "Bash");
  });

  test("pre-compact -> session.activity {tool:'compact', hint:'pre'} (§28c)", () => {
    const events = translate(loadFixture("pre-compact-SYNTHETIC.json"));
    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event.kind, "session.activity");
    assert.equal(event.tool, "compact");
    assert.equal(event.hint, "pre");
  });

  test("post-compact -> session.activity {tool:'compact', hint:'post'} (§28c)", () => {
    const events = translate(loadFixture("post-compact-SYNTHETIC.json"));
    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event.kind, "session.activity");
    assert.equal(event.tool, "compact");
    assert.equal(event.hint, "post");
  });
});

describe("codex adapter never throws / rejects garbage", () => {
  test("null / string / number / array / empty object -> []", () => {
    assert.deepEqual(translate(null), []);
    assert.deepEqual(translate("garbage"), []);
    assert.deepEqual(translate(42), []);
    assert.deepEqual(translate([]), []);
    assert.deepEqual(translate({}), []);
  });

  test("missing or empty session_id -> []", () => {
    assert.deepEqual(translate({ hook_event_name: "Stop" }), []);
    assert.deepEqual(translate({ hook_event_name: "Stop", session_id: "" }), []);
  });

  test("unknown hook_event_name -> []", () => {
    assert.deepEqual(
      translate({ hook_event_name: "SomethingNew", session_id: "s1" }),
      []
    );
  });
});

describe("translateNotify (live-captured shape)", () => {
  test("real captured payload -> one turn.end for codex:<thread-id>", () => {
    const capture = loadFixture("notify-turn-ended.json");
    const payload = JSON.parse(capture.__argv[1]);
    const events = translateNotify(payload);
    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event.kind, "turn.end");
    assert.equal(event.source, "codex");
    assert.equal(event.sessionId, "codex:019f6dea-3ae6-7111-be5c-94005ae61023");
  });

  test("wrong type / missing thread-id / garbage -> []", () => {
    assert.deepEqual(translateNotify({ type: "something-else", "thread-id": "x" }), []);
    assert.deepEqual(translateNotify({ type: "agent-turn-complete" }), []);
    assert.deepEqual(translateNotify(null), []);
    assert.deepEqual(translateNotify("garbage"), []);
  });
});
