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
