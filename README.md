# FleetView

FleetView is a live, n8n/make.com-style canvas for Claude Code agent-fleet
activity. Claude Code hooks forward raw payloads to a thin observer, a
stateless adapter normalizes them into a versioned, harness-neutral event
schema, a zero-dependency Node server tails the resulting log and streams
state over Server-Sent Events, and a single self-contained HTML file renders
it. No build step, no framework, no external requests, nothing leaves your
machine.

Point it at a running Claude Code session and watch the orchestrator hub spawn
agent cards in real time: a plan rail tracking task-list steps, a files-touched
chip row with a collision warning when two running agents edit the same file,
stall and error states derived from activity gaps, per-agent final messages, a
click-to-open drawer with the live tool-call log, and a token/est.-cost badge
on every card and on the session itself.

Your own agents render without any configuration: FleetView captures at the
harness level, so whatever agent types your session spawns become cards, and
their display metadata (label, model, provider accent) is **auto-discovered**
from `~/.claude/agents` and the project's `.claude/agents` frontmatter. When a
subagent spawns its own subagent, the child card indents under its parent with
a parent-to-child edge — the canvas is a tree, not a hub-and-spokes. The hub
is the session's own card: alive from the moment you hit send, it shows what
the orchestrator is doing (reading, searching, delegating — the readout
persists while subagents run), names the model actually orchestrating (read
live off the transcript), grows the same skill/MCP capability chips agents
get, and opens its own drawer with the session's tool-call log.

![FleetView](docs/media/fleetview.gif)
<!-- capture TBD -->

## Quickstart

```sh
npx github:psymonbee/fleeview
```

This clones the repo, vendors it to `~/.lumenade/app`, and merges the eight
hook entries below into `~/.claude/settings.json` (backing up the existing
file first). Requires `git` on your `PATH` — `npx github:` installs by
cloning, not from the npm registry.

```sh
node ~/.lumenade/app/server/server.mjs
```

Open **http://localhost:4747** — with no events yet you'll see an idle hub.
To see it move without a real session, run the bundled demo from the
vendored app:

```sh
cd ~/.lumenade/app && npm run demo -- --fast
```

**Manual install**, working from a checkout instead of the vendored copy:

```sh
git clone https://github.com/psymonbee/fleeview.git
cd fleeview
node bin/install.mjs --dev "$(pwd)"
npm start
```

`--dev <path>` wires the hooks at that checkout instead of vendoring, so
repo edits take effect without reinstalling. Other flags: `--yes` (skip the
confirmation prompt), `--with-agents` (below), `--with-codex` (print the
experimental Codex wiring block — see below), `--start` (launch the server
once installed), `--uninstall` (below).

### No orchestration yet? `--with-agents`

If you don't have agent definitions of your own, `--with-agents` installs a
starter fleet into `~/.claude/agents`: **builder** (implements a
well-specified step), **checker** (verifies the builder's work),
**codex-runner** (relays a task to the OpenAI Codex CLI — harmless if you
don't have `codex` installed; it simply never gets spawned),
**researcher** (investigates one focused question with cited findings —
spawn several in parallel to cover a topic), and **writer** (turns raw
material into a polished deliverable). The last two are deliberately not
coding agents: fleets get used for research, analysis, and writing too,
and FleetView renders those exactly the same way. Files you already have
are never overwritten (`skipped (exists)` is printed), and `--uninstall`
leaves them in place — once written, they're yours.

## Architecture

```
Claude Code hooks (8 events)
        │  stdin JSON
        ▼
hooks/emit-event.mjs        thin observer — always exit 0, never blocks a tool call
        │
        ▼
adapters/claude-code.mjs    stateless translator, [] on anything unrecognized
        │  neutral events {v, source, t, kind, sessionId, ...}
        ▼
~/.lumenade/events.jsonl    versioned, harness-neutral JSONL log
        │  tailed incrementally
        ▼
server/server.mjs           reducer + SSE :4747 + GET /agents/:id/log, /sessions/:id/log
        │  EventSource
        ▼
public/index.html           single-file UI — hub, agent cards, plan rail, drawer
```

Supporting a new harness means writing another adapter emitting the same
neutral schema — log format, server, and UI don't change.
`FLEET_EVENTS_FILE` overrides the events-log path (hook and server);
`PORT` overrides the server port (default `4747`). Note the events log
grows unbounded (v4's orchestrator-activity capture adds roughly one line
per main-loop tool call) — it's a plain JSONL file; truncate or rotate it
whenever you like, the server just re-tails.

### What the installer writes

The installer merges this shape into `~/.claude/settings.json`, once per
event, deduping its own entries on re-run rather than duplicating them:

```json
{
  "hooks": {
    "SessionStart":     [ { "hooks": [{ "type": "command", "command": "node <install path>/hooks/emit-event.mjs", "timeout": 5 }] } ],
    "SessionEnd":       [ { "hooks": [{ "type": "command", "command": "node <install path>/hooks/emit-event.mjs", "timeout": 5 }] } ],
    "UserPromptSubmit": [ { "hooks": [{ "type": "command", "command": "node <install path>/hooks/emit-event.mjs", "timeout": 5 }] } ],
    "Stop":             [ { "hooks": [{ "type": "command", "command": "node <install path>/hooks/emit-event.mjs", "timeout": 5 }] } ],
    "SubagentStart":    [ { "hooks": [{ "type": "command", "command": "node <install path>/hooks/emit-event.mjs", "timeout": 5 }] } ],
    "SubagentStop":     [ { "hooks": [{ "type": "command", "command": "node <install path>/hooks/emit-event.mjs", "timeout": 5 }] } ],
    "PreToolUse":       [ { "matcher": ".*", "hooks": [{ "type": "command", "command": "node <install path>/hooks/emit-event.mjs", "timeout": 5 }] } ],
    "PostToolUse":      [ { "matcher": ".*", "hooks": [{ "type": "command", "command": "node <install path>/hooks/emit-event.mjs", "timeout": 5 }] } ]
  }
}
```

`<install path>` is `~/.lumenade/app` normally, or your checkout for
`--dev`. Everything else already in `settings.json` is left untouched; a
timestamped backup is written before every merge.

## Configuration — `fleet.config.json`

The server loads `fleet.config.json` (repo root) at boot and shallow-merges
it over built-in defaults; a missing or corrupt file falls back to defaults
and still boots. Keys:

- `hub.title` — orchestrator hub title shown in the UI (default
  `"Orchestrator"`).
- `agents` — per-agentType `{ label, model, provider }` **overrides**.
  `provider` is `"anthropic"` or `"openai"` and drives the card accent
  color and brand chip. You rarely need this now: agent metadata is
  auto-discovered from `~/.claude/agents/*.md` (scanned at server boot)
  and `<session cwd>/.claude/agents/*.md` (scanned when a session starts;
  project beats user-level) — the frontmatter `name`, `description`, and
  `model` fields drive the card. An explicit `agents` entry in this file
  always beats discovery. Ships with just the two Codex entries
  (`codex-runner`, `codex-direct`).
- `modelAliases` — maps frontmatter model aliases to canonical ids before
  pretty-naming (`sonnet` → `claude-sonnet-5`, etc.); `inherit` and
  unknown aliases pass through.
- `fallbackAgent` — `{ model, provider }` used for unknown agent types
  (Codex-namespaced sessions fall back to the `openai` provider).
- `modelNames` — pretty display names for raw model ids (exact match, else
  longest-prefix match after stripping a trailing date suffix, else the raw
  id). A model reported on an event wins over the per-agentType default.
- `stallThresholdMs` — how long a running agent may go without activity
  before the UI marks it stalled (default `120000`).
- `narration` — optional Haiku narration sidecar, **off by default**. When
  enabled the server periodically spawns `claude -p --model <model>` to
  summarize a running agent's recent activity in one sentence, with
  `FLEET_IGNORE=1` set so FleetView never narrates itself.
- `enrichment` — token/cost sidecar, **on by default**: `{ enabled,
  intervalMs, pricing }`. `pricing` maps a model id to USD-per-million-token
  rates:

  | model | in | out | cache read | cache write |
  |---|---|---|---|---|
  | Claude Fable 5 | $10.00 | $50.00 | $1.00 | $12.50 |
  | Claude Opus 4.8 | $5.00 | $25.00 | $0.50 | $6.25 |
  | Claude Sonnet 5 | $3.00 | $15.00 | $0.30 | $3.75 |
  | Claude Haiku 4.5 | $1.00 | $5.00 | $0.10 | $1.25 |

  All figures are estimates: cache writes are priced at the 5-minute cache
  rate (transcripts don't distinguish 5-minute from 1-hour writes), and
  Sonnet 5 also carries $2/$10 intro pricing through 2026-08-31, not
  reflected above. Edit `enrichment.pricing` as rates change — a
  user-supplied `enrichment` block replaces the default wholesale, not a
  key-by-key merge.

## Token / cost per node

Running agent cards show a compact token badge next to the model pill; the
drawer expands it into an input / output / cache-read / cache-write
breakdown plus an estimated dollar cost. A local sidecar
(`server/enrich.mjs`) tails each agent's own transcript file incrementally —
a bounded read per tick, never the whole file — and dedupes by message id,
since transcripts repeat an assistant line once per content block and only
the last occurrence carries the true token count. Cost is recomputed from
the pricing table above on every change. Nothing leaves the machine: the
sidecar only reads transcript files Claude Code already writes to disk.

## Codex CLI (experimental)

FleetView ships an adapter for the Codex CLI (`adapters/codex.mjs`) that
maps Codex's hook events onto the same neutral schema, with every id
namespaced `codex:<raw id>` so a concurrent Codex session and Claude Code
session in the same events log never collide. Wire it in two steps:

```sh
npx github:psymonbee/fleeview --with-codex
```

prints a `[hooks.*]` block — paste it at the end of `~/.codex/config.toml`,
then run `codex` once interactively and approve its hook-trust prompt.
After that, headless `codex exec` runs are captured too. Codex ties the
approval to the exact hook text, so if the block ever changes (including a
reinstall printing a fresh one), capture stops **silently** until you
re-approve. The installer itself never runs `codex` commands and never
edits `~/.codex/*`.

The delivery path and field mapping are verified against live captured
Codex hook payloads (`docs/FLEETVIEW-SPEC.md` §18): session, turn, and
tool-activity events all fire. Codex has no SessionEnd hook, so idle Codex
sessions age off the canvas via the 24 h prune rather than ending crisply.
This path is newer and less exercised; expect rough edges.

## Removal

```sh
npx github:psymonbee/fleeview --uninstall
rm -rf ~/.lumenade
```

The first removes the eight hook entries the installer added from
`~/.claude/settings.json`, leaving every other hook and setting untouched;
the second deletes the vendored app and the events log. Settings backups
from every install/uninstall are left under
`~/.claude/settings.json.fleetview-backup-<timestamp>` for you to inspect or
restore from. No other state is written anywhere on the machine.

## License

[MIT](LICENSE)
