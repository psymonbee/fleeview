# LumenADE · Fleet view

FleetView is a live, n8n/make.com-style visualization of Claude Code
agent-fleet activity: an orchestrator hub with agent nodes branching off it,
each pulsing while it works and checking off when it's done. Alongside the
graph it renders a plan rail, files-touched chips (with a collision warning
when two running agents touch the same file), stall and error states, per-agent
final messages, and a click-to-open drawer with the agent's live activity log.
It turns the otherwise invisible fan-out of subagents (builders, checkers,
Codex relays, ...) into something you can watch happen in real time.

Under the hood, harness events are normalized into a versioned,
**harness-neutral event schema** (`docs/FLEETVIEW-SPEC.md` §8). A thin capture
hook forwards each raw Claude Code payload to a stateless, per-harness
**adapter** (`adapters/claude-code.mjs`), which does all the filtering and
truncation and emits neutral event lines into a local JSONL log. A
zero-dependency Node server tails that log, reduces it into sessions, agent
runs, and plans, and streams state to a single-file browser UI over
Server-Sent Events. Supporting a new harness means writing another adapter —
the schema, server, and UI stay unchanged. Nothing leaves your machine: the
log, the server, and the UI are all local.

## Quickstart

```sh
npm start
```

Then open **http://localhost:4747**. With no events file yet, you'll see an
idle hub and an empty-state message. To see it move without wiring up real
hooks, run the bundled demo in another terminal:

```sh
npm run demo
```

This replays a scripted ~60 s orchestration — a builder, a Codex relay, a
stalled agent, a null-id `codex-direct` pair, a four-step plan, a file
collision, and an error-then-recovery — as neutral events into the log, which
the running server picks up and streams to any open browser tab. Pass
`-- --fast` to skip the sleeps and replay instantly:

```sh
npm run demo -- --fast
```

## Wiring up real capture

FleetView only sees activity that Claude Code tells it about via hooks. Add the
following to your `~/.claude/settings.json` (merge into any existing `"hooks"`
block rather than replacing it). All eight events point at the same script:

```json
{
  "hooks": {
    "SessionStart":     [ { "hooks": [{ "type": "command", "command": "node /Users/simon/lumenADE/hooks/emit-event.mjs" }] } ],
    "SessionEnd":       [ { "hooks": [{ "type": "command", "command": "node /Users/simon/lumenADE/hooks/emit-event.mjs" }] } ],
    "UserPromptSubmit": [ { "hooks": [{ "type": "command", "command": "node /Users/simon/lumenADE/hooks/emit-event.mjs" }] } ],
    "Stop":             [ { "hooks": [{ "type": "command", "command": "node /Users/simon/lumenADE/hooks/emit-event.mjs" }] } ],
    "SubagentStart":    [ { "hooks": [{ "type": "command", "command": "node /Users/simon/lumenADE/hooks/emit-event.mjs" }] } ],
    "SubagentStop":     [ { "hooks": [{ "type": "command", "command": "node /Users/simon/lumenADE/hooks/emit-event.mjs" }] } ],
    "PreToolUse":       [ { "matcher": "", "hooks": [{ "type": "command", "command": "node /Users/simon/lumenADE/hooks/emit-event.mjs" }] } ],
    "PostToolUse":      [ { "matcher": "", "hooks": [{ "type": "command", "command": "node /Users/simon/lumenADE/hooks/emit-event.mjs" }] } ]
  }
}
```

The script (`hooks/emit-event.mjs`) is a pure observer: it reads the payload
Claude Code sends on stdin, hands it to the adapter (which does all filtering
and truncation), appends any resulting neutral event lines to
`~/.lumenade/events.jsonl`, and always exits `0` — it never blocks or fails a
real tool call. It writes nothing when `FLEET_IGNORE=1` is set in its
environment; this is the self-observation guard the narrator uses so FleetView
never watches itself.

Override the events-file location for both the hook and the server with
`FLEET_EVENTS_FILE`, and the server's port with `PORT` (default `4747`).

This runs on **every** hooked event across every Claude Code session on the
machine, so `server/server.mjs` should normally be running to consume the log
— otherwise `~/.lumenade/events.jsonl` just quietly grows.

## Configuration — `fleet.config.json`

The server loads `fleet.config.json` (repo root) at boot and shallow-merges it
over built-in defaults; a missing or corrupt file falls back to defaults and
still boots. Keys:

- `hub.title` — orchestrator hub title shown in the UI (default
  `"Orchestrator"`).
- `agents` — per-agentType `{ label, model, provider }`. `provider` is
  `"anthropic"` or `"openai"` and drives the card accent color and brand chip.
  Ships with `builder`, `checker`, `codex-runner`, and `codex-direct`.
- `fallbackAgent` — `{ model, provider }` used for unknown agent types.
- `modelNames` — pretty display names for raw model ids (exact match, else
  longest-prefix match after stripping a trailing date suffix, else the raw
  id). A model reported on an event wins over the per-agentType default.
- `stallThresholdMs` — how long a running agent may go without activity before
  the UI marks it stalled (default `120000`).
- `narration` — optional Haiku narration sidecar, **off by default**:
  `{ "enabled": false, "model": "haiku", "debounceMs": 15000, "minNewLines": 3, "maxConcurrent": 1, "timeoutMs": 30000 }`.
  When `enabled`, the server periodically spawns `claude -p --model <model>` to
  summarize a running agent's recent activity into one sentence. Those spawns
  run with `FLEET_IGNORE=1`, so their own hook events are ignored and FleetView
  never narrates itself.

## Events file

Neutral event lines (one JSON object per line, envelope `"v": 1`) are appended
to `~/.lumenade/events.jsonl` by default, overridable via `FLEET_EVENTS_FILE`
for both the hook and the server. Lines that fail to parse, carry a different
schema version, or use an unknown kind are silently skipped by the reducer — so
the old pre-v2 `~/.claude/fleet/` log is abandoned rather than migrated.

## Removing it

1. Delete the eight `hooks` entries above from `~/.claude/settings.json` (or
   the whole `"hooks"` block if FleetView was the only thing using it).
2. Delete the events log and its directory: `rm -rf ~/.lumenade`.
3. Optionally remove the abandoned v1 log: `rm -rf ~/.claude/fleet`.
4. Optionally remove this repo.

No other state is written anywhere else on the machine.
