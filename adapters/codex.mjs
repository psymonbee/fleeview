// FleetView adapter: translates raw Codex CLI hook payloads into the neutral
// event schema (docs/FLEETVIEW-SPEC.md §18). Stateless and pure: never
// throws, malformed/unwanted input maps to []. Field names are verified
// against the draft-07 schemas embedded in the Codex 0.144.5 binary
// (test/fixtures/codex/schemas/ — see PROBE-NOTES.md) and, for the events
// exercised live via user-level config.toml hooks (§18.5), against real
// captured payloads. Codex tool names are Claude-style ("Bash"), so the
// hint/file heuristics below apply to Codex payloads unchanged.
//
// Every id crossing this boundary is namespaced "codex:<raw>" so a shared
// events file can never collide with claude-code session/agent ids.

const ELLIPSIS = "…";

function truncate(value, max) {
  if (typeof value !== "string") return value;
  if (value.length <= max) return value;
  return value.slice(0, max) + ELLIPSIS;
}

function ns(id) {
  return "codex:" + id;
}

function hasAgentId(payload) {
  return payload.agent_id !== undefined && payload.agent_id !== null;
}

// Shared hint/file derivation for agent.activity and session.activity (§18.3,
// §25). `Skill` gets its own case (§26): the skill name is the useful
// signal, not its args.
function activityBasics(payload) {
  const input = payload.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : {};
  const hint =
    payload.tool_name === "Skill"
      ? truncate(input.skill ?? "", 120)
      : truncate(
          input.description || input.command || input.file_path || input.prompt || "",
          120
        );
  const file = input.file_path ?? input.notebook_path;
  return { hint, file };
}

export function translate(payload, now = new Date()) {
  try {
    if (!payload || typeof payload !== "object") return [];
    if (typeof payload.session_id !== "string" || payload.session_id === "") return [];

    const base = {
      v: 1,
      source: "codex",
      t: now.toISOString(),
      sessionId: ns(payload.session_id),
    };

    switch (payload.hook_event_name) {
      case "SessionStart":
        return [
          { ...base, kind: "session.start", cwd: payload.cwd, transcriptPath: payload.transcript_path },
        ];
      case "UserPromptSubmit":
        return [{ ...base, kind: "turn.start" }];
      case "Stop":
        return [{ ...base, kind: "turn.end" }];
      case "SubagentStart":
        return [
          {
            ...base,
            kind: "agent.start",
            agentId: ns(payload.agent_id),
            agentType: payload.agent_type,
            model: payload.model,
          },
        ];
      case "SubagentStop":
        return [
          {
            ...base,
            kind: "agent.end",
            agentId: ns(payload.agent_id),
            agentType: payload.agent_type,
            finalMessage: truncate(payload.last_assistant_message, 300),
            transcriptPath: payload.agent_transcript_path,
          },
        ];
      case "PreToolUse": {
        const { hint, file } = activityBasics(payload);
        // §25: main-loop calls (no agent_id) become session.activity so the
        // hub isn't dead pre-plan — parity with the claude-code adapter.
        if (!hasAgentId(payload)) {
          const event = { ...base, kind: "session.activity", tool: payload.tool_name, hint };
          if (file !== undefined && file !== null) event.file = file;
          return [event];
        }
        const event = {
          ...base,
          kind: "agent.activity",
          agentId: ns(payload.agent_id),
          phase: "start",
          callId: payload.tool_use_id,
          tool: payload.tool_name,
          hint,
        };
        if (file !== undefined && file !== null) event.file = file;
        return [event];
      }
      case "PostToolUse": {
        if (!hasAgentId(payload)) return [];
        return [
          {
            ...base,
            kind: "agent.activity",
            agentId: ns(payload.agent_id),
            phase: "end",
            callId: payload.tool_use_id,
            tool: payload.tool_name,
          },
        ];
      }
      // §28c / §25: closes §18.3's previously-unmapped rows. PermissionRequest
      // has no tool_use_id (and likely never fires in exec mode) so it can't
      // be an agent.activity — it becomes a session-level activity line
      // naming the tool the permission is for.
      case "PermissionRequest":
        return [
          {
            ...base,
            kind: "session.activity",
            tool: "permission",
            hint: truncate(payload.tool_name ?? "", 120),
          },
        ];
      case "PreCompact":
        return [{ ...base, kind: "session.activity", tool: "compact", hint: "pre" }];
      case "PostCompact":
        return [{ ...base, kind: "session.activity", tool: "compact", hint: "post" }];
      default:
        return [];
    }
  } catch {
    return [];
  }
}

// notify payloads arrive via argv, not stdin, with kebab-case fields —
// live-captured shape in test/fixtures/codex/notify-turn-ended.json.
export function translateNotify(payload, now = new Date()) {
  try {
    if (!payload || typeof payload !== "object") return [];
    if (payload.type !== "agent-turn-complete") return [];
    const threadId = payload["thread-id"];
    if (typeof threadId !== "string" || threadId === "") return [];

    return [
      {
        v: 1,
        source: "codex",
        t: now.toISOString(),
        sessionId: ns(threadId),
        kind: "turn.end",
      },
    ];
  } catch {
    return [];
  }
}
