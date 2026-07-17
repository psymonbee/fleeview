// FleetView adapter: translates raw Claude Code hook payloads into the
// neutral event schema (docs/FLEETVIEW-SPEC.md §8-§9). Stateless and pure:
// never throws, malformed/unwanted input maps to []. All filtering and
// truncation policy lives here — the hook (hooks/emit-event.mjs) keeps zero
// policy. Fields are whitelisted explicitly; there is no blacklist, so
// `permission_mode` / `effort` / `prompt_id` / `transcript_path` (on tool
// events) are simply never read, let alone forwarded.

const ELLIPSIS = "…";

function truncate(value, max) {
  if (typeof value !== "string") return value;
  if (value.length <= max) return value;
  return value.slice(0, max) + ELLIPSIS;
}

const STATUS_MAP = {
  pending: "pending",
  in_progress: "active",
  completed: "done",
};

function hasAgentId(payload) {
  return payload.agent_id !== undefined && payload.agent_id !== null;
}

// Shared hint/file derivation for agent.activity and session.activity (§9,
// §25). `Skill` gets its own case (§26): the skill name is the useful
// signal, not its args.
function activityBasics(toolName, input) {
  const hint =
    toolName === "Skill"
      ? truncate(input.skill ?? "", 120)
      : truncate(
          input.description || input.command || input.file_path || input.prompt || "",
          120
        );
  const file = input.file_path ?? input.notebook_path;
  return { hint, file };
}

// Task lists are session-shared, so plan.step events are emitted for
// TaskUpdate/TaskCreate wherever they happen — main loop or inside a
// subagent (§20: the agent_id branch previously swallowed the subject).
function taskUpdateStep(input, base) {
  const stepId = input.taskId;
  if (stepId === undefined || stepId === null) return [];

  const event = { ...base, kind: "plan.step", stepId };
  let mappable = false;

  if (input.subject !== undefined) {
    event.subject = truncate(input.subject, 200);
    mappable = true;
  }

  if (input.status === "deleted") {
    event.deleted = true;
    mappable = true;
  } else if (Object.prototype.hasOwnProperty.call(STATUS_MAP, input.status)) {
    event.status = STATUS_MAP[input.status];
    mappable = true;
  }

  if (!mappable) return [];
  return [event];
}

function taskCreateStep(input, response, base) {
  const taskId =
    response && typeof response === "object" && response.task
      ? response.task.id
      : undefined;
  if (taskId === undefined || taskId === null) return [];

  return [
    {
      ...base,
      kind: "plan.step",
      stepId: taskId,
      subject: truncate(input.subject, 200),
      status: "pending",
    },
  ];
}

function translatePreToolUse(payload, base) {
  const toolName = payload.tool_name;
  const input = payload.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : {};

  if ((toolName === "Agent" || toolName === "Task") && !hasAgentId(payload)) {
    return [
      {
        ...base,
        kind: "agent.spawn-pending",
        agentType: input.subagent_type ?? "claude",
        description: truncate(input.description ?? "", 300),
      },
    ];
  }

  if (hasAgentId(payload)) {
    const { hint, file } = activityBasics(toolName, input);
    const event = {
      ...base,
      kind: "agent.activity",
      agentId: payload.agent_id,
      phase: "start",
      callId: payload.tool_use_id,
      tool: toolName,
      hint,
    };
    if (file !== undefined && file !== null) event.file = file;

    // §24: a nested Agent/Task spawn (fired from inside a running subagent)
    // links to its parent via the parent's own agent_id — fuzzy claim, no
    // child agentId exists yet.
    if (toolName === "Agent" || toolName === "Task") {
      return [
        event,
        {
          ...base,
          kind: "agent.spawn-pending",
          agentType: input.subagent_type ?? "claude",
          description: truncate(input.description ?? "", 300),
          parentAgentId: payload.agent_id,
        },
      ];
    }
    if (toolName === "TaskUpdate") return [event, ...taskUpdateStep(input, base)];
    return [event];
  }

  if (typeof toolName === "string" && toolName.startsWith("mcp__codex__")) {
    return [
      {
        ...base,
        kind: "agent.start",
        agentId: payload.tool_use_id ?? null,
        agentType: "codex-direct",
        description: truncate(input.prompt ?? "", 300),
      },
    ];
  }

  if (toolName === "TaskUpdate") {
    return taskUpdateStep(input, base);
  }

  if (toolName === "ExitPlanMode") {
    if (typeof input.plan !== "string") return [];
    return [{ ...base, kind: "plan.doc", markdown: truncate(input.plan, 4000) }];
  }

  // §25: TaskCreate stays excluded (its Pre side is unmapped, see §9) — every
  // other main-loop tool call (no agent_id, not Agent/Task/mcp__codex__/
  // TaskUpdate/ExitPlanMode, all handled above) becomes session.activity so
  // the hub isn't dead between session.start and the first spawn.
  if (toolName === "TaskCreate") return [];

  const { hint, file } = activityBasics(toolName, input);
  const event = { ...base, kind: "session.activity", tool: toolName, hint };
  if (file !== undefined && file !== null) event.file = file;
  return [event];
}

function translatePostToolUse(payload, base) {
  const toolName = payload.tool_name;
  const input = payload.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : {};
  const response = payload.tool_response;

  if ((toolName === "Agent" || toolName === "Task") && !hasAgentId(payload)) {
    const responseAgentId =
      response && typeof response === "object" ? response.agentId : undefined;
    if (responseAgentId === undefined || responseAgentId === null) return [];

    return [
      {
        ...base,
        kind: "agent.spawn-pending",
        agentType: input.subagent_type ?? "claude",
        description: truncate(input.description ?? "", 300),
        agentId: responseAgentId,
        model: response.resolvedModel,
      },
    ];
  }

  if (hasAgentId(payload)) {
    const event = {
      ...base,
      kind: "agent.activity",
      agentId: payload.agent_id,
      phase: "end",
      callId: payload.tool_use_id,
      tool: toolName,
      ms: payload.duration_ms,
    };

    // §24: the parent's PostToolUse is the authoritative repair for a nested
    // spawn — it carries both the parent's agent_id (top-level) and the
    // child's id (tool_response.agentId), often arriving after the child's
    // own SubagentStop. No tool_response.agentId (sync spawn already fully
    // resolved) -> activity only.
    if (toolName === "Agent" || toolName === "Task") {
      const responseAgentId =
        response && typeof response === "object" ? response.agentId : undefined;
      if (responseAgentId === undefined || responseAgentId === null) return [event];
      return [
        event,
        {
          ...base,
          kind: "agent.spawn-pending",
          agentId: responseAgentId,
          parentAgentId: payload.agent_id,
          agentType: input.subagent_type ?? "claude",
          description: truncate(input.description ?? "", 300),
          model: response.resolvedModel,
        },
      ];
    }

    if (toolName === "TaskCreate") return [event, ...taskCreateStep(input, response, base)];
    return [event];
  }

  if (typeof toolName === "string" && toolName.startsWith("mcp__codex__")) {
    return [
      {
        ...base,
        kind: "agent.end",
        agentId: payload.tool_use_id ?? null,
        agentType: "codex-direct",
      },
    ];
  }

  if (toolName === "TaskCreate") {
    return taskCreateStep(input, response, base);
  }

  return [];
}

export function translate(payload, now = new Date()) {
  try {
    if (!payload || typeof payload !== "object") return [];

    const name = payload.hook_event_name;
    const base = {
      v: 1,
      source: "claude-code",
      t: now.toISOString(),
      sessionId: payload.session_id,
    };

    switch (name) {
      case "SessionStart":
        return [
          { ...base, kind: "session.start", cwd: payload.cwd, transcriptPath: payload.transcript_path },
        ];
      case "SessionEnd":
        return [{ ...base, kind: "session.end" }];
      case "UserPromptSubmit":
        return [{ ...base, kind: "turn.start" }];
      case "Stop":
        return [{ ...base, kind: "turn.end" }];
      case "SubagentStart":
        return [
          { ...base, kind: "agent.start", agentId: payload.agent_id, agentType: payload.agent_type },
        ];
      case "SubagentStop":
        return [
          {
            ...base,
            kind: "agent.end",
            agentId: payload.agent_id,
            agentType: payload.agent_type,
            finalMessage: truncate(payload.last_assistant_message, 300),
            transcriptPath: payload.agent_transcript_path,
          },
        ];
      case "PreToolUse":
        return translatePreToolUse(payload, base);
      case "PostToolUse":
        return translatePostToolUse(payload, base);
      default:
        return [];
    }
  } catch {
    return [];
  }
}
