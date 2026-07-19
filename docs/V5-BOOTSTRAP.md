# FleetView v5 — session bootstrap

Point a fresh Claude Code session at this file to start v5 with full context.
Repo: `/Users/simon/lumenADE` · GitHub: https://github.com/psymonbee/fleeview
(This file superseded `V4-BOOTSTRAP.md` on 2026-07-17; v4 shipped the same
day — yes, v3 and v4 shipped on the same day.)

## Where v4 left off (shipped 2026-07-17)

v4's thesis: design for users who are not Simon. Verified against
`docs/FLEETVIEW-SPEC.md` §22–§29 (150 tests green; live-session §29.9 check
passed — real nested spawn drew a parent-sourced edge on the live canvas).
On top of v3 it added:

```
server/discovery.mjs      agent auto-discovery: hand-rolled frontmatter parse
                          of ~/.claude/agents + <cwd>/.claude/agents; 5-tier
                          resolveAgentMeta precedence; modelAliases config
starter-agents/           genericized builder/checker/codex-runner defs;
                          bin/install.mjs --with-agents copies them to
                          ~/.claude/agents (never overwrites; uninstall leaves)
adapters/*                nested-spawn lineage (fuzzy Pre + exact Post
                          spawn-pending w/ parentAgentId); session.activity
                          for main-loop tools; Skill hints; codex
                          PermissionRequest/Compact mapping
server/server.mjs         AgentRun.parentId (fuzzy claim → exact repair, incl.
                          post-mortem); Session.currentActivity + sessionLogs
                          ring + GET /sessions/:id/log; capabilities (mcp/skill
                          tags, cap 8) on agents AND sessions
public/index.html         tree rendering (children indent 24px/depth cap 2,
                          parent-sourced béziers); hub activity line; capability
                          chips sharing the files-row; rail auto-collapse <1069px
scripts/demo.mjs          pre-plan activity, nested demo-n1 under demo-b1,
                          mcp__/Skill capability beats
```

Spec §22–§29 is the v4 contract; **amend the spec before changing any
schema/SSE/UI shape** — unchanged rule. `npm test` = bare `node --test`.

## Two scoped workstreams — START HERE (added 2026-07-19)

Both have their own bootstrap with the probe work already done. Read the one
you are picking up **instead of** re-deriving from this file:

1. **`docs/CODEX-HOOKS-BOOTSTRAP.md`** — §18 rewrite. Codex 0.144.5 **removed
   plugin hooks** (`codex features list` → `plugin_hooks removed false`), so
   §18's whole delivery mechanism is dead and Codex capture has never worked
   in any version. The replacement — hooks in the **user-level**
   `~/.codex/config.toml` — is proven end to end on a real authenticated
   Codex, with `adapters/codex.mjs` unchanged. Largest, best-understood piece
   of work available.
2. **`docs/HUB-MODEL-BOOTSTRAP.md`** — the hub renders a static config string
   and never the live orchestrator model, so the UI cannot answer "which model
   is orchestrating?". Small, additive, probe already cleared.

## USER steps still pending (only Simon can do these)

1. **Re-run the installer on Simon's own machine.** His live hooks still read
   bare `node` (installed before §17.4); it works only because he launches
   from an nvm-loaded shell. Proven fixed on a clean account, not on his.
2. ~~Close the tool-event gap~~ — **done 2026-07-19 (probe #2, driven via
   `sudo -iu binface` from Simon's side — no profile switch)**:
   `PreToolUse`/`PostToolUse` fire and were captured live on the trusted
   matcher-less config; real `tool_name` is `"Bash"` (Claude-compatible
   names — the `"shell"` guess was wrong); installer TOML emits **no
   matcher**. Raw payloads for 5 of 10 events captured; see the Codex
   bootstrap "Remaining gap — CLOSED" + spec §18.5.

~~Codex plugin registration~~ — **dead, do not attempt.** The plugin
installs, validates and reports `installed, enabled`, and Codex never invokes
it. ~~Fresh-machine end-to-end~~ — **passed 2026-07-19** on the `binface`
account: real vendored install, absolute interpreter, live events.

## v5 parking lot (not scoped)

- **Usage limits in the UI** — parked WITH EVIDENCE, see spec §27: Claude
  Code writes no rate-limit/window data on disk (transcripts = token counts
  only; `~/.claude/stats-cache.json` = daily activity counts). Don't rebuild
  the probe; if revisiting, check whether the `claude` CLI itself has grown a
  usage query, and remember Codex rollout files DO carry
  `rate_limits {used_percent, resets_at, ...}` — reachable once Codex capture
  works via the config-hook path (the old "plugin gate" framing is obsolete).
- **Codex rate-limit chip / rollout enrichment** — `codex exec --json`
  `turn.completed` + rollout `token_count` events carry usage the enricher
  could consume (PROBE-NOTES.md §rollout). Gated on the §18 rewrite.
- **Codex lineage** — deferred in §24: the embedded hook schemas expose no
  parent field.
- **Real Codex fixtures** — every `test/fixtures/codex/*-SYNTHETIC.json` was
  inferred from binary schema strings. Two are now confirmed against live
  payloads (field-for-field identical); the rest should be promoted to real
  captures as part of the §18 rewrite.
- **Events-file rotation** — the log grows unbounded; v4 added ~1 line per
  main-loop tool call (README documents truncate-any-time).
- **Session-level capabilities UI** — the reducer collects
  `Session.capabilities` (§26) but nothing renders it yet; a hub-adjacent
  chip row is the obvious slot.
- Smaller nits: `.hub` height went 72→88px for the activity line (revisit if
  hub layout evolves); narrator sidecar still off by default and unexercised
  in v4.
- **AI-composed card content (v6/v7)** — design note in
  `docs/COMPOSABLE-CARDS.md`: Haiku reads the initial prompt/plan once and
  emits palette-constrained layout hints per agentType; UI composes cards
  from blocks it already draws; every failure mode falls back to today's
  fixed card. Narrator sidecar (§14) is the architectural seed. Related
  shipped groundwork: §30 non-coding starter agents (researcher/writer).

## Hard-won empirical facts — do NOT relearn these

New 2026-07-19 (the Codex session, see `docs/CODEX-HOOKS-BOOTSTRAP.md`):

- **`plugin_hooks` is a REMOVED Codex feature** and `--enable` will not
  revive it. A plugin reporting `installed, enabled` proves nothing.
- **Codex hook trust is hash-keyed to the hook config.** Approve once
  interactively and headless `codex exec` is captured too — but *changing* the
  config re-prompts, so a later installer re-run silently drops capture.
- **`binface` is a second macOS account on Simon's own Mac**, not a remote
  box; it usually holds port 4747 with its own FleetView tailing its own
  events file. Drive it with `sudo -iu binface zsh -ic '…'` — **never**
  `bash -lc`, which misses its nvm setup (lives in `.zshrc`) and silently
  falls through to Simon's node, baking `/Users/simon` paths into a
  "fresh-machine" install. See `memory/binface-test-rig.md`.
- **`/Users/Shared/fleetview/` is a two-way channel** between the accounts —
  put commands there for Simon to run in binface, read his results back.

Everything in the v3 list still holds (see `V4-BOOTSTRAP.md`; keep: failing
tools emit PreToolUse only; TaskCreate id arrives in the Post response;
hooks hot-reload and `hooks/emit-event.mjs` + `adapters/*.mjs` are LIVE on
this machine — atomic edits + immediate `node --check`; never point a test
server at `~/.lumenade/events.jsonl`, use scratch `FLEET_EVENTS_FILE` +
ports 48xx; demo backdates `t` and the reducer trusting it is load-bearing;
FLEET_IGNORE guard is two-sided; Codex hooks are plugin-gated; transcript
assistant lines repeat per content block — dedupe by message.id last-wins).
New in v4 (S3 probe + build, 2026-07-17):

- **Nested subagent spawns are real and fully hooked**: SubagentStart/Stop
  fire for the child; NO payload carries a parent field. The lineage lives
  on the PARENT's own Agent tool events — Pre (before child start) has
  parent `agent_id` only; Post has parent `agent_id` + child
  `tool_response.agentId`, and for a synchronous nested spawn it fires
  AFTER the child's SubagentStop (post-mortem). Fixtures:
  `test/fixtures/nested-*.json` (live captures).
- `tool_response.resolvedModel` can carry a `[1m]` suffix
  (`claude-opus-4-8[1m]`) — `prettifyModel`'s longest-prefix match absorbs
  it; don't "fix" the suffix away.
- **CSS trap**: a class rule `display:flex` beats the UA `[hidden]` rule by
  origin precedence — a bare `hidden` attribute silently fails. Every
  flex/grid class that ever gets `hidden` needs an explicit
  `.cls[hidden]{display:none}` (fixed for `.files-row`, `.drawer-tokens`).
- Deleting/recreating the events file under a running server silently drops
  lines (tailer inode artifact) — truncate is fine, replace needs a server
  restart. Only bit test setups, never real hooks.
- In this harness, a `&`-backgrounded PID does NOT survive into the next
  Bash tool call — `kill $PID` later is a no-op; find zombies with
  `lsof -ti :48xx` before test runs.
- `claimPendingSpawn` now returns the claimed record or `null` (was `""`) —
  it carries `parentAgentId` alongside `description`.

## Working pattern that built v2–v4 (reuse it)

Fleet-shaped, per memory `harness-fleet`: probe gate first when any step
rests on unverified payload shapes → spec amendment (the contract) →
parallel builders on disjoint files (explicit file ownership; two waves when
the same file has two owners — discovery took server.mjs in wave 1, reducer
took it in wave 2) → "verify before reporting" in every dispatch prompt →
orchestrator reconciles cross-file fallout (stale tests in unowned files),
does live integration + browser verification → logical commits per
workstream. v4 note: the live §29.9 check doubled as the demo — spawning a
real agent that spawns a child paints the tree on the user's own canvas.

## The explainer artifact (keep it updated)

Plain-English slide walkthrough for Simon (non-coder), published at:
https://claude.ai/code/artifact/73dabd53-2acb-48e6-8753-89c7fdbcf66f
Source of truth: `docs/explainer.html` in this repo. To update from any
session: edit the file, then call the Artifact tool with that `url` and the
file path — same link.

## Memory

Project memory lives at
`~/.claude/projects/-Users-simon-lumenADE/memory/` — `lumenade-fleetview.md`
(system state + gotchas) and `harness-fleet.md` (orchestration pattern).
Updated for v4 at ship time.
