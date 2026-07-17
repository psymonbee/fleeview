# FleetView v3 — session bootstrap

Point a fresh Claude Code session at this file to start v3 with full context.
Repo: `/Users/simon/lumenADE` · GitHub: https://github.com/psymonbee/fleeview

## Where v2 left off (shipped 2026-07-17)

v2 is built, acceptance-swept (all 7 criteria in `docs/FLEETVIEW-SPEC.md` §16
passed), committed, and pushed. The pipeline, end to end:

```
Claude Code hooks (all 8 events, wired user-level in ~/.claude/settings.json)
  → hooks/emit-event.mjs        thin observer; FLEET_IGNORE=1 → silent exit
  → adapters/claude-code.mjs    stateless translator → neutral v1 events
  → ~/.lumenade/events.jsonl    versioned neutral schema {v:1, source, t, kind, sessionId}
  → server/server.mjs           reducer on neutral kinds, SSE :4747, /agents/:id/log
  → public/index.html           single-file UI: plan rail, drawer, stall/error/collision
```

`docs/FLEETVIEW-SPEC.md` §8–§16 is the contract. **Amend the spec before
changing any schema/SSE/UI shape.** `fleet.config.json` = labels/models, hub
title, stall threshold, narrator flag (off). Tests: `node --test` (33 green).
Demo: `npm run demo -- --fast`. Server: `npm start` (or launch config
"fleetview"), health at `curl localhost:4747/healthz`.

## v3 scope (agreed with Simon)

1. **npx installer** — one-command setup for other machines: wire the hooks
   block into `~/.claude/settings.json`, create `~/.lumenade/`, start server.
   (Note: an agent session cannot edit `~/.claude/settings.json` itself — the
   permission classifier blocks it. The installer runs as the USER, so that's
   fine; just don't try to test it by having the agent edit live settings.)
2. **Codex CLI adapter** — `adapters/codex.mjs` (`source:"codex"`); Codex's
   hook interface is a near-clone of Claude Code's. Probe real payloads first
   (S1-style gate) before trusting field names.
3. **Token/cost per node** — enrichment tailing transcripts; the neutral
   events already carry `transcriptPath` (sessions) and the agent-level
   transcript path on `agent.end` for exactly this.
4. **README GitHub-pitch rewrite** — current README is factual-only by design.

Smaller carried-over nits, pick up opportunistically: drawer contributes
360px invisible scrollWidth (harden with `overflow-x: clip` on `.layout`);
no adapter unit test for FLEET_IGNORE (it's hook-level, structural); subagent
TaskCreate calls map to `agent.activity`, never `plan.step` (agent_id wins
precedence); plan steps created by TaskUpdate-only upserts render
"(untitled step)" (subject backfill idea: adapter could emit subject from a
later TaskUpdate that carries one); `node --test test/` (dir form) fails on
Node 22 — use bare `node --test`; consider adding an `npm test` script.

## Hard-won empirical facts — do NOT relearn these

Captured 2026-07-17 from real hook payloads (fixtures: `test/fixtures/`):

- **Failing tools emit PreToolUse only — no PostToolUse at all.** No error
  field exists anywhere. Errors are inferred in the reducer from open calls
  that never close (2.5 s heuristic + close-out at agent.end).
- **Async Agent spawns answer immediately**: PostToolUse Agent carries
  `tool_response.agentId` + `resolvedModel` (`status:"async_launched"`) →
  exact spawn↔agent correlation. Fuzzy pending-claim is only the sync fallback.
- **TaskCreate's assigned id** arrives only in PostToolUse
  `tool_response.task.id`. TaskUpdate's Pre carries `{taskId, status}`.
- **SubagentStop** carries `last_assistant_message`, `agent_id`, `agent_type`,
  `agent_transcript_path`.
- **Headless `claude -p` never dispatches ExitPlanMode to hooks** (interactive
  shape is `{plan: string}` — see `pre-exitplanmode-SYNTHETIC.json`).
- Hooks hot-reload mid-session; `hooks/emit-event.mjs` is LIVE on this
  machine — rewrite it only via a single atomic Write, and `node --check`
  immediately. Never point a test server at `~/.lumenade/events.jsonl`; use
  scratch `FLEET_EVENTS_FILE` + ports 48xx.
- The demo backdates `t` to showcase the stall state — the reducer trusting
  `evt.t` is load-bearing; don't "fix" it.
- Narrator self-observation guard is two-sided (`FLEET_IGNORE=1` in spawn env;
  hook exits on it) — proven with real `claude`. Keep it when touching either.

## Working pattern that built v2 (reuse it)

Fleet-shaped, per `~/Desktop/HARNESS-BOOTSTRAP.md` and memory `harness-fleet`:
probe gate first when any step rests on unverified payload shapes → spec
amendment (the contract) → parallel builders on disjoint files (builder agent
type; checker = Opus; codex-runner available) → independent checker sweep
against spec acceptance criteria → orchestrator does live browser
verification → logical commits. v2's builders each found real bugs in their
own verification passes — insist on "verify before reporting" in every
dispatch prompt.

## The explainer artifact (keep it updated)

Plain-English slide walkthrough for Simon (non-coder), published at:
https://claude.ai/code/artifact/73dabd53-2acb-48e6-8753-89c7fdbcf66f
Source of truth: `docs/explainer.html` in this repo. To update from any
session: edit the file, then call the Artifact tool with
`url: "https://claude.ai/code/artifact/73dabd53-2acb-48e6-8753-89c7fdbcf66f"`
and the file path — that keeps the same link. Update it whenever shipped
behavior changes (it currently describes v2, including the v3 scope list).

## Memory

Project memory lives at
`~/.claude/projects/-Users-simon-lumenADE/memory/` — `lumenade-fleetview.md`
(system state + gotchas) and `harness-fleet.md` (orchestration pattern).
Update `lumenade-fleetview.md` when v3 ships.
