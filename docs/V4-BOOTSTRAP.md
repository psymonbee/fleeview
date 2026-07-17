# FleetView v4 — session bootstrap

> **Superseded 2026-07-17 — v4 shipped.** Start new sessions from
> `docs/V5-BOOTSTRAP.md`. Kept for the v3-era empirical-facts list it
> preserves.

Point a fresh Claude Code session at this file to start v4 with full context.
Repo: `/Users/simon/lumenADE` · GitHub: https://github.com/psymonbee/fleeview
(This file superseded the v3 bootstrap on 2026-07-17; v3 shipped the same day.)

## Where v3 left off (shipped 2026-07-17)

v3 is built, verified against `docs/FLEETVIEW-SPEC.md` §21 (106 tests green;
live-pipeline integration + browser sweep), and committed. On top of the v2
pipeline it added:

```
bin/install.mjs           npx installer: self-vendors to ~/.lumenade/app, merges
                          hooks into ~/.claude/settings.json (backup + dedupe),
                          --yes/--uninstall/--dev/--with-codex/--start
adapters/codex.mjs        Codex CLI translator (source:"codex", every id
                          namespaced "codex:<raw>"); translateNotify for the
                          no-plugin notify path (turn.end only)
hooks/emit-event.mjs      argv dispatch: no arg → claude-code (live wiring
                          unchanged), "codex" → stdin, "codex-notify" → last
                          argv arg, never reads stdin in that mode
server/enrich.mjs         token/cost sidecar: tails transcripts, dedupes by
                          message.id (last wins), prices per message via
                          config.enrichment.pricing; agent.usage neutral kind
public/index.html         tokens badge on cards, drawer in/out/cache + est. $,
                          hub session chip, .layout overflow-x: clip
```

Spec §17–§21 is the v3 contract; **amend the spec before changing any
schema/SSE/UI shape** — unchanged rule. `npm test` = bare `node --test`.

## USER steps still pending (only Simon can do these)

1. Flip the repo public: `gh repo edit psymonbee/fleeview --visibility public`
   (sweep §17.1 passed 2026-07-17: history clean; author identity
   `Simon Beesley <psymonbeesley@gmail.com>` becomes public — accepted).
   Optional: rename repo fleeview→fleetview (GitHub redirects old URLs).
2. Run the installer for real: `npx github:psymonbee/fleeview` on another
   machine, or `node bin/install.mjs --dev /Users/simon/lumenADE` on THIS one
   (keeps hooks pointing at the checkout — do NOT plain-install here or hooks
   move to ~/.lumenade/app).
3. If Codex capture is wanted: run the two `codex plugin` commands the
   installer prints with `--with-codex` (persistent, account-linked — that's
   why the fleet never ran them). §21.7(b) live validation happens then.

## v4 ideas (parking lot — Simon's own list, not scoped yet)

- **Surface usage limits in the UI.** Claude Code's `/usage` shows remaining
  usage limits but it's buried behind a command. Show the same info (or
  similar) prominently in the FleetView UI rather than hidden away — e.g. a
  persistent header/status element, not a drawer the user has to open.
- **Show skills/MCP servers in use per card.** Every agent card, including
  the orchestrator's, should surface which skills and/or MCP servers it's
  currently calling/using — not just tool activity in general.
- **UI looks dead before the first plan exists.** When a new session starts,
  nothing appears in the UI until the agent has written its own plan and
  started executing steps (i.e. until it starts "hiring" subagents). But the
  agent is doing real, visible-worthy things before that point (reading
  files, orienting, deciding on an approach) — those pre-plan actions should
  render too, so the tool doesn't look broken/idle during that gap.

Smaller carried-over nits from v3, pick up opportunistically: narrow-viewport
horizontal overflow below ~1068px (rail 248px + canvas min-width 820px — NOT
the drawer leak, which is fixed); codex agents render with the anthropic
accent (resolveAgentMeta has no per-model provider notion; add config.agents
entries for Codex agent types or extend §10); `agent.start` doesn't retain an
event-supplied `transcriptPath` (only session.start/agent.end do — matters if
a future source supplies it at start); PermissionRequest + Pre/PostCompact
are unmapped (§18.3); codex rollout-file enrichment (usage is in
`codex exec --json` `turn.completed` — a future agent.usage source).

## Hard-won empirical facts — do NOT relearn these

Everything in the v2 list still holds (failing tools emit PreToolUse only;
async Agent spawns carry tool_response.agentId; TaskCreate id arrives in the
Post response; headless claude never dispatches ExitPlanMode; hooks
hot-reload and `hooks/emit-event.mjs` is LIVE — atomic Write + immediate
`node --check`; never point a test server at `~/.lumenade/events.jsonl`, use
scratch `FLEET_EVENTS_FILE` + ports 48xx; the demo backdates `t` and the
reducer trusting it is load-bearing; FLEET_IGNORE guard is two-sided). New in
v3 (S2 probe, 2026-07-17, Codex CLI 0.144.5 — full notes in
`test/fixtures/codex/PROBE-NOTES.md`):

- **Codex hooks are plugin-gated.** Zero hooks fired across four
  project-local hooks.json wirings in `codex exec`, even with
  `--dangerously-bypass-hook-trust` (whose warning prints unconditionally —
  not evidence hooks loaded). Only installed plugins' hooks.json load.
- **The Codex binary embeds draft-07 schemas for all 10 hook events**
  (`test/fixtures/codex/schemas/`) — authoritative field names; deliberately
  Claude-Code-compatible (`session_id`, `tool_name`, `tool_use_id`,
  `agent_id`, same permission_mode enum, plus Codex-only `turn_id`). The
  event set includes UserPromptSubmit and Stop (real turn boundaries);
  `PermissionRequest` is its own event name.
- **notify needs no plugin**: `-c 'notify=["node","<path>","codex-notify"]'`,
  payload = one JSON argv arg, kebab-case fields (`thread-id`,
  `last-assistant-message`). May be legacy (`legacy_notify` in binary).
- **Transcript assistant lines repeat per content block with the same
  `message.id`** — the last line carries the true output_tokens (observed 10
  → 54065 on one message). Any usage summing MUST dedupe last-wins by id and
  drop `model: "<synthetic>"` lines. The enricher and its tests encode this.
- Subagent transcripts: `<dir>/<sessionId>/subagents/agent-<agentId>.jsonl`,
  same format as main transcripts + `agentId`/`attributionAgent` per line.
- Reducer synthesizes `codex:<sessionId>:<n>` ids for v1-era codex-direct
  agents — same prefix as the v3 adapter namespace. No practical collision
  (uuid vs sessionId:counter), but don't be surprised seeing both shapes.
- `codex exec` has no `-a/--ask-for-approval`; exec mode may categorically
  lack the interactive-approval flow (PermissionRequest may never fire).
- Don't combine `--strict-config` with unvalidated project config in a
  non-TTY context — observed an indefinite hang.

## Working pattern that built v2 and v3 (reuse it)

Fleet-shaped, per `~/Desktop/HARNESS-BOOTSTRAP.md` and memory `harness-fleet`:
probe gate first when any step rests on unverified payload shapes → spec
amendment (the contract) → parallel builders on disjoint files (explicit file
ownership; no two builders on one file) → "verify before reporting" in every
dispatch prompt → orchestrator does live integration + browser verification →
logical commits per workstream. v3 note: when a subagent dies on a spend
limit, the orchestrator can execute a well-specified dispatch prompt inline —
that's how WS-B.2 (codex adapter) actually shipped.

## The explainer artifact (keep it updated)

Plain-English slide walkthrough for Simon (non-coder), published at:
https://claude.ai/code/artifact/73dabd53-2acb-48e6-8753-89c7fdbcf66f
Source of truth: `docs/explainer.html` in this repo. To update from any
session: edit the file, then call the Artifact tool with that `url` and the
file path — same link. It currently describes v3 as shipped.

## Memory

Project memory lives at
`~/.claude/projects/-Users-simon-lumenADE/memory/` — `lumenade-fleetview.md`
(system state + gotchas) and `harness-fleet.md` (orchestration pattern).
Update `lumenade-fleetview.md` when v4 ships.
