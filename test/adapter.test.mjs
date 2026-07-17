// Adapter test suite (docs/FLEETVIEW-SPEC.md §16.1). Zero deps: node:test +
// node:assert only. Loads every fixture in test/fixtures/ (real captured
// Claude Code hook payloads, plus one synthetic ExitPlanMode fixture) and
// asserts the adapter's neutral-event output against the mapping table in
// spec §9.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { translate } from "../adapters/claude-code.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "fixtures");

function loadFixture(name) {
  const raw = readFileSync(join(FIXTURES_DIR, name), "utf8");
  return JSON.parse(raw);
}

function assertValidEnvelope(event) {
  assert.equal(event.v, 1);
  assert.equal(event.source, "claude-code");
  assert.equal(typeof event.t, "string");
  assert.equal(new Date(event.t).toISOString(), event.t, `t should be ISO 8601: ${event.t}`);
  assert.equal(typeof event.kind, "string");
  assert.ok(event.kind.length > 0);
  assert.ok("sessionId" in event);
}

describe("adapters/claude-code.mjs — envelope", () => {
  const fixtureNames = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json"));

  test("every fixture in test/fixtures/ produces events with a valid envelope", () => {
    for (const name of fixtureNames) {
      const payload = loadFixture(name);
      const events = translate(payload);
      assert.ok(Array.isArray(events), `${name}: translate() must return an array`);
      for (const event of events) {
        assertValidEnvelope(event);
      }
    }
  });

  test("no fixture ever throws", () => {
    for (const name of fixtureNames) {
      const payload = loadFixture(name);
      assert.doesNotThrow(() => translate(payload), `${name} should never throw`);
    }
  });
});

describe("adapters/claude-code.mjs — per-fixture mapping", () => {
  test("post-taskcreate.json -> plan.step from tool_response.task.id", () => {
    const events = translate(loadFixture("post-taskcreate.json"));
    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event.kind, "plan.step");
    assert.equal(event.stepId, "1");
    assert.equal(event.subject, "S1: Raw payload probe gate");
    assert.equal(event.status, "pending");
  });

  test("pre-taskcreate.json (PreToolUse TaskCreate is unmapped) -> []", () => {
    const events = translate(loadFixture("pre-taskcreate.json"));
    assert.deepEqual(events, []);
  });

  test("post-taskupdate.json (PostToolUse TaskUpdate is unmapped) -> []", () => {
    const events = translate(loadFixture("post-taskupdate.json"));
    assert.deepEqual(events, []);
  });

  test("pre-taskupdate.json -> plan.step with status mapped in_progress -> active", () => {
    const events = translate(loadFixture("pre-taskupdate.json"));
    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event.kind, "plan.step");
    assert.equal(event.stepId, "1");
    assert.equal(event.status, "active");
    assert.equal(event.deleted, undefined);
  });

  test("pre-bash-failing-agent.json -> single phase:start activity with callId", () => {
    const events = translate(loadFixture("pre-bash-failing-agent.json"));
    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event.kind, "agent.activity");
    assert.equal(event.phase, "start");
    assert.equal(event.agentId, "a3912fb66b59d81d4");
    assert.equal(event.tool, "Bash");
    assert.equal(event.callId, "toolu_0188w8tfhzsGBZezUKQTsyrQ");
    assert.equal(event.hint, "Probe: cat a nonexistent file (expected failure)");
  });

  test("post-bash-ok-agent.json -> phase:end activity with callId and ms", () => {
    const events = translate(loadFixture("post-bash-ok-agent.json"));
    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event.kind, "agent.activity");
    assert.equal(event.phase, "end");
    assert.equal(event.agentId, "a3912fb66b59d81d4");
    assert.equal(event.tool, "Bash");
    assert.equal(event.callId, "toolu_01QZK9eubxRQNqMDW6DcDGrF");
    assert.equal(event.ms, 14);
  });

  test("pre-read-agent.json -> phase:start activity carrying file from file_path", () => {
    const events = translate(loadFixture("pre-read-agent.json"));
    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event.kind, "agent.activity");
    assert.equal(event.phase, "start");
    assert.equal(event.tool, "Read");
    assert.equal(event.file, "/Users/simon/lumenADE/package.json");
    assert.equal(event.hint, "/Users/simon/lumenADE/package.json");
  });

  test("post-read-agent.json -> phase:end activity", () => {
    const events = translate(loadFixture("post-read-agent.json"));
    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event.kind, "agent.activity");
    assert.equal(event.phase, "end");
    assert.equal(event.tool, "Read");
    assert.equal(event.ms, 1);
  });

  test("pre-agent-spawn.json -> agent.spawn-pending, legacy fuzzy claim (no agentId)", () => {
    const events = translate(loadFixture("pre-agent-spawn.json"));
    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event.kind, "agent.spawn-pending");
    assert.equal(event.agentType, "claude");
    assert.equal(event.description, "Probe: failing bash in subagent");
    assert.equal(event.agentId, undefined);
  });

  test("post-agent-spawn.json -> agent.spawn-pending exact-claim with agentId and model", () => {
    const events = translate(loadFixture("post-agent-spawn.json"));
    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event.kind, "agent.spawn-pending");
    assert.equal(event.agentId, "a3912fb66b59d81d4");
    assert.equal(event.model, "claude-fable-5");
    assert.equal(event.agentType, "claude");
    assert.equal(event.description, "Probe: failing bash in subagent");
  });

  test("subagent-start.json -> agent.start with agentId/agentType only", () => {
    const events = translate(loadFixture("subagent-start.json"));
    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event.kind, "agent.start");
    assert.equal(event.agentId, "a3912fb66b59d81d4");
    assert.equal(event.agentType, "claude");
  });

  test("subagent-stop.json -> agent.end with finalMessage and transcriptPath", () => {
    const events = translate(loadFixture("subagent-stop.json"));
    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event.kind, "agent.end");
    assert.equal(event.agentId, "a3912fb66b59d81d4");
    assert.equal(event.agentType, "claude");
    assert.equal(
      event.finalMessage,
      "All three probe steps executed: the cat failed as expected, echo passed, and package.json was read.\n\nresult: Probe complete: one failing bash, one passing bash, one read."
    );
    assert.equal(
      event.transcriptPath,
      "/Users/simon/.claude/projects/-Users-simon-lumenADE/9d4c8bcd-616a-4a61-a54f-dce98d158d04/subagents/agent-a3912fb66b59d81d4.jsonl"
    );
  });

  test("pre-exitplanmode-SYNTHETIC.json -> plan.doc with markdown", () => {
    const events = translate(loadFixture("pre-exitplanmode-SYNTHETIC.json"));
    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event.kind, "plan.doc");
    assert.ok(event.markdown.startsWith("## Add `/version` endpoint"));
  });
});

describe("adapters/claude-code.mjs — edge cases", () => {
  test("garbage string payload -> []", () => {
    assert.deepEqual(translate("garbage"), []);
  });

  test("null payload -> []", () => {
    assert.deepEqual(translate(null), []);
  });

  test("empty object payload -> []", () => {
    assert.deepEqual(translate({}), []);
  });

  test("unknown hook_event_name -> []", () => {
    assert.deepEqual(
      translate({ hook_event_name: "SomeFutureHook", session_id: "s1" }),
      []
    );
  });

  test("PreToolUse Read without agent_id -> session.activity (§25, was [] pre-v4)", () => {
    const payload = {
      session_id: "s1",
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: { file_path: "/tmp/foo.txt" },
      tool_use_id: "toolu_x",
    };
    const events = translate(payload);
    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event.kind, "session.activity");
    assert.equal(event.tool, "Read");
    assert.equal(event.hint, "/tmp/foo.txt");
    assert.equal(event.file, "/tmp/foo.txt");
  });

  test("PostToolUse Agent without agent_id and without tool_response.agentId (sync spawn completing) -> []", () => {
    const payload = {
      session_id: "s1",
      hook_event_name: "PostToolUse",
      tool_name: "Agent",
      tool_input: { description: "d", subagent_type: "claude" },
      tool_response: { result: "done, no agentId here" },
    };
    assert.deepEqual(translate(payload), []);
  });

  test("undefined/number/array payloads never throw and yield []", () => {
    for (const bad of [undefined, 42, [], true]) {
      assert.doesNotThrow(() => translate(bad));
      assert.deepEqual(translate(bad), []);
    }
  });
});

describe("adapters/claude-code.mjs — truncation", () => {
  test("agent.spawn-pending description truncated at 300 chars with … suffix", () => {
    const longDescription = "x".repeat(400);
    const payload = {
      session_id: "s1",
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: { description: longDescription, subagent_type: "claude" },
    };
    const [event] = translate(payload);
    assert.equal(event.description.length, 301);
    assert.ok(event.description.endsWith("…"));
    assert.equal(event.description.slice(0, 300), "x".repeat(300));
  });

  test("agent.activity hint truncated at 120 chars with … suffix", () => {
    const longDescription = "y".repeat(200);
    const payload = {
      session_id: "s1",
      agent_id: "a1",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { description: longDescription, command: "echo hi" },
      tool_use_id: "toolu_y",
    };
    const [event] = translate(payload);
    assert.equal(event.hint.length, 121);
    assert.ok(event.hint.endsWith("…"));
  });

  test("plan.doc markdown truncated at 4000 chars with … suffix", () => {
    const longPlan = "z".repeat(5000);
    const payload = {
      session_id: "s1",
      hook_event_name: "PreToolUse",
      tool_name: "ExitPlanMode",
      tool_input: { plan: longPlan },
    };
    const [event] = translate(payload);
    assert.equal(event.markdown.length, 4001);
    assert.ok(event.markdown.endsWith("…"));
  });

  test("agent.end finalMessage truncated at 300 chars with … suffix", () => {
    const longMessage = "w".repeat(400);
    const payload = {
      session_id: "s1",
      agent_id: "a1",
      agent_type: "claude",
      hook_event_name: "SubagentStop",
      last_assistant_message: longMessage,
      agent_transcript_path: "/tmp/x.jsonl",
    };
    const [event] = translate(payload);
    assert.equal(event.finalMessage.length, 301);
    assert.ok(event.finalMessage.endsWith("…"));
  });

  test("plan.step subject truncated at 200 chars with … suffix (TaskCreate)", () => {
    const longSubject = "v".repeat(250);
    const payload = {
      session_id: "s1",
      hook_event_name: "PostToolUse",
      tool_name: "TaskCreate",
      tool_input: { subject: longSubject },
      tool_response: { task: { id: "7" } },
    };
    const [event] = translate(payload);
    assert.equal(event.subject.length, 201);
    assert.ok(event.subject.endsWith("…"));
  });

  test("strings at or under the limit are left untouched (no truncation)", () => {
    const exact = "a".repeat(120);
    const payload = {
      session_id: "s1",
      agent_id: "a1",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { description: exact },
      tool_use_id: "toolu_z",
    };
    const [event] = translate(payload);
    assert.equal(event.hint, exact);
    assert.ok(!event.hint.endsWith("…"));
  });
});

describe("adapters/claude-code.mjs — never-throws / whitelist guarantees", () => {
  test("blacklisted fields are never forwarded", () => {
    const payload = {
      session_id: "s1",
      hook_event_name: "SessionStart",
      cwd: "/tmp/proj",
      transcript_path: "/tmp/t.jsonl",
      permission_mode: "auto",
      effort: { level: "xhigh" },
      prompt_id: "should-not-appear",
    };
    const [event] = translate(payload);
    assert.equal(event.permission_mode, undefined);
    assert.equal(event.effort, undefined);
    assert.equal(event.prompt_id, undefined);
  });

  test("SessionStart -> session.start with cwd and transcriptPath", () => {
    const payload = {
      session_id: "s1",
      hook_event_name: "SessionStart",
      cwd: "/tmp/proj",
      transcript_path: "/tmp/t.jsonl",
    };
    const [event] = translate(payload);
    assert.equal(event.kind, "session.start");
    assert.equal(event.cwd, "/tmp/proj");
    assert.equal(event.transcriptPath, "/tmp/t.jsonl");
  });

  test("SessionEnd / UserPromptSubmit / Stop map to bare turn/session events", () => {
    assert.equal(
      translate({ session_id: "s1", hook_event_name: "SessionEnd" })[0].kind,
      "session.end"
    );
    assert.equal(
      translate({ session_id: "s1", hook_event_name: "UserPromptSubmit" })[0].kind,
      "turn.start"
    );
    assert.equal(translate({ session_id: "s1", hook_event_name: "Stop" })[0].kind, "turn.end");
  });

  test("mcp__codex__* PreToolUse without agent_id -> agent.start codex-direct", () => {
    const payload = {
      session_id: "s1",
      hook_event_name: "PreToolUse",
      tool_name: "mcp__codex__codex",
      tool_input: { prompt: "do the thing" },
      tool_use_id: "toolu_codex1",
    };
    const [event] = translate(payload);
    assert.equal(event.kind, "agent.start");
    assert.equal(event.agentType, "codex-direct");
    assert.equal(event.agentId, "toolu_codex1");
    assert.equal(event.description, "do the thing");
  });

  test("mcp__codex__* PostToolUse without agent_id -> agent.end codex-direct", () => {
    const payload = {
      session_id: "s1",
      hook_event_name: "PostToolUse",
      tool_name: "mcp__codex__codex-reply",
      tool_input: {},
      tool_use_id: "toolu_codex1",
    };
    const [event] = translate(payload);
    assert.equal(event.kind, "agent.end");
    assert.equal(event.agentType, "codex-direct");
    assert.equal(event.agentId, "toolu_codex1");
  });
});

describe("v3 subject backfill — subagent task tools also emit plan.step (§20)", () => {
  test("subagent TaskCreate Post -> [activity end, plan.step with subject]", () => {
    const payload = {
      session_id: "s1",
      hook_event_name: "PostToolUse",
      agent_id: "a1",
      tool_name: "TaskCreate",
      tool_input: { subject: "Wire the SSE endpoint" },
      tool_response: { task: { id: "9" } },
      tool_use_id: "toolu_tc1",
      duration_ms: 12,
    };
    const events = translate(payload);
    assert.equal(events.length, 2);
    assert.equal(events[0].kind, "agent.activity");
    assert.equal(events[0].phase, "end");
    assert.equal(events[0].agentId, "a1");
    assert.equal(events[1].kind, "plan.step");
    assert.equal(events[1].stepId, "9");
    assert.equal(events[1].subject, "Wire the SSE endpoint");
    assert.equal(events[1].status, "pending");
  });

  test("subagent TaskCreate Post without tool_response.task.id -> activity only", () => {
    const payload = {
      session_id: "s1",
      hook_event_name: "PostToolUse",
      agent_id: "a1",
      tool_name: "TaskCreate",
      tool_input: { subject: "Orphan" },
      tool_response: {},
      tool_use_id: "toolu_tc2",
    };
    const events = translate(payload);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "agent.activity");
  });

  test("subagent TaskUpdate Pre -> [activity start, plan.step with mapped status]", () => {
    const payload = {
      session_id: "s1",
      hook_event_name: "PreToolUse",
      agent_id: "a1",
      tool_name: "TaskUpdate",
      tool_input: { taskId: "9", status: "in_progress" },
      tool_use_id: "toolu_tu1",
    };
    const events = translate(payload);
    assert.equal(events.length, 2);
    assert.equal(events[0].kind, "agent.activity");
    assert.equal(events[0].phase, "start");
    assert.equal(events[1].kind, "plan.step");
    assert.equal(events[1].stepId, "9");
    assert.equal(events[1].status, "active");
  });

  test("subagent TaskUpdate Pre with subject carries it (untitled-step backfill)", () => {
    const payload = {
      session_id: "s1",
      hook_event_name: "PreToolUse",
      agent_id: "a1",
      tool_name: "TaskUpdate",
      tool_input: { taskId: "9", subject: "Now titled" },
      tool_use_id: "toolu_tu2",
    };
    const events = translate(payload);
    assert.equal(events.length, 2);
    assert.equal(events[1].kind, "plan.step");
    assert.equal(events[1].subject, "Now titled");
  });

  test("subagent TaskUpdate Pre with nothing mappable -> activity only", () => {
    const payload = {
      session_id: "s1",
      hook_event_name: "PreToolUse",
      agent_id: "a1",
      tool_name: "TaskUpdate",
      tool_input: { taskId: "9" },
      tool_use_id: "toolu_tu3",
    };
    const events = translate(payload);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "agent.activity");
  });
});

describe("§24 nested-spawn lineage (live captures, test/fixtures/nested-*.json)", () => {
  test("nested-pre-agent-spawn.json -> [agent.activity start, fuzzy spawn-pending with parentAgentId, no agentId]", () => {
    const events = translate(loadFixture("nested-pre-agent-spawn.json"));
    assert.equal(events.length, 2);

    const [activity, spawnPending] = events;
    assert.equal(activity.kind, "agent.activity");
    assert.equal(activity.phase, "start");
    assert.equal(activity.agentId, "ac87ff2ff3d145aad");
    assert.equal(activity.tool, "Agent");
    assert.equal(activity.callId, "toolu_011e3CYvK9MoZyXPfrFoU4hE");
    assert.equal(activity.hint, "Read note.txt");

    assert.equal(spawnPending.kind, "agent.spawn-pending");
    assert.equal(spawnPending.agentType, "general-purpose");
    assert.equal(spawnPending.description, "Read note.txt");
    assert.equal(spawnPending.parentAgentId, "ac87ff2ff3d145aad");
    assert.equal(spawnPending.agentId, undefined, "fuzzy claim has no child agentId yet");
  });

  test("nested-post-agent-spawn.json -> [agent.activity end, exact spawn-pending with agentId+parentAgentId+model]", () => {
    const events = translate(loadFixture("nested-post-agent-spawn.json"));
    assert.equal(events.length, 2);

    const [activity, spawnPending] = events;
    assert.equal(activity.kind, "agent.activity");
    assert.equal(activity.phase, "end");
    assert.equal(activity.agentId, "ac87ff2ff3d145aad");
    assert.equal(activity.tool, "Agent");
    assert.equal(activity.ms, 7306);

    assert.equal(spawnPending.kind, "agent.spawn-pending");
    assert.equal(spawnPending.agentId, "a035ab21c1995b9cd");
    assert.equal(spawnPending.parentAgentId, "ac87ff2ff3d145aad");
    assert.equal(spawnPending.agentType, "general-purpose");
    assert.equal(spawnPending.description, "Read note.txt");
    assert.equal(spawnPending.model, "claude-opus-4-8[1m]");
  });

  test("nested-subagent-start.json -> plain agent.start (no parent field on the payload)", () => {
    const events = translate(loadFixture("nested-subagent-start.json"));
    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event.kind, "agent.start");
    assert.equal(event.agentId, "a035ab21c1995b9cd");
    assert.equal(event.agentType, "general-purpose");
    assert.equal(event.parentAgentId, undefined);
  });

  test("nested-subagent-stop.json -> agent.end with finalMessage + transcriptPath", () => {
    const events = translate(loadFixture("nested-subagent-stop.json"));
    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event.kind, "agent.end");
    assert.equal(event.agentId, "a035ab21c1995b9cd");
    assert.equal(event.agentType, "general-purpose");
    assert.equal(event.finalMessage, "The exact contents of note.txt:\n\n```\nnested-ok\n```");
    assert.equal(
      event.transcriptPath,
      "/Users/simon/.claude/projects/-Users-simon-nested-probe/2ae08aee-7038-49f8-80d0-9c4d4ad4d346/subagents/agent-a035ab21c1995b9cd.jsonl"
    );
  });
});

describe("§25 session.activity — pre-plan orchestrator", () => {
  test("main-loop Read Pre (no agent_id) -> exactly one session.activity", () => {
    const payload = {
      session_id: "s1",
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: { file_path: "/tmp/mainloop-read.txt" },
      tool_use_id: "toolu_mainloop_read",
    };
    const events = translate(payload);
    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event.kind, "session.activity");
    assert.equal(event.tool, "Read");
    assert.equal(event.hint, "/tmp/mainloop-read.txt");
    assert.equal(event.file, "/tmp/mainloop-read.txt");
  });

  test("main-loop Agent Pre (no agent_id) -> spawn-pending only, no session.activity", () => {
    const payload = {
      session_id: "s1",
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: { description: "Spawn a worker", subagent_type: "builder" },
    };
    const events = translate(payload);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "agent.spawn-pending");
    assert.ok(
      events.every((e) => e.kind !== "session.activity"),
      "no session.activity alongside a top-level spawn-pending"
    );
  });

  test("main-loop plain Post (no agent_id) -> []", () => {
    const payload = {
      session_id: "s1",
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_input: { file_path: "/tmp/mainloop-read.txt" },
      tool_response: { content: "hi" },
      tool_use_id: "toolu_mainloop_read",
      duration_ms: 3,
    };
    assert.deepEqual(translate(payload), []);
  });

  test("main-loop TaskCreate Pre stays excluded (unmapped, not session.activity)", () => {
    const events = translate(loadFixture("pre-taskcreate.json"));
    assert.deepEqual(events, []);
  });
});

describe("§26 Skill hint", () => {
  test("Skill Pre with agent_id -> agent.activity hint = skill name", () => {
    const payload = {
      session_id: "s1",
      agent_id: "a1",
      hook_event_name: "PreToolUse",
      tool_name: "Skill",
      tool_input: { skill: "verify", args: "run the checks" },
      tool_use_id: "toolu_skill1",
    };
    const events = translate(payload);
    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event.kind, "agent.activity");
    assert.equal(event.tool, "Skill");
    assert.equal(event.hint, "verify");
  });

  test("Skill Pre without agent_id -> session.activity hint = skill name", () => {
    const payload = {
      session_id: "s1",
      hook_event_name: "PreToolUse",
      tool_name: "Skill",
      tool_input: { skill: "deep-research", args: "topic" },
    };
    const events = translate(payload);
    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event.kind, "session.activity");
    assert.equal(event.hint, "deep-research");
  });
});
