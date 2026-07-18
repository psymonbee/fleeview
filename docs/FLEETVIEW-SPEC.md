# FleetView v1 — build spec

> **v2 amendment applies.** Sections §8–§16 below supersede parts of v1:
> the raw-payload capture in §2 (replaced by the neutral-event adapter, §8–§9),
> the events-file path (§8: now `~/.lumenade/events.jsonl`), and the hardcoded
> model map in §3 (replaced by `fleet.config.json`, §10).

LumenADE Fleet View: a live, n8n/make.com-style visualization of Claude Code
agent-fleet activity. Claude Code hooks append raw events to a JSONL file; a
zero-dependency Node server tails it, normalizes, and pushes state over SSE; a
single-file browser UI renders the fleet as an animated node graph.

This document is the contract. Two agents build from it in parallel:
- **Sections 2–4, 6**: capture script, server, demo script, package.json, README.
- **Section 5**: the UI (`public/index.html`) — built independently against the
  SSE contract in section 3. Do not touch files outside your sections.

Repo root: `/Users/simon/lumenADE`. Node >= 20, ES modules (`.mjs` / `"type": "module"`).
**Zero npm dependencies anywhere.**

---

## 1. File layout

```
hooks/emit-event.mjs    # hook observer: stdin JSON -> filtered line appended to events file
server/server.mjs       # http server: static public/ + GET /events (SSE) + GET /healthz
public/index.html       # single-file UI (inline CSS/JS, no external requests)
scripts/demo.mjs        # replays a scripted fake orchestration into the events file
docs/FLEETVIEW-SPEC.md  # this file
package.json            # {"type":"module", scripts: start/demo, no deps}
README.md               # what it is, how to run, how hooks are wired/removed
```

Events file (both hook script and server): `~/.claude/fleet/events.jsonl`,
overridable via env `FLEET_EVENTS_FILE`. Server port: `4747`, env `PORT`.

## 2. Capture: `hooks/emit-event.mjs`

Invoked by Claude Code hooks. Receives one JSON payload on **stdin**. Must be a
pure observer: **always `exit 0`**, print nothing to stdout/stderr, wrap
everything in try/catch (a crash or nonzero exit could interfere with the
user's tool calls). Create the events-file directory recursively if missing.

Relevant incoming payload fields (vary by event): `hook_event_name`,
`session_id`, `cwd`, `tool_name`, `tool_input`, `tool_output`, `agent_id`,
`agent_type`, `last_assistant_message`.

**Keep** an event iff:
- `hook_event_name` ∈ {SessionStart, SessionEnd, UserPromptSubmit, Stop, SubagentStart, SubagentStop}, or
- `hook_event_name` ∈ {PreToolUse, PostToolUse} AND (
    `tool_name` is `Agent` or `Task`, or
    `tool_name` starts with `mcp__codex__`, or
    payload has `agent_id` (a tool call made inside a subagent) )

Otherwise exit 0 without writing.

**Write**: one line of JSON appended to the events file:
`{"t": "<ISO timestamp>", ...payload}` — original field names preserved, with
size control applied first:
- Recursively truncate every string longer than 300 chars in `tool_input` to
  300 chars + `"…"`.
- Replace `tool_output` AND `tool_response` with their first 300 chars
  (stringify non-strings first — current Claude Code delivers `tool_response`
  as an object; older docs call it `tool_output`).
- Drop `last_assistant_message` beyond 300 chars likewise.
- Drop fields: `transcript_path`, `permission_mode`, `effort`, `prompt_id`.

Use `fs.appendFileSync`. No locking needed (single-line appends under 8 KB are
atomic enough for this use).

## 3. Server: `server/server.mjs`

Plain `node:http`. Serves:
- `GET /` and `/index.html` → `public/index.html`; any other file under
  `public/` by exact name (content-type by extension: html/js/css/svg/png).
  404 otherwise. No directory traversal (resolve + prefix check).
- `GET /healthz` → `200 {"ok":true,"sessions":N,"agents":N}`.
- `GET /events` → SSE (`text/event-stream`, `no-cache`, `keep-alive`):
  1. On connect, immediately send the full state:
     `event: snapshot` + `data: {"sessions":[Session...],"agents":[AgentRun...]}`
  2. Then, for every state change, send:
     `event: fleet` + `data: {"type":"<change type>","session":Session?,"agent":AgentRun?}`
     (include whichever object changed; both allowed; objects are always the
     FULL current record — the client upserts by `id`, never patches).
  3. Comment heartbeat `: ping` every 15 s.

### Tailing

On boot, read the whole events file if it exists and build state. Then watch
for appends: `fs.watch` on the containing directory plus a 1 s polling
fallback; track byte offset; if file size < offset (truncated/rotated), reset
state and rebuild from byte 0. Tolerate the file not existing yet. Skip lines
that fail `JSON.parse`.

### Normalized state

```js
Session  { id, cwd, startedAt, lastActivityAt, turnActive, ended }
AgentRun { id, sessionId, agentType, label, provider,  // "anthropic" | "openai"
           model, description, currentActivity, status, // "running" | "done"
           startedAt, endedAt }
```

Every raw event updates `lastActivityAt` on its session. Sessions are created
lazily from ANY event whose `session_id` is unknown (hooks may be wired after
a session already started), with `startedAt` = that event's `t`.

Reduction rules (raw `hook_event_name` → state):
- `SessionStart`: upsert session (cwd, startedAt, turnActive=false, ended=false).
- `UserPromptSubmit`: session.turnActive = true.
- `Stop`: session.turnActive = false.
- `SessionEnd`: session.ended = true, turnActive = false.
- `PreToolUse` `Agent`/`Task` **without** `agent_id` (main-loop spawn): push
  `{sessionId, subagentType: tool_input.subagent_type ?? "claude", description: tool_input.description ?? "", t}`
  onto a pending-spawn list (cap 20 per session, expire after 10 min).
- `SubagentStart`: create AgentRun `id = agent_id`, `agentType = agent_type`,
  status running, startedAt = t. `description`: claim + remove the oldest
  pending spawn in the same session with matching `subagentType`; if none
  matches, the oldest pending spawn in the session; else `""`.
- `PreToolUse` **with** `agent_id`: find that AgentRun (create lazily if the
  start was missed — status running) and set
  `currentActivity = "<tool_name>: <hint>"`, ≤ 60 chars, where hint is
  `tool_input.description || tool_input.command || tool_input.file_path || tool_input.prompt || ""`.
- `SubagentStop`: that AgentRun → status done, endedAt = t, currentActivity = null.
- `PreToolUse` `mcp__codex__*` without `agent_id`: create AgentRun
  `id = "codex:<session_id>:<counter>"`, agentType `codex-direct`, status
  running, description = first 80 chars of `tool_input.prompt`.
- `PostToolUse` `mcp__codex__*` without `agent_id`: oldest running
  `codex-direct` AgentRun in that session → done.
- `PostToolUse` otherwise: ignore (SubagentStop is the completion signal).

Memory bound: on each new event, drop agents with `endedAt` > 1 h old and
sessions (plus their agents) with `lastActivityAt` > 24 h old.

### Model map (agentType → label / model / provider)

| agentType        | label          | model                      | provider  |
|------------------|----------------|----------------------------|-----------|
| builder          | Builder        | Claude Sonnet 5            | anthropic |
| checker          | Checker        | Claude Opus 4.8            | anthropic |
| codex-runner     | Codex relay    | OpenAI Codex               | openai    |
| codex-direct     | Codex (direct) | OpenAI Codex               | openai    |
| claude           | Claude         | Claude (session model)     | anthropic |
| Explore / Plan / general-purpose / claude-code-guide | same as agentType | Claude (session model) | anthropic |
| anything else    | agentType      | Claude                     | anthropic |

## 4. Demo: `scripts/demo.mjs`

Appends **raw hook-shaped payloads** (same shapes the hook script writes, so it
exercises the real normalization path) to the events file, with sleeps, telling
a ~45 s story under session id `demo-<pid>`:

1. SessionStart (cwd `/Users/simon/lumenADE`) → UserPromptSubmit.
2. PreToolUse Agent (builder, "Build SSE fleet server") → SubagentStart builder
   (agent_id `demo-b1`) → 3–4 PreToolUse events with agent_id demo-b1
   (Write server/server.mjs, Bash: node --check …).
3. In parallel narrative: PreToolUse Agent (codex-runner, "Build fleet canvas
   UI") → SubagentStart (demo-c1) → activity `Bash: codex exec --full-auto …`.
4. SubagentStop demo-b1 → PreToolUse Agent (checker, "Verify build vs spec") →
   SubagentStart (demo-k1) → activities → SubagentStop demo-c1 →
   SubagentStop demo-k1 → Stop.

`--fast` flag skips sleeps. Print one progress line per event to stdout.

## 5. UI: `public/index.html`  ← built by Codex

One self-contained file: inline CSS + vanilla JS, **no external requests of any
kind** (no CDNs, fonts, or images — system font stack, inline SVG only).
Target modern Chrome/Safari. Aim for clean, readable code, roughly ≤ 900 lines.

### Data flow

- `new EventSource("/events")`. On `snapshot`: replace all state. On `fleet`:
  upsert `msg.session` / `msg.agent` by `id` (they arrive as full records).
  EventSource auto-reconnects; each reconnect re-delivers a snapshot (replace,
  don't merge).
- The UI renders ONE session at a time. Header session picker (see below)
  defaults to **Follow latest** = session with max `lastActivityAt`,
  auto-switching as new activity arrives; picking a specific session pins it.

### Layout

- Header, 48 px: left — dot logo + `LumenADE · Fleet view`; right — running
  count chip (`N running`), session `<select>`, live-connection dot (green =
  SSE open, red = reconnecting). Session option label:
  `<cwd basename> · <first 8 chars of id>`, sorted by lastActivityAt desc, with
  a first option "Follow latest".
- Below: full-viewport canvas, `#0A0C10` background with a subtle dot grid
  (radial-gradient dots, 24 px pitch, rgba(255,255,255,.05)).
- **Hub node** (the orchestrator): vertically centered, left edge ≈ 8% width.
  ~200×72 px rounded card: sparkle glyph, title `Fable 5`, subtitle
  `Orchestrator · <cwd basename>`. While `session.turnActive`: soft pulsing
  ring/glow. When session.ended: greyed.
- **Agent nodes**: vertical column, left edge ≈ 52% width, 104 px vertical
  rhythm, group vertically centered; overflow scrolls vertically.
  Card ~280×88 px: colored left accent bar (provider color), first row =
  brand-glyph chip (24 px, provider logo — white Anthropic/OpenAI marks
  sourced via Brandfetch, inlined as data URIs; class `brand-chip`, NOT
  `brand`, which is the header wordmark) + label (semibold 13 px) + model
  badge (10 px uppercase pill), second row =
  description (11 px, single line, ellipsis), third row = status: while
  running a pulsing dot + `currentActivity` (11 px mono, ellipsis) + elapsed
  timer `m:ss` ticking every second; when done a ✓ pill + final elapsed time.
- **Links**: SVG layer under the cards. One cubic bezier per agent from hub
  right-center to card left-center, control points at horizontal midpoint.
  Running: stroke = provider accent, 2 px, dashed, animated dash-offset flow
  (hub → agent). Done: solid `#3A4453`, 1.5 px.

### Design tokens

```
bg #0A0C10 · card #151A23 · border #232B38 · text #E6EAF2 · muted #8B94A7
anthropic accent #D97757 · openai accent #19C29D · done #7BC47F · error #E5484D
radius 16px · card shadow 0 4px 24px rgba(0,0,0,.35)
font: -apple-system, "SF Pro Text", Segoe UI, system-ui, sans-serif
mono: ui-monospace, "SF Mono", Menlo, monospace
```

### Motion

- Node enter: opacity 0→1 + scale .85→1, 250 ms cubic-bezier(.2,.8,.2,1); its
  link draws in via stroke-dashoffset over 350 ms.
- Reflow (nodes re-centering when one joins/leaves): CSS transform transitions
  ~300 ms — no jumps.
- Done: status swaps to ✓; after 20 s card+link dim to 55% opacity; after
  3 min fade out over 1 s and remove.
- Timers/pulses via one shared 1 s interval + CSS animations; don't rerender
  the world per tick — update only changed text nodes.

### Empty state

Centered muted text when the selected session has no agents:
`Fleet idle — run  npm run demo  to see it move.` (and hub still shown).

## 6. package.json / README

```json
{ "name": "lumenade", "private": true, "type": "module",
  "scripts": { "start": "node server/server.mjs", "demo": "node scripts/demo.mjs" },
  "engines": { "node": ">=20" } }
```

README: two paragraphs (what/why), quickstart (`npm start`, open
http://localhost:4747, `npm run demo`), the hooks settings.json snippet that
wires capture (pointing at `node /Users/simon/lumenADE/hooks/emit-event.mjs`),
and the removal path (delete hooks block + `~/.claude/fleet/`).

## 7. Acceptance criteria (checker verifies these)

1. `node --check` passes on all four .mjs/.js entry points; `npm start` boots
   with no events file present and serves `/` (200, html) and `/healthz`.
2. `curl -N localhost:4747/events` yields a `snapshot` event immediately.
3. With server running, `node scripts/demo.mjs --fast` → snapshot on a fresh
   SSE connect contains the demo session, 3 AgentRuns with correct
   labels/models/providers per the model map, all eventually `done`, and the
   builder AgentRun's description is "Build SSE fleet server".
4. `hooks/emit-event.mjs`: echoing a SubagentStart payload into it appends a
   line; echoing a PreToolUse for tool `Read` with no agent_id appends
   nothing; garbage stdin exits 0; a >300-char command in tool_input is
   truncated.
5. index.html: no external URLs (grep for `http://`, `https://`, `//` in
   src/href — none outside comments); connects to `/events`; renders hub +
   agent cards per section 5 against the demo data; session picker present;
   no console errors.

---

# FleetView v2 — amendment (2026-07-17)

v2 promotes the events file to a **versioned, harness-neutral schema** with
stateless per-harness adapters, then builds: plan rail, final messages,
stall/error states, files-touched chips + collision warning, click-to-drawer
with live log, desktop notifications, and an optional Haiku narration sidecar.
Constraints unchanged: zero npm dependencies, Node ≥ 20 ESM, hook is a pure
observer, `public/index.html` stays one self-contained file with no external
requests, SSE sends full-record upserts by id.

Events file moves to `~/.lumenade/events.jsonl` (env `FLEET_EVENTS_FILE` still
overrides). Old `~/.claude/fleet/` is abandoned, not migrated; v1-format lines
are silently skipped by the v2 reducer.

All field names in §8–§9 were empirically verified against raw hook payloads
captured on this machine on 2026-07-17 (`test/fixtures/*.json`) — see
"S1 findings" notes inline. `pre-exitplanmode-SYNTHETIC.json` is the one
synthesized fixture (headless claude never dispatches ExitPlanMode to hooks;
input shape `{plan: string}` confirmed from a real interactive transcript).

## 8. Neutral event schema (v1 of the schema)

One JSON line per event. Envelope, always present:

```json
{ "v": 1, "source": "claude-code" | "codex" | "demo", "t": "<ISO 8601>",
  "kind": "<kind>", "sessionId": "<harness session id>" }
```

The reducer silently skips lines with `v !== 1`, unknown `kind`, or failed
`JSON.parse` (this is how old v1-format lines die quietly).

| kind | extra fields |
|---|---|
| `session.start` | `cwd`, `transcriptPath?` |
| `session.end` | — |
| `turn.start` | — |
| `turn.end` | — |
| `agent.spawn-pending` | `agentType`, `description` (≤300), `agentId?`, `model?` — with `agentId` it is an **exact claim** (see §9 async spawns), without it a legacy fuzzy-claim entry |
| `agent.start` | `agentId` (string \| null), `agentType`, `description?`, `model?`, `transcriptPath?` |
| `agent.activity` | `agentId`, `phase`: `"start"`\|`"end"`, `callId?`, `tool`, `hint?` (≤120), `file?`, `error?` (bool), `ms?` (duration, phase end only) |
| `agent.end` | `agentId` (string \| null), `agentType?` (used for null-id pairing), `finalMessage?` (≤300), `transcriptPath?` |
| `plan.step` | `stepId`, `subject?` (≤200), `status?` (`pending`\|`active`\|`done`), `deleted?` (bool) — upsert semantics, only present fields change |
| `plan.doc` | `markdown` (≤4000) |

`transcriptPath` is deliberately carried (v2 reducer ignores it) so a future
token/cost enricher can tail transcripts. `permission_mode` / `effort` /
`prompt_id` are never mapped — the adapter whitelists, there is no blacklist.

## 9. Adapter contract — `adapters/claude-code.mjs`

```js
export function translate(payload, now = new Date()) → NeutralEvent[]  // 0..n
```

**Stateless, pure, never throws** — returns `[]` on malformed/unwanted input.
All filtering and truncation lives here; the hook keeps zero policy. `t` =
`now.toISOString()`; `sessionId` = `payload.session_id`; `source` =
`"claude-code"`.

Mapping (anything not listed → `[]`):

- `SessionStart` → `session.start {cwd, transcriptPath: transcript_path}`
- `SessionEnd` → `session.end`; `UserPromptSubmit` → `turn.start`; `Stop` → `turn.end`
- `SubagentStart` → `agent.start {agentId: agent_id, agentType: agent_type}`
  — S1: payload carries `agent_id`/`agent_type` only, no description.
- `SubagentStop` → `agent.end {agentId: agent_id, agentType: agent_type,
  finalMessage: truncate(last_assistant_message, 300),
  transcriptPath: agent_transcript_path}`
- `PreToolUse` `Agent`/`Task` **without** `agent_id` →
  `agent.spawn-pending {agentType: tool_input.subagent_type ?? "claude",
  description: truncate(tool_input.description ?? "", 300)}`
- `PostToolUse` `Agent`/`Task` **without** `agent_id` and with
  `tool_response.agentId` (S1: async spawns respond immediately with
  `{isAsync, status: "async_launched", agentId, description, resolvedModel}`) →
  `agent.spawn-pending {agentType: tool_input.subagent_type ?? "claude",
  description, agentId: tool_response.agentId, model: tool_response.resolvedModel}`.
  No `tool_response.agentId` (sync spawn completing) → `[]`.
- `PreToolUse` **with** `agent_id` → `agent.activity {agentId, phase: "start",
  callId: tool_use_id, tool: tool_name, hint, file}` where
  `hint = truncate(tool_input.description || tool_input.command ||
  tool_input.file_path || tool_input.prompt || "", 120)` and
  `file = tool_input.file_path ?? tool_input.notebook_path` (omit if absent).
- `PostToolUse` **with** `agent_id` → `agent.activity {agentId, phase: "end",
  callId: tool_use_id, tool: tool_name, ms: duration_ms}`.
  **S1 finding (critical): failing tools emit PreToolUse only — no PostToolUse
  at all**, and successful `tool_response` has no error field. So there is no
  per-event error flag from Claude Code; errors are *inferred by the reducer*
  from calls that never see `phase:"end"` (§11). The schema's `error` field is
  still first-class — the demo and future sources set it explicitly.
- `PreToolUse`/`PostToolUse` `mcp__codex__*` **without** `agent_id` →
  `agent.start` / `agent.end` with `agentType: "codex-direct"`,
  `agentId: tool_use_id ?? null`,
  and on start `description: truncate(tool_input.prompt ?? "", 300)`.
  (S1: `tool_use_id` is present on all Pre/PostToolUse payloads, so Pre/Post
  pair exactly; null stays as declared fallback.)
- `PostToolUse` `TaskCreate` → `plan.step {stepId: tool_response.task.id,
  subject: truncate(tool_input.subject, 200), status: "pending"}` — S1: the
  assigned id arrives only in the response, so Post, not Pre; no
  `tool_response.task.id` → `[]`.
- `PreToolUse` `TaskUpdate` → `plan.step {stepId: tool_input.taskId}` plus,
  when present: `subject`, `status` mapped
  `pending→pending, in_progress→active, completed→done`, and
  `tool_input.status === "deleted"` → `deleted: true`. No mappable field → `[]`.
- `PreToolUse` `ExitPlanMode` → `plan.doc {markdown:
  truncate(tool_input.plan, 4000)}`.

### Hook rewrite — `hooks/emit-event.mjs` (~45 lines)

1. `if (process.env.FLEET_IGNORE === "1") process.exit(0)` **before** reading
   stdin (self-observation guard for the narrator, §14).
2. Read stdin, `JSON.parse` (failure → exit 0).
3. `translate(payload)` — import via
   `new URL("../adapters/claude-code.mjs", import.meta.url)` so the absolute
   `node /Users/simon/lumenADE/hooks/emit-event.mjs` invocation keeps working.
4. Append all returned lines in a **single** `appendFileSync`.
5. Default path `~/.lumenade/events.jsonl`; `FLEET_EVENTS_FILE` overrides.
6. Same never-throw / always-exit-0 wrapper as v1.

## 10. `fleet.config.json` (repo root)

```json
{ "hub": { "title": "Orchestrator" },
  "agents": {
    "builder":      { "label": "Builder",        "model": "Claude Sonnet 5", "provider": "anthropic" },
    "checker":      { "label": "Checker",        "model": "Claude Opus 4.8", "provider": "anthropic" },
    "codex-runner": { "label": "Codex relay",    "model": "OpenAI Codex",    "provider": "openai" },
    "codex-direct": { "label": "Codex (direct)", "model": "OpenAI Codex",    "provider": "openai" } },
  "fallbackAgent": { "model": "Claude", "provider": "anthropic" },
  "modelNames": {
    "claude-fable-5": "Claude Fable 5", "claude-opus-4-8": "Claude Opus 4.8",
    "claude-sonnet-5": "Claude Sonnet 5", "claude-haiku-4-5": "Claude Haiku 4.5" },
  "stallThresholdMs": 120000,
  "narration": { "enabled": false, "model": "haiku", "debounceMs": 15000,
                 "minNewLines": 3, "maxConcurrent": 1, "timeoutMs": 30000 } }
```

Server loads it at boot and **shallow-merges over identical built-in
defaults** (missing/corrupt file → defaults, still boots). `resolveAgentMeta`:
1. event `model` if set — prettified via `modelNames` (exact match, else
   longest-prefix match after stripping a trailing date suffix, else raw id);
2. else `config.agents[agentType]`;
3. else `{label: agentType, ...config.fallbackAgent}`.
Hub title reaches the UI in the snapshot `config` object; it replaces the
hardcoded "Fable 5" (§5) and the hub renders the generic dot-logo glyph, not a
brand mark. Brand data-URIs stay for agent-card chips.

## 11. Reducer v2 — `server/server.mjs`

State: v1 `sessions` / `agents` / `pendingSpawns` / `codexCounters`, plus
`plans: Map<sessionId, Plan>`, `agentLogs: Map<agentId, LogEntry[]>` (ring,
cap 50, **not** included in snapshots), `openCalls: Map<agentId,
Map<callId, {t, tool, hint}>>`, `exactPending: Map<agentId,
{description, model, agentType, t}>`.

`AgentRun` gains: `lastActivityAt`, `lastErrorAt`, `files` (≤5 paths,
recent-first, deduped), `stepId`, `finalMessage`, `narrative`, `narrativeAt`.
`Plan = {sessionId, steps: [{id, subject, status, updatedAt}], doc, updatedAt}`
(steps in creation order). `LogEntry = {t, tool, hint?, file?, error?, ms?}`.

Reducer switches on `kind` after the `v === 1` guard. Sessions are still
created lazily from any event with an unknown `sessionId`.

- `session.start/end`, `turn.start/end`: as v1 (`turnActive`, `ended`).
- `agent.spawn-pending` **with `agentId`**: if that AgentRun exists, set its
  `description`/`model` (upsert broadcast); else store in `exactPending`.
  Either way remove the oldest legacy `pendingSpawns` entry for the session
  with the same `description` (its PreToolUse twin — avoids double-claim).
  Without `agentId`: v1 behavior (cap 20/session, expire 10 min).
- `agent.start`: create/update AgentRun (id = `agentId`, or synthesized
  `codex:<sessionId>:<n>` when null + codex-direct). `description` = event's,
  else `exactPending[agentId]` (also sets `model`), else v1 fuzzy claim from
  `pendingSpawns` (matching agentType first, else oldest). Then
  `stepId = matchPlanStep(sessionId, description)`.
- `agent.activity` `phase:"start"`: bump `lastActivityAt`, set
  `currentActivity = "<tool>: <hint>"` (≤60 chars), push LogEntry, append
  `file` to `files` (dedupe, keep 5 most recent), record in `openCalls`.
  **Error inference:** any *other* call for this agent still open and older
  than 2 500 ms is now known to have failed (Claude Code agents are
  sequential; simultaneous parallel-batch PreToolUse lines land well inside
  2.5 s) → mark its LogEntry `error: true`, set `lastErrorAt = now`, broadcast.
  Explicit `error: true` on the event itself: same marking, hint from event.
- `agent.activity` `phase:"end"`: close the open call, set `ms` on its
  LogEntry, bump `lastActivityAt`. Broadcasts for activity events:
  `{type: "agent", agent}` **and** `{type: "activity", agentId, entry}`.
- `agent.end`: null-id codex-direct pairing = oldest running codex-direct in
  session. Status done, `endedAt`, `currentActivity = null`,
  `finalMessage` when present. Any still-open calls → LogEntry `error: true`
  (no `lastErrorAt` bump — the card is done; the drawer shows the red line).
- `plan.step`: upsert into the session's Plan by `stepId` (only present
  fields change; `deleted: true` removes). After: re-run `matchPlanStep` for
  running agents with `stepId == null`. Broadcast `{type: "plan", plan}`.
- `plan.doc`: set `doc`, broadcast `{type: "plan", plan}`.

**Stalled is UI-derived, not server state** — the server only guarantees
`lastActivityAt`; no SSE flapping.

`matchPlanStep(sessionId, description)` — deterministic fuzzy match:
normalize both sides (lowercase, strip non-alphanumerics to spaces, drop
tokens < 3 chars and stopwords `the a an and or of to in for with on by`);
substring containment (either direction) wins immediately; else token-overlap
score `|A∩B| / min(|A|,|B|)` — best step with score ≥ 0.5 wins; ties prefer
status `active` > `pending` > `done`, then step order. Returns `stepId` or
`null`. No LLM fallback in v2.

Prune (unchanged cadence): agents done > 1 h, sessions idle > 24 h — now also
clears `plans`, `agentLogs`, `openCalls`, `exactPending`, narrator state for
pruned ids.

## 12. SSE / HTTP v2

- Snapshot (on SSE connect):
  `{"sessions": [...], "agents": [...], "plans": [Plan...],
    "config": {"hubTitle": "...", "stallThresholdMs": 120000}}`
- `event: fleet` data types: v1 `{type, session?, agent?}` plus
  `{type: "plan", plan}` and `{type: "activity", agentId, entry}` (activity is
  fire-and-forget for the drawer; cards still update via `type: "agent"`).
- New `GET /agents/:id/log` → `200 {"agentId": "...", "entries": [LogEntry...]}`
  (`decodeURIComponent` the id — codex ids contain `:`; unknown id → `{agentId,
  entries: []}`). Routed before static handling.
- `/healthz` unchanged. Default events path now `~/.lumenade/events.jsonl`.

## 13. UI v2 — `public/index.html`

- **Plan rail:** `<aside>` 248 px, left of canvas. Hidden entirely when the
  selected session has no plan; auto-hidden < 900 px viewport; header ‹/›
  collapse toggle persisted in `localStorage("fleet.railCollapsed")`. Row =
  status dot (grey pending / pulsing accent active / green ✓ done) + subject
  (12 px, 2-line clamp) + index number. If `steps` is empty but `doc` exists:
  render the doc's markdown list lines (`- ` / `* ` / `1. ` prefixes, max 12)
  as static rows.
- **Cards:** `CARD_H` 88 → **108**, `RHYTHM` 104 → **128**. These constants are
  shared by CSS and `renderPath()` — change both together or links detach.
  Additions: step tag pill `S<n>` (index in plan, not stepId) next to the
  model badge when `stepId` matches a plan step; files row (≤3 basename chips
  + `+N` overflow; row always rendered for uniform card height); done cards
  show `finalMessage` (italic, 11 px, 2-line clamp) in place of activity;
  running cards show `narrative` in italic while `narrativeAt` < 90 s old,
  else `currentActivity`.
- **Stall:** derived in the existing 1 s tick — `status === "running" &&
  now − lastActivityAt > config.stallThresholdMs` → amber status dot + text
  `stalled · <elapsed since lastActivityAt>`. Clears itself on next activity.
- **Error flick:** when an agent upsert carries a `lastErrorAt` newer than the
  previously rendered one → red glow keyframe on the card, 1.2 s, once.
- **Collision:** a file appearing in `files` of ≥ 2 *running* agents → amber
  pulse on that chip on both cards + a topbar chip `⚠ file collision` while
  any collision exists.
- **Drawer:** click a card → 360 px panel slides in over the canvas right
  edge. Header (label, model badge, status), description, files list,
  `finalMessage` when done, then mono log lines from `GET /agents/:id/log`
  (URL-encode the id), errors in red, `ms` right-aligned when present;
  live-appends entries from `{type: "activity"}` SSE messages for the open
  agent. Close: ✕ button, Esc, or click outside.
- **Notifications:** bell toggle in topbar, state in
  `localStorage("fleet.notify")`. `Notification.requestPermission()` called
  only inside the click handler. Fires when: a session upsert flips
  `turnActive` true → false AND toggle on AND `document.hidden` →
  `new Notification("Turn finished", {body: "<cwd basename> · <session id
  first 8>", tag: sessionId})`. Permission `denied` → toggle renders disabled.
- **Hub:** title from snapshot `config.hubTitle`; subtitle stays
  `Orchestrator · <cwd basename>` — if the title *is* "Orchestrator", subtitle
  shows just the cwd basename (no dupe). Generic dot-logo glyph.
- Client state additions: `plans`, `config`, `drawerAgentId`,
  `prevTurnActive` per session, `lastSeenErrorAt` per agent — all reset in
  `replaceSnapshot()`.
- v1 behaviors that must survive: session picker + follow-latest, hub pulse on
  `turnActive`, link draw/flow animation, enter/reflow motion, done
  dim-then-fade lifecycle, empty state.

## 14. Narrator — `server/narrator.mjs` (default OFF)

```js
export function createNarrator({ config, getRunningAgents, getNewLogEntries,
                                 onNarrative }) → { tick() }
```

Server calls `tick()` every 5 s **only when `config.narration.enabled`**. Per
running agent: when ≥ `minNewLines` new log entries since its last narration
AND ≥ `debounceMs` since its last spawn AND running narrations <
`maxConcurrent`: spawn
`claude -p --model <config.narration.model>` with
`env: {...process.env, FLEET_IGNORE: "1"}`, prompt = "One sentence, ≤120
chars, present tense, plain text: what is this coding agent doing right now?"
+ the last ≤15 log lines on stdin. On success (exit 0 within `timeoutMs`,
else SIGKILL): `onNarrative(agentId, text.trim().slice(0, 160))` → server sets
`narrative`/`narrativeAt`, broadcasts the agent. Failures → silent per-agent
backoff (2× debounce). `spawn` ENOENT → disable for process lifetime, one
`console.warn`.

The self-observation guard is two-sided: narrator sets `FLEET_IGNORE=1` in the
spawned env (hooks are children of that `claude` process, so they inherit it);
the hook exits 0 on seeing it (§9.1).

## 15. Demo v2 — `scripts/demo.mjs`

Emits **neutral** events (`source: "demo"`, session `demo-<pid>`) to the
default/overridden events path. `--fast` skips sleeps; one progress line per
event on stdout. Storyline (~60 s):

1. `session.start` + `turn.start`; `plan.doc` (markdown with a 4-item list) +
   4 `plan.step`s (pending).
2. Step 1 → active. Builder: `agent.spawn-pending` (no id) →
   `agent.spawn-pending` with `agentId: "demo-b1"`, `model:
   "claude-sonnet-5"` (exact-claim path) → `agent.start demo-b1` → ≥4
   activities (phase start/end pairs; two carrying `file:` —
   `server/server.mjs`, `public/index.html`) → one activity with explicit
   `error: true` (red flick) → recovery activity.
3. Codex lane: spawn-pending (no id, `codex-runner`) → `agent.start demo-c1`
   (fuzzy-claim path) → activities incl. `file: public/index.html` while
   demo-b1 also lists it and both run (**collision**).
4. `agent.start demo-s1` (`agentType: "claude"`) with **backdated** `t`
   (start −3 min, one activity −150 s) → renders stalled immediately.
   The reducer trusting `evt.t` is load-bearing for this — don't "fix" it.
5. Step 1 → done, step 2 → active. `agent.end demo-b1` with `finalMessage`.
6. Null-id codex-direct pair: `agent.start {agentId: null,
   agentType: "codex-direct"}` → activities → `agent.end {agentId: null,
   agentType: "codex-direct"}`.
7. `agent.end demo-c1` (finalMessage), `agent.end demo-s1`, steps 3/4 →
   done, `turn.end` (notification fires if enabled + tab hidden).

## 16. v2 acceptance criteria

1. `node --check` on every `.mjs`; `node --test test/` green (adapter suite
   over `test/fixtures/`, incl.: garbage/oversize/unknown input → `[]`;
   failing-tool fixture produces only a `phase:"start"` activity; TaskCreate
   Post → plan.step with `stepId` from `tool_response.task.id`; FLEET_IGNORE
   handled by hook not adapter).
2. `FLEET_IGNORE=1 node hooks/emit-event.mjs < any-fixture` appends nothing;
   without the env var, the SubagentStart fixture appends exactly one valid
   `agent.start` line to a scratch `FLEET_EVENTS_FILE`; garbage stdin exits 0.
3. Fresh server boot with no events file serves `/` and `/healthz`; SSE
   connect delivers a v2 snapshot with `config.hubTitle`; a v1-format raw
   line in the file is skipped silently; corrupt `fleet.config.json` boots on
   defaults.
4. `npm run demo -- --fast` then fresh SSE connect: demo session present,
   plan has 4 steps with final statuses done, agents include exact-claim
   builder (model "Claude Sonnet 5" via config; "claude-sonnet-5" prettified
   if event-supplied), fuzzy-claim codex-runner, synthesized-id codex-direct
   (done), stalled-eligible agent (`lastActivityAt` ≥ 150 s old), demo-b1
   `finalMessage` set, `public/index.html` in two agents' `files`,
   `GET /agents/demo-b1/log` returns ≥ 6 entries with one `error: true`.
5. UI against demo: plan rail shows 4 steps with correct dots; S1 tag on the
   builder card; collision highlight + topbar chip while both agents run;
   stalled amber card; red error flick; finalMessage on done cards; drawer
   opens with log + live-appends during a slow demo; bell requests permission
   in-click and notifies when hidden at turn end; zero console errors; zero
   external URLs (grep `http://`, `https://`, `//` in src/href outside
   comments); v1 behaviors intact (§13 last bullet).
6. Narrator: flag off → zero `claude` spawns across a full demo. Flag on with
   a shim `claude` on PATH → narrative appears on a running card ≤ 20 s,
   never > `maxConcurrent` concurrent spawns, timeout kill works, shim
   received `FLEET_IGNORE=1`. One real-`claude` smoke test → no
   narrator-caused lines in the events file.
7. Live end-to-end: with the v2 hook in place, a real Claude Code session
   spawning a subagent renders in the UI; if the session creates tasks via
   TaskCreate/TaskUpdate, the plan rail populates with exact step ids;
   `FLEET_IGNORE=1 claude -p "hi"` writes nothing to the events file.

---

# FleetView v3 — amendment (2026-07-17)

v3 adds: publication + npx installer (§17), a Codex CLI adapter behind an
argv dispatch (§18), token/cost enrichment from transcripts (§19), and
carried-over fixes (§20). Constraints unchanged: zero npm dependencies,
Node ≥ 20 ESM, hook is a pure observer (always exit 0), single-file UI with
no external requests, SSE full-record upserts by id, reducer trusts `evt.t`.

## 17. Publication & npx installer

### 17.1 Pre-publication sweep (run before the repo flips public)

Results recorded here when executed:

- Full-history secrets grep (`api[_-]?key|token|secret|password|sk-ant|ghp_|
  AKIA|PRIVATE KEY` etc.) — **run 2026-07-17: clean** (all hits are matcher
  code / design tokens / usage-token fields).
- Author identity `Simon Beesley <psymonbeesley@gmail.com>` becomes public —
  accepted (Simon's call; history rewrite declined as needless).
- `test/fixtures/*.json` keep their `/Users/simon/...` paths and session
  UUIDs verbatim: they are empirically captured contract data asserted by
  tests; scrubbing would falsify the record. No secrets in them (verified).
- README fully genericized (no machine-specific paths). Spec §1–§16 stays
  verbatim as the historical contract; paths in it are from the original dev
  machine. `docs/V3-BOOTSTRAP.md` likewise historical.
- The visibility flip itself is a USER action (`gh repo edit`), never an
  agent's.

### 17.2 Installer contract — `bin/install.mjs`

Run as `npx github:psymonbee/fleeview` (bin name `fleetview`). Zero-dep,
shebang `#!/usr/bin/env node`, ~250 lines. All home-relative paths derive
from `os.homedir()` (the test seam — tests run with a scratch `HOME`).

**Self-vendoring copy** (npx cache is ephemeral; hooks need a stable
absolute path): the bin resolves its package root via `import.meta.url`,
copies the whitelist `hooks/ adapters/ server/ public/ scripts/
fleet.config.json package.json README.md docs/FLEETVIEW-SPEC.md` to
`~/.lumenade/app.staging-<pid>` (`fs.cpSync` recursive), then removes any
old `~/.lumenade/app` and renames staging into place. Re-run = upgrade.
Exception: if the existing `app/fleet.config.json` differs from the bundled
default, the user's copy is preserved (notice printed).

**Settings merge** into `~/.claude/settings.json`:
1. Missing file → create with just the hooks block. Unparseable JSON →
   **abort with a message, touch nothing** (exit non-zero).
2. Back up to `~/.claude/settings.json.fleetview-backup-<ISO>`.
3. For each of the 8 events (SessionStart, SessionEnd, UserPromptSubmit,
   Stop, SubagentStart, SubagentStop, PreToolUse, PostToolUse): remove any
   existing entry whose command contains `/hooks/emit-event.mjs`
   (dedupe/upgrade), then append
   `{"matcher": ".*"` (Pre/PostToolUse only) `, "hooks": [{"type":
   "command", "command": "<abs-node> <app>/hooks/emit-event.mjs", "timeout":
   5}]}` — `".*"` matches the verified live shape (README v2 showed `""`; the
   installer emits `".*"`). `<abs-node>` is an **absolute** interpreter path
   (`process.execPath`), never a bare `node` — see §17.4.
4. All other top-level keys and all non-FleetView hook entries preserved
   untouched. Write via temp file + rename. Key order may change
   (documented as acceptable).

**Flags:** `--yes` (non-interactive; without it and with a TTY, plain-text
confirm), `--uninstall` (remove all hook entries containing
`/hooks/emit-event.mjs`, print `rm -rf ~/.lumenade` instructions, leave
backups), `--dev <repo-path>` (wire hooks at a checkout instead of copying
— what the dev machine uses), `--with-codex` (also wire Codex hooks per
§18.4; prints "experimental"), `--start` (run the server foreground after
install; no daemonization — README documents launchd as a user option).

**package.json:** name → `"fleetview"`, add
`"bin": {"fleetview": "bin/install.mjs"}` and `"test": "node --test"`
(bare — `node --test test/` dir form breaks on Node 22). `"private": true`
stays (blocks registry publish only; git installs unaffected).

### 17.3 Removal

`npx github:psymonbee/fleeview --uninstall` (or hand-delete the 8 hook
entries), then `rm -rf ~/.lumenade`. Backups under `~/.claude/` are left
for the user. No other machine state exists.

### 17.4 Interpreter resolution (added 2026-07-18)

Hook commands name the interpreter by **absolute path** — `process.execPath`
captured at install time — never a bare `node`. Hooks are spawned by
whatever launched the harness, and a GUI-launched `Claude.app` inherits the
macOS default `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`), which contains **no**
nvm/fnm/volta node. A bare `node` there fails with "command not found",
and it fails *silently* — a failing hook neither blocks the harness nor
surfaces an error — so `~/.lumenade/events.jsonl` is never created and the
canvas stays permanently empty with no diagnostic.

Found on the first fresh-machine run (2026-07-18): Claude launched from
`/Applications/Claude.app`, node available only under `~/.nvm`. Structurally
invisible on a dev box that launches the `claude` CLI from an nvm-loaded
shell, because the hook then inherits that shell's `PATH` — which is exactly
why v1–v4 never caught it. Applies to all three emitters: the 8 Claude
hooks, the 10 Codex plugin hooks, and the printed `notify` fallback.
Trade-off accepted: the baked path pins the node that ran the installer, so
removing that node version requires re-running the installer.

## 18. Codex CLI adapter

### 18.1 S2 probe gate

`adapters/codex.mjs` may not be written until this section's §18.3 mapping
contains only field names verified from captured payloads
(`test/fixtures/codex/`). Probe procedure: scratch project (never the real
`~/.codex/config.toml` — use `-c` CLI config overrides), a capture script
wired for all 8 Codex hook events (PreToolUse, PostToolUse, PreCompact,
PostCompact, SessionStart, SubagentStart, SubagentStop,
PreToolUsePermissionRequest), runs via `codex exec --json
--dangerously-bypass-hook-trust` covering: trivial task, failing command
(does failure emit PostToolUse?), subagent spawn, permission request,
`notify` "turn-ended" shape. Findings recorded below (S2 notes), fixtures
committed, sanitized of anything secret-like.

**S2 findings (probe run 2026-07-17, Codex CLI 0.144.5 — full notes in
`test/fixtures/codex/PROBE-NOTES.md`):**

- **Hooks are plugin-gated.** `codex exec` fired zero hooks across four
  project-local hooks.json wirings (with `--dangerously-bypass-hook-trust`).
  Working hooks.json files exist only inside installed-plugin packages;
  registration (`codex plugin add`) is a persistent, account-linked change —
  a USER action, never an agent's. Consequence: **no runtime hook payloads
  were captured; none are faked.**
- **The binary embeds draft-07 JSON Schemas for all hook payloads** —
  extracted verbatim to `test/fixtures/codex/schemas/*.json`. Authoritative
  for field names/types/required lists (not example values). The real event
  set is **10 events**: PreToolUse, PermissionRequest (own event — the
  earlier "PreToolUsePermissionRequest" was a strings-dump misread),
  PostToolUse, PreCompact, PostCompact, SessionStart, **UserPromptSubmit**,
  SubagentStart, SubagentStop, **Stop**. So Codex has real turn boundaries.
- Field names are deliberately Claude-Code-compatible: `session_id`,
  `tool_name`, `tool_input`, `tool_use_id`, `tool_response`, `agent_id`,
  `agent_type`, `agent_transcript_path`, `last_assistant_message`,
  `transcript_path`, plus Codex-only `turn_id`; `permission_mode` uses
  Claude Code's exact enum. Hook env carries `CLAUDE_PLUGIN_ROOT`-style
  duplicates — drop-in compatibility is clearly intentional.
- **notify works without any plugin** (top-level config key, `-c`
  overridable): payload delivered as one JSON-encoded argv arg, kebab-case
  fields — live-captured fixture `notify-turn-ended.json`:
  `{type: "agent-turn-complete", "thread-id", "turn-id", cwd,
  "input-messages", "last-assistant-message"}`.
- Failure semantics unobserved (no hooks fired); `codex exec` may lack an
  interactive-approval path entirely (no `-a` flag on exec), so
  PermissionRequest may never fire in exec mode.
- `codex exec --json` stdout carries usage on `turn.completed`
  (`.usage.{input_tokens, cached_input_tokens, output_tokens,
  reasoning_output_tokens}`) — future `agent.usage` source, out of v3 scope.

**Gate disposition:** field names are verified (binary schemas = the wire
contract), so the adapter is built against them with fixtures labelled
`-SYNTHETIC` (schema-exact shapes, fabricated values — same convention as
v2's `pre-exitplanmode-SYNTHETIC.json`). Live hook validation is deferred
until the USER wires the plugin; Codex support ships as **experimental**.

### 18.2 `adapters/codex.mjs`

`export function translate(payload, now = new Date()) → NeutralEvent[]`,
same contract as §9: stateless, pure, never throws, `[]` on
malformed/unwanted input. `source: "codex"`. **Id namespacing:**
`sessionId = "codex:" + raw` always; `agentId = "codex:" + raw` whenever
non-null. Applied uniformly at the adapter boundary so cross-harness id
collisions in the shared events file are impossible; reducer, SSE, log
endpoint, and UI are untouched. Truncation limits as §9. Local private
helpers (truncate etc.) — adapters stay standalone, no shared module.

### 18.3 Mapping table (FINAL — field names per §18.1 schemas; `ns(x)` = `"codex:" + x`)

All events: `sessionId = ns(session_id)`, `source: "codex"`. Truncation
limits as §9.

| Codex hook event | Neutral event |
|---|---|
| SessionStart | `session.start {cwd, transcriptPath: transcript_path}` |
| UserPromptSubmit | `turn.start` |
| Stop | `turn.end` |
| SubagentStart | `agent.start {agentId: ns(agent_id), agentType: agent_type, model}` |
| SubagentStop | `agent.end {agentId: ns(agent_id), agentType: agent_type, finalMessage: truncate(last_assistant_message, 300), transcriptPath: agent_transcript_path}` |
| PreToolUse **with** `agent_id` | `agent.activity {agentId: ns(agent_id), phase: "start", callId: tool_use_id, tool: tool_name, hint, file}` (hint/file rules as §9) |
| PostToolUse **with** `agent_id` | `agent.activity {agentId: ns(agent_id), phase: "end", callId: tool_use_id, tool: tool_name}` |
| PreToolUse / PostToolUse without `agent_id` | `[]` (main-loop calls not rendered — parity with §9) |
| PermissionRequest | `[]` (v3 — carries no `tool_use_id`, likely never fires in exec mode) |
| PreCompact / PostCompact | `[]` |
| notify payload `type: "agent-turn-complete"` | `turn.end` for `sessionId: ns(thread-id)` (any other notify type → `[]`) |

No SessionEnd hook exists — codex sessions rely on the 24 h idle prune.
Known cosmetic limitation: `resolveAgentMeta` has no provider notion per
model, so codex agents fall back to config/`fallbackAgent` provider unless
the user adds `config.agents` entries for Codex agent types; `modelNames`
gains a `"gpt-5.5"` prettifier entry.

### 18.4 Hook dispatch — `hooks/emit-event.mjs`

Adapter selected by `process.argv[2]` against a hardcoded whitelist:
`claude-code` (default when the arg is missing — the live wiring keeps
working with zero settings changes), `codex` (stdin payload), and
`codex-notify` (payload is the **last argv argument**, a JSON-encoded
string — S2-verified; notify never uses stdin). Unknown arg → silent exit
0. FLEET_IGNORE guard unchanged and checked first. The rewrite of this
LIVE file is a single atomic Write followed immediately by `node --check`.

**Wiring reality (per §18.1; corrected 2026-07-18 after the first live
registration on Codex CLI 0.144.5 — see §18.5):** `codex plugin marketplace
add <dir>` requires `<dir>` to be a **marketplace root** (a directory whose
`.agents/plugins/marketplace.json` *lists* plugins), not a bare plugin. The
installer's `--with-codex` therefore scaffolds a marketplace at
`<app>/codex-plugin/`:

- `.agents/plugins/marketplace.json` — `{name: "fleetview", interface:
  {displayName}, plugins: [{name: "fleetview", source: {source: "local",
  path: "./plugins/fleetview"}, policy: {installation: "AVAILABLE",
  authentication: "ON_INSTALL"}, category}]}`.
- `plugins/fleetview/.codex-plugin/plugin.json` — the plugin manifest in
  Codex's validation-ready shape: `name`, strict-semver `version`,
  `description`, `author.name`, and `interface {displayName,
  shortDescription, longDescription, developerName, category, capabilities,
  defaultPrompt}`. **No `hooks` field** — Codex ingestion rejects it as an
  unsupported manifest field.
- `plugins/fleetview/hooks.json` — wires the 10 events to
  `<abs-node> <app>/hooks/emit-event.mjs codex` (absolute interpreter,
  §17.4); format unchanged
  (`{hooks: {Event: [{matcher?, hooks: [{type: "command", command}]}]}}`,
  identical to shipping OpenAI plugins figma/replayio) and auto-discovered
  by convention (not referenced from the manifest).

It then **prints** the registration commands (`codex plugin marketplace add
<app>/codex-plugin` / `codex plugin add fleetview@fleetview`) plus the
no-plugin alternative: add
`notify = ["<abs-node>", "<app>/hooks/emit-event.mjs", "codex-notify"]` to
`~/.codex/config.toml` for turn-boundary capture only. The installer never
runs `codex` commands and never edits `~/.codex/*` — registration is
explicitly the user's action (persistent, account-linked).

### 18.5 Live registration (2026-07-18, Codex CLI 0.144.5)

First real `--with-codex` run on a fresh machine surfaced that the v4
scaffold — a bare `<app>/codex-plugin/` holding `.codex-plugin/plugin.json`
+ `hooks.json` — is rejected by `codex plugin marketplace add` with
"marketplace root does not contain a supported manifest". 0.144.5 separates
**marketplace** (a manifest listing plugins) from **plugin**; `marketplace
add` takes the former, `plugin add <name>@<marketplace>` installs the
latter. Fix: the §18.4 marketplace wrapper above. Authoritative schema lives
on-disk in Codex's own `plugin-creator` skill
(`~/.codex/skills/.system/plugin-creator/references/plugin-json-spec.md` +
`scripts/create_basic_plugin.py`) and in shipping marketplaces
(`~/.codex/.tmp/**/.agents/plugins/marketplace.json`). **Verified** via an
isolated-`CODEX_HOME` probe: `marketplace add` → `plugin add
fleetview@fleetview` → `plugin list` reports `installed, enabled`, with
`hooks.json` bundled into the plugin cache. Still open (unchanged
experimental status): live hook *firing* during a Codex session — validated
only when a real `codex` run paints Codex cards on the canvas.

## 19. Token/cost enrichment

### 19.1 State additions

`Session` gains `transcriptPath` (from `session.start`, previously
dropped), `tokens`, `costUsd`. `AgentRun` gains `transcriptPath` (from
`agent.end`, authoritative when present), `tokens
{in, out, cacheRead, cacheWrite}`, `costUsd`. All default `null`; included
in snapshots and upserts.

### 19.2 New neutral kind `agent.usage`

`{agentId: string | null, tokens {in, out, cacheRead, cacheWrite},
costUsd?}` — `agentId: null` applies to the Session (broadcast
`{type: "session", session}`), else to that AgentRun (broadcast
`{type: "agent", agent}`). Upsert semantics. **MUST NOT bump
`lastActivityAt`** at either session or agent level — token bookkeeping
must never mask a stall (the top-of-`applyEvent` freshness bump becomes
conditional on `kind !== "agent.usage"`). Emitted by the demo (explicit
`costUsd`) and available to future sources (`codex exec --json` carries
token counts); the server-side enricher (§19.3) writes state directly via
callback and never appends to the events file.

### 19.3 Enricher sidecar — `server/enrich.mjs`

`createEnricher({config, getTargets, onUsage}) → {tick(), forget(key)}` —
DI factory like the narrator, never throws. Server arms it only when
`config.enrichment.enabled`, ticking every `intervalMs` (default 5000).

Targets (server-provided): running agents with a resolvable transcript
path — own `transcriptPath`, else derived
`dirname(session.transcriptPath)/<sessionId>/subagents/agent-<agentId>.jsonl`
(convention verified on disk 2026-07-17), gated on `existsSync` (which
naturally excludes demo/codex agents); agents ended < 60 s ago (final
sweep); sessions with a transcriptPath active < 10 min ago (main
transcript → session/hub tokens).

Per-path state: byte offset + partial-line buffer + per-message Map. Reads
are incremental, capped 1 MiB/file/tick. Per line: keep
`type === "assistant"` with `message.usage`; drop
`message.model === "<synthetic>"`. **Dedupe by `message.id`, last
occurrence wins** — transcripts repeat assistant lines per content block
with the same id, and the final line carries the true `output_tokens`
(verified 2026-07-17: one message read 10 then 54065; naive summing
overcounts ~5×). Totals and cost recomputed from the map; on change →
`onUsage(key, tokens, costUsd)` → server sets fields + broadcasts (no
`lastActivityAt` bump). Cost computed per message from that line's
`message.model` (handles mixed-model transcripts); lookup: exact id →
strip trailing date suffix → longest prefix; unknown model → tokens still
reported, `costUsd` stays null. `forget(key)` on prune.

### 19.4 Pricing config (fleet.config.json + built-in default)

```json
"enrichment": {
  "enabled": true, "intervalMs": 5000,
  "pricing": {
    "claude-fable-5":  { "in": 10, "out": 50, "cacheRead": 1,   "cacheWrite": 12.5  },
    "claude-opus-4-8": { "in": 5,  "out": 25, "cacheRead": 0.5, "cacheWrite": 6.25  },
    "claude-sonnet-5": { "in": 3,  "out": 15, "cacheRead": 0.3, "cacheWrite": 3.75  },
    "claude-haiku-4-5":{ "in": 1,  "out": 5,  "cacheRead": 0.1, "cacheWrite": 1.25  }
  }
}
```

USD per MTok, verified against current API pricing 2026-07-17 (cache read
= 0.1× input; 5-minute cache write = 1.25× input). All cache writes are
priced at the 5-minute rate — transcripts don't distinguish 5m/1h writes —
hence every $ figure is labelled "est." (Sonnet 5 also has $2/$10 intro
pricing through 2026-08-31; README footnotes both.) Shallow config merge
as ever: a user `enrichment` block replaces the whole default.

### 19.5 UI

Cards: compact badge next to the model pill — `fmtTokens(in+out)` (`999`,
`12.4k`, `1.2M`), hidden when `tokens == null`, full breakdown in `title`.
Drawer: 4 rows (in / out / cache read / cache write) + `est. $X.XXXX` when
`costUsd != null`. Hub: session-level badge from the active session.
Nothing new resets in `replaceSnapshot()` — tokens ride on records. All
§13 behaviors must survive; stall rendering especially (it is the visible
symptom if §19.2's no-bump rule breaks).

## 20. Carried-over fixes

- `.layout` gains `overflow-x: clip` (kills the drawer's 360px invisible
  scrollWidth contribution).
- `npm test` script (bare `node --test`).
- **Plan-step subject backfill:** in `adapters/claude-code.mjs`, the
  `hasAgentId` branches for TaskUpdate (Pre) and TaskCreate (Post) emit the
  `plan.step` event **in addition to** the `agent.activity` — task lists
  are session-shared, so subagent-created steps belong on the rail with
  real subjects. This is the actual cause of "(untitled step)" rows: the
  agent_id branch won and the subject-carrying step event was never
  emitted. Step-mapping logic is extracted into helpers and reused; no
  other mapping changes.

## 21. v3 acceptance criteria

1. `node --check` every `.mjs` incl. `bin/install.mjs`; `npm test` green
   (v2 suite + codex adapter + hook dispatch + enrich + reducer-usage).
   All tests use scratch `FLEET_EVENTS_FILE`, scratch `HOME`, ports 48xx.
2. Back-compat: the no-arg hook behaves identically to v2 for claude-code
   payloads — the live settings.json needs no change on upgrade.
3. `npm run demo -- --fast` + fresh SSE connect: all §16.4 criteria still
   hold, plus demo-b1 `tokens` with `in+out ≥ 96k` and non-null `costUsd`,
   session-level tokens present, and **demo-s1 still renders stalled**
   (proves §19.2's no-bump rule).
4. UI vs demo: tokens badges on cards, drawer breakdown + est. $, hub
   session badge; `document.documentElement.scrollWidth === clientWidth`
   with the drawer open; zero console errors; zero external URLs; §16.5
   behaviors intact.
5. Live enrichment: a real session spawning a subagent shows a growing
   badge while running (≤ ~10 s lag) and a final sweep after stop; totals
   exactly match an independent dedupe-sum of the same transcript.
6. Live plan rail: a task created by a subagent shows its real subject —
   no "(untitled step)".
7. Codex (two tiers, per §18.1's gate disposition): **(a) automated —**
   piping every `-SYNTHETIC` codex fixture and the live-captured notify
   fixture through `node hooks/emit-event.mjs codex|codex-notify` yields
   `source:"codex"` events with `codex:`-prefixed ids that a 48xx test
   server reduces and renders without colliding with a claude-code
   session's ids; **(b) deferred (USER-wired plugin) —** a real
   `codex exec` run under the registered plugin produces live events that
   render in the UI. (b) is not a v3 ship-blocker; Codex support is
   labelled experimental until it passes.
8. Installer vs scratch HOME: fresh install writes 8 entries with `".*"`
   matchers and a populated app dir whose copied hook passes `node
   --check`; merge preserves sentinel keys + foreign hooks; re-run is
   idempotent (no duplicate entries); corrupt settings → abort, file
   untouched; `--uninstall` removes only FleetView entries; backup exists
   and parses.
9. Regressions: `FLEET_IGNORE=1 claude -p "hi"` writes nothing; narrator
   flag off → zero `claude` spawns; corrupt `fleet.config.json` boots on
   defaults including the enrichment block.
10. Publication (USER steps): sweep §17.1 all-pass; README has no
    machine paths; repo public; `npx github:psymonbee/fleeview` works from
    a clean HOME.

# FleetView v4 — amendment (2026-07-17)

v4's driving shift: design for users who are not the original author. Two
audiences: **bolt-on users** (existing Claude Code agents/flows — their
agents already render, but degrade to `fallbackAgent` styling) get agent
auto-discovery (§22); **blank-slate users** (no orchestration) get an
opt-in starter fleet (§23). Plus: nested-spawn lineage (§24), pre-plan
session activity (§25), capability chips (§26), a recorded descope (§27),
and carried-over fixes (§28). Constraints unchanged: zero npm
dependencies, Node ≥ 20 ESM, hook is a pure observer, single-file UI, SSE
full-record upserts by id, reducer trusts `evt.t`. The schema stays `v: 1`
— every addition here is additive, and §8's skip rule means old reducers
ignore new kinds/fields silently. `hooks/emit-event.mjs` is untouched in
v4 (the §2 keep-rule is v1-historical; since v2 all policy lives in the
adapters).

## 22. Agent auto-discovery (amends §10)

New module `server/discovery.mjs`, zero-dep, never throws:

- `parseFrontmatter(text)` — hand-rolled: file must begin `---\n`; scan to
  the closing `\n---` fence; inside, only single-line `key: value` scalars
  are read (`name`, `description`, `model` — unknown keys ignored, values
  may be single- or double-quoted, CRLF tolerated). No fence, unterminated
  fence, or empty file → `null`. Multiline values are ignored (the line
  simply doesn't match `key: value`).
- `scanAgentDir(dir)` — reads `*.md` files (non-recursive), returns
  `{ [name]: {label, description?, model?} }` where `name` = frontmatter
  `name` if present, else the filename stem. Label = name. Missing dir or
  unreadable file → skipped silently.
- Discovery targets: `~/.claude/agents` (scanned at server boot) and
  `<session.cwd>/.claude/agents` (scanned on each `session.start` — that
  event is rare, so re-scan-on-session-start is the entire cadence story;
  no watchers). Project-level entries shadow user-level ones per name.
  Discovered maps are held in module state on the server, keyed
  user-level vs per-session.

**`resolveAgentMeta` precedence becomes** (replacing §10's 3-step):

1. event `model` if set — after **alias resolution** (below), prettified
   via `modelNames` (unchanged longest-prefix rule);
2. else user-file `config.agents[agentType]` (an agents map present in the
   on-disk `fleet.config.json` — explicit config always beats discovery);
3. else discovered entry (project-level, then user-level), with `model`
   alias-resolved and prettified, `provider` inferred (below);
4. else built-in default `agents` entry;
5. else `{label: agentType, ...config.fallbackAgent}` — with the codex
   exception: **if the event's `sessionId` starts `codex:`, the fallback
   provider is `"openai"`** (kills the v3 nit where codex agents rendered
   with the anthropic accent).

New config key `modelAliases` (top-level, so the shallow merge composes
cleanly with preserved v3 configs), built-in default:

```json
{ "modelAliases": { "sonnet": "claude-sonnet-5", "opus": "claude-opus-4-8",
                    "haiku": "claude-haiku-4-5", "fable": "claude-fable-5" } }
```

Alias resolution maps a bare alias (as agent frontmatter uses: `model:
sonnet`) to its canonical id before `modelNames` prettification; `inherit`
and unknown aliases pass through untouched. Provider inference for
discovered agents: `"anthropic"` unless the alias-resolved model id
starts `gpt`/`o[0-9]`/`codex` → `"openai"`.

The shipped `fleet.config.json` trims its `agents` block to the two codex
entries (`codex-runner`, `codex-direct`) so discovery serves
builder/checker on the dev machine too; the built-in defaults keep all
four (step 4) so the demo and preserved v3 configs render identically.

## 23. Starter agents — installer flag (amends §17.2, §17.3)

New repo dir `starter-agents/` with `builder.md`, `checker.md`,
`codex-runner.md` — genericized rewrites of the dev machine's agent
definitions (no personal wording; codex-runner's description states it
requires the Codex CLI, which is harmless if absent: the agent simply
never gets spawned). Frontmatter: `name`, `description`, `model` (alias
form, exercising §22). Added to the installer's `VENDOR_WHITELIST`.

`bin/install.mjs --with-agents`: after the hooks merge, copy each starter
file into `~/.claude/agents/` — **per-file `existsSync` guard, never
overwrite**, print one line per file: `written` or `skipped (exists)`.
All three are always offered (owner's decision — no PATH detection).
`--uninstall` never touches `~/.claude/agents`; it prints the three
paths so the user can remove them by hand if wanted. Usage text gains the
flag; §17.3's "no other machine state" sentence is amended to name
`~/.claude/agents/*` as user-owned once written.

## 24. Nested-spawn lineage (amends §8, §9, §11, §13)

**S3 probe (run 2026-07-17, live captures in
`test/fixtures/nested-*.json`):** a subagent CAN spawn a subagent, and
every hook fires:

- Child `SubagentStart` fires normally (`agent_id`, `agent_type` only — no
  parent field on any payload).
- The parent link lives on the **parent's own Agent tool events**: its
  `PreToolUse` (top-level `agent_id` = parent, `tool_input.description`/
  `subagent_type`) fires immediately **before** the child's
  `SubagentStart`; its `PostToolUse` carries top-level `agent_id` = parent
  **and** `tool_response.agentId` = child (plus `resolvedModel`,
  `status: "completed"`, full usage) — but for the observed synchronous
  nested spawn it fires **after the child's `SubagentStop`**. So the
  Pre-side path is what links the tree while the child runs; the
  Post-side path is the authoritative repair.
- Child `SubagentStop` fires normally (`agent_transcript_path`,
  `last_assistant_message` — §19 enrichment works unchanged for nested
  agents).

**§8:** `agent.spawn-pending` gains optional `parentAgentId`;
`agent.start` gains optional `parentAgentId`. Additive; `v` stays 1.

**§9:** the `Agent`/`Task` **with** `agent_id` branches change from
activity-only to activity-plus-lineage:

- `PreToolUse` `Agent`/`Task` **with** `agent_id` → the existing
  `agent.activity {phase:"start"}` **plus**
  `agent.spawn-pending {agentType, description,
  parentAgentId: agent_id}` (fuzzy — no child id exists yet).
- `PostToolUse` `Agent`/`Task` **with** `agent_id` and with
  `tool_response.agentId` → the existing `agent.activity {phase:"end"}`
  **plus** `agent.spawn-pending {agentId: tool_response.agentId,
  parentAgentId: agent_id, agentType, description,
  model: tool_response.resolvedModel}` (exact). Without
  `tool_response.agentId` → activity only (unchanged).

**§11:** `AgentRun` gains `parentId` (default `null`; included in
snapshots/upserts — old clients ignore it). Fuzzy `pendingSpawns` entries
and `exactPending` records carry `parentAgentId` through both claim paths
(§11's claim order is unchanged); an exact claim **overwrites** a
fuzzy-set `parentId` (authoritative repair — covers a fuzzy mis-claim
when same-type spawns race). If an exact spawn-pending arrives for an
agent that already ended, update the record anyway (post-mortem link).
Self-reference guard: `parentId === agentId` → treated as null.

**§13:** ordering: children render immediately after their parent
(depth-first within the `startedAt` sort); indent 24 px per depth level,
**capped at depth 2** (deeper nesting renders at depth-2 indent). Edge:
`renderPath` sources the bézier at the **parent card's** left-center
(same x as the child's column, offset up) instead of the hub when
`parentId` resolves to a rendered card; missing/unresolved parent → hub
source (flat fallback, exactly v3 behavior). `CARD_H`/`RHYTHM`
unchanged. Drawer header shows `spawned by <parent label>` when set.

Codex lineage: deferred — the embedded schemas expose no parent field
(`turn_id` is not lineage). Recorded, not attempted.

## 25. Session activity — pre-plan orchestrator (amends §8, §11, §12, §13)

Problem (v4 parking lot): the UI looks dead between `session.start` and
the first spawn while the orchestrator reads/plans.

**§8:** new kind `session.activity {tool, hint?` (≤120)`, file?}` —
main-loop tool call, no agent involved. Additive.

**§9 (both adapters):** main-loop `PreToolUse` (no `agent_id`) whose
`tool_name` is **not** one of {`Agent`, `Task`, `TaskCreate`,
`TaskUpdate`, `ExitPlanMode`, `mcp__codex__*`} → `session.activity
{tool: tool_name, hint, file}` (same hint/file derivation as
`agent.activity`). **Pre only** — main-loop `PostToolUse` of plain tools
stays `[]` (halves the volume; no duration display at session level).
The codex adapter additionally maps its plugin-gated `PermissionRequest`
→ `session.activity {tool: "permission", hint: tool_name}` and
`PreCompact`/`PostCompact` → `session.activity {tool: "compact",
hint: "pre"|"post"}` (closes §18.3's unmapped rows; §28c).

**§11:** `Session` gains `currentActivity` (`{tool, hint?, file?, t}` |
null). Set on `session.activity`; cleared on `agent.spawn-pending`
(the orchestrator is delegating — the fleet takes over the story) and on
`turn.end`. Per-session log ring `sessionLogs` (cap 50, same shape as
`agentLogs` entries) feeds a new endpoint `GET /sessions/:id/log`.
`session.activity` bumps session freshness only — it must never touch
any agent's `lastActivityAt` (§19.2's no-bump rule is about usage; this
is the session-side analogue: agent stall detection stays agent-local).

**§12:** `session` records in SSE (snapshot + upserts) carry
`currentActivity`. The ring is endpoint-only (not in snapshots), like
agent logs.

**§13:** the hub shows `currentActivity` as a one-line activity readout
under the subtitle (`tool: hint` truncated to fit) while the session is
`turnActive` and `currentActivity` is non-null; hidden otherwise. The
empty-state text changes from implying "nothing happening" to reflecting
that the orchestrator is working when `currentActivity` is set.

Events-file growth: one extra line per main-loop tool call (Pre only) —
unbounded file already documented; README gains a note, rotation stays
out of scope for v4.

## 26. Capability chips — skills & MCP (amends §9, §11, §13)

Derived, no new kind. **§9:** the `agent.activity` hint chain gains a
`Skill` case: `tool === "Skill"` → `hint = truncate(tool_input.skill ??
"", 120)` (the skill name, not the args). Applies to `session.activity`
hint derivation too.

**§11:** on every `agent.activity` (and `session.activity`), derive
capability tags from `tool`: `mcp__<server>__<tool>` → `{kind: "mcp",
name: <server>}` (first `__`-delimited segment after the prefix);
`tool === "Skill"` with a hint → `{kind: "skill", name: hint}`.
`AgentRun.capabilities` and `Session.capabilities`: insertion-ordered
deduped array (dedupe key `kind:name`), **cap 8** (first 8 win), carried
on record upserts.

**§13:** capability chips render **in the existing files-row** on agent
cards (capabilities first, then files; the row's existing ≤3-visible +
`+N` overflow budget is shared) so `CARD_H`/`RHYTHM` are untouched. Chip
shows the name with a small glyph distinguishing skill vs MCP; the drawer
shows the full capability list as its own row above files.

## 27. Usage limits — parked (record only)

The v4 parking lot asked for `/usage`-style limit visibility. Probed
2026-07-17: **Claude Code writes no rate-limit/window/reset data anywhere
on disk** — transcripts carry per-message `usage` token counts only;
`~/.claude/stats-cache.json` holds daily message/session/toolCall counts;
no statsig/limit/rate files exist. Codex **does** expose real limits
(rollout files' `token_count` event: `rate_limits {used_percent,
window_minutes, resets_at, plan_type}`, see
`test/fixtures/codex/PROBE-NOTES.md`) but that source is behind the
plugin gate. Decision (owner, 2026-07-17): parked for v5 rather than
built on the wrong data. This section exists so v5 does not relearn the
probe.

## 28. Carried-over fixes

- **(a) Narrow-viewport band:** with the rail visible, `248px + 820px`
  stage min-width forces a horizontal scrollbar between 900–1068 px. Fix:
  auto-collapse the rail below 1069 px (same collapsed state the user
  toggle produces). Acceptance: `document.documentElement.scrollWidth ===
  clientWidth` at 920, 1000, and 1280 px.
- **(b) `agent.start` transcriptPath:** §8 declares it; the reducer drops
  it today (only `session.start`/`agent.end` retain). One-liner in the
  `agent.start` case; matters for any future source that supplies it at
  start.
- **(c)** Codex `PermissionRequest`/`Pre-PostCompact` mapping — specified
  in §25, closes §18.3's unmapped rows.

## 29. v4 acceptance criteria

1. `node --check` every changed `.mjs`; `npm test` green (v2+v3 suites
   plus new: discovery, reducer-v4, extended adapter/codex-adapter/
   install suites). All tests: scratch `FLEET_EVENTS_FILE`, scratch
   `HOME`, ports 48xx.
2. Back-compat: no-arg hook path unchanged for v3-era payloads; live
   settings.json needs no edit on upgrade; a v3 events log replays into a
   v4 server without error (new fields absent → old behavior).
3. Discovery: scratch HOME with a seeded `~/.claude/agents/<name>.md` →
   that agentType renders discovered label/model (alias-resolved,
   prettified)/provider; explicit user-file `config.agents` entry beats
   discovery; `codex:`-namespaced unknown type gets the openai accent;
   corrupt/fenceless frontmatter files are skipped without error.
4. Starter agents: `--yes --with-agents` writes 3 files (printed);
   pre-existing file preserved byte-identical (printed as skipped);
   without the flag nothing is written; `--uninstall` leaves them;
   vendored app contains `starter-agents/`.
5. Lineage: piping `nested-*.json` fixtures through the no-arg hook
   yields the §24 event pairs; reducer sets `parentId` under both
   orderings (pre-fuzzy then start; start then exact-post); missing
   parent renders flat; demo's nested card indents under its parent with
   a parent-sourced edge.
6. Session activity: main-loop `Read` Pre → one `session.activity`;
   main-loop `Agent` Pre → spawn-pending only (no session.activity);
   plain main-loop Post → `[]`; hub shows the activity line pre-plan and
   clears it on delegation/turn-end; **demo-s1 still renders stalled**.
7. Capabilities: `mcp__codex__foo` activity → chip `mcp:codex` (deduped);
   `Skill` activity → chip `skill:<name>`; cap 8 holds; card geometry
   unchanged (CARD_H/RHYTHM byte-identical).
8. Viewport: acceptance widths per §28a; zero console errors; zero
   external URLs.
9. Live: a real session shows pre-plan hub activity before the first
   spawn, discovered styling on a custom agent, and a nested spawn
   drawing a parent-sourced edge while the child runs (Pre-side link).

## 30. Non-coding starter agents (amends §23)

`starter-agents/` gains `researcher.md` (model alias `sonnet`) and
`writer.md` (model alias `opus`) — a research/writing pair demonstrating
that agent fleets, and therefore FleetView, are not coding-specific.
Same frontmatter contract as §23 (`name`, `description`, `model` in
alias form); the researcher's description tells the orchestrator to
spawn one per focused question (parallel fan-out is the FleetView demo
value), the writer's states it synthesizes supplied material and never
investigates.

Installer mechanics are §23's, unchanged in kind: `STARTER_AGENTS` in
`bin/install.mjs` (and the test suite's mirror copy) now iterates five
files, with the same per-file never-overwrite guard, the same
`written`/`skipped (exists)` lines, the same `--uninstall` leave-in-place
listing, and the usage text updated to name all five. `starter-agents/`
was already a directory entry in `VENDOR_WHITELIST`, so vendoring picks
the new files up with no installer change.

No schema, SSE, or UI change: discovery (§22) styles the new agent
types with zero configuration — which is the point being demonstrated.
§29.4's "writes 3 files" is historical v4 record and stands; the
current acceptance count is five.
