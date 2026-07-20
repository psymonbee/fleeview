# FleetView — live orchestrator model on the hub (session bootstrap)

> **SHIPPED 2026-07-20** as spec §31.2 (PR #9, with the orchestrator card).
> This file is historical record; the "State at the time of writing" section
> also predates the §18 rewrite (its "land PR #3 first" / plugin items are
> obsolete). The probe evidence and gotchas below remain accurate.

Point a fresh Claude Code session at this file to build the feature end to
end. Repo: `/Users/simon/lumenADE` · GitHub: https://github.com/psymonbee/fleeview
Surfaced 2026-07-19. Standing contract: `docs/FLEETVIEW-SPEC.md`.

## The ask, in one line

The hub node should say **which model is actually orchestrating**, live, the
way agent cards already do — instead of a static word from config.

## How it surfaced

Simon, watching the canvas, asked: *"is the orchestrator in the UI hard-wired
to Fable 5, or should I see the work you're doing in this session?"* Neither
half of that question could be answered from the UI. That is the bug: a tool
whose entire job is showing you what your fleet is doing cannot tell you what
is driving it.

## What is true today (verified 2026-07-19, don't re-derive)

- The hub title is a **static config string**, never a model. `fleet.config.json`
  sets `hub.title: "Orchestrator"`; it reaches the UI in the SSE snapshot
  `config` object (`{"hubTitle":"Orchestrator","stallThresholdMs":120000}` —
  confirmed against the live server).
- `Fable 5` at `public/index.html:1227` and in the two `state.config` defaults
  (`:1295`, `:1875`, read at `:1942`) is a **v1 leftover placeholder**, shown
  for one frame before the snapshot lands. Spec §10 already says config
  "replaces the hardcoded 'Fable 5' (§5)". It is not a wiring bug — but it is
  a lie in the source and should die with this change.
- **Agent cards do have real models**; the hub does not. `resolveAgentMeta`
  (`server/server.mjs:196-216`) reads `resolvedModel` off the Agent tool's
  Post payload, through `resolveModelAlias` → `prettifyModel`. Nothing
  equivalent exists for the session.
- **No Claude Code hook payload carries the main session's model.** Checked:
  `resolvedModel` appears only on Agent-tool spawn events
  (`adapters/claude-code.mjs:184,218`), i.e. children. Do not go hunting for a
  hook that carries it — that was the first idea and it is a dead end.

## Probe gate: ALREADY CLEARED — go straight to the spec amendment

The usual rule is probe-before-spec when payload shapes are unverified. That
probe is done; here is the evidence, so do not spend a cycle re-running it.

The **main session transcript carries the model on the exact lines the
enricher already parses.** Against this session's own transcript
(`~/.claude/projects/-Users-simon-lumenADE/<sessionId>.jsonl`, 568 KB):

```
140 × "model":"claude-opus-4-8"
sample assistant line → model: claude-opus-4-8
                        usage keys: input_tokens, cache_creation_input_tokens,
                                    cache_read_input_tokens, output_tokens, …
                        message.id: msg_011CdBJ1H7pMmsMzH7x2GuPf
```

`server/enrich.mjs` already opens that file, already keeps `model:
message.model` in its per-message map (`:161`), and already dedupes by
`message.id` (last-wins). **The data is captured and then thrown away** —
`onUsage(key, totals, finalCost)` (`:121`) simply never passes it on.

So this is not a capture problem. It is three small wiring changes.

## Shape of the fix — ride the token-badge pipe

The session token badge already makes this exact journey. Follow it exactly;
do not invent a second path.

1. **`server/enrich.mjs`** — widen the `onUsage` callback to carry the model
   (a 4th arg, or fold tokens/cost/model into one object — the latter is
   cleaner but touches the agent path too, so weigh it). Pick the model from
   the deduped map the same way totals are recomputed: last-wins per
   `message.id`. Mixed-model transcripts are real (a session can change model
   mid-run) — decide and document whether "current" means most-recent-line or
   most-frequent. **Most-recent is the honest answer for a live readout.**
2. **`server/server.mjs`** — `onEnrichmentUsage` (wired at `:1079`, keyed via
   `enrichmentKey("session", id)`) stores it on the Session, prettified
   through the existing `resolveModelAlias` → `prettifyModel` pair so
   `claude-opus-4-8` renders `Claude Opus 4.8` and pricing/display stay in
   agreement. Additive snapshot/SSE field, `v` stays 1 — same precedent as
   v4's `parentId`, `session.activity`, `capabilities`.
3. **`public/index.html`** — render it in the hub subtitle. There is a
   ready-made slot: at `:1947` the subtitle collapses to bare `cwdBase` when
   `hubTitle === "Orchestrator"`, so today it shows just `lumenADE`.
   `Claude Opus 4.8 · lumenADE` fits the existing rhythm, sits beside the
   token badge that arrives on the same pipe, and needs no geometry change.
   Kill the `Fable 5` placeholders while you are in there.

## Decisions for Simon to make in the prompt

- **Subtitle or a third line?** Subtitle is free (above). A dedicated line
  costs hub height, and `.hub` already went 72→88px in v4 for the activity
  line — a second bump is a real layout decision, not a freebie.
- **What shows before the enricher's first tick** (up to `intervalMs`, default
  5 s) and when `enrichment.enabled` is false? Blank is honest; a stale or
  guessed model is not. Recommend: render nothing until known.
- **Does the hub keep a title at all**, or does the model *become* the title
  with "Orchestrator" demoted to subtitle? Cleaner, more opinionated, and a
  bigger diff — it changes what `hub.title` config means.
- **Codex sessions**: the same slot wants filling from the rollout files.
  Probably out of scope here; say so explicitly rather than half-wiring it.

## Standing rules that apply

- **Amend `docs/FLEETVIEW-SPEC.md` before changing any schema/SSE/UI shape.**
  Non-negotiable, and the reason v2–v4 stayed coherent. This needs a new
  numbered section (§31 is free) and a note in §19.3.
- `npm test` is bare `node --test`; 150/150 green as of PR #3. Keep it green.
- `hooks/emit-event.mjs` and `adapters/*.mjs` are **LIVE on this machine** —
  edits take effect instantly for every running session. Atomic Write then
  immediate `node --check`. (This change should not need to touch them.)
- Never point a test server at `~/.lumenade/events.jsonl`; use a scratch
  `FLEET_EVENTS_FILE` and ports 48xx.

## Gotchas that will bite this specific change

- **Transcript lines repeat per content block**, same `message.id`, growing
  `output_tokens`. Dedupe by id, keep the LAST — already handled in
  `enrich.mjs`, so read the model out of the deduped map, never off a raw line.
- `resolvedModel` can carry a `[1m]` suffix (`claude-opus-4-8[1m]`).
  `prettifyModel`'s longest-prefix match absorbs it — **don't "fix" it away.**
- **CSS trap**: a class rule `display:flex` beats the UA `[hidden]` rule. Any
  flex/grid class that gets a bare `hidden` attribute needs an explicit
  `.cls[hidden]{display:none}` — this bit `.files-row` and `.drawer-tokens`
  in v4 and will bite a new hidden-until-known subtitle element.
- Port **4747 is occupied by a second FleetView** serving the `binface`
  account's fresh-machine test install. Do not kill it — it is the passing
  end-to-end proof. Run yours on another port (`PORT=48xx node
  server/server.mjs`); the server honours `$PORT` (`server.mjs:26`).
- A `&`-backgrounded PID does not survive into the next Bash tool call.
  Find strays with `lsof -ti :48xx` before test runs.

## Acceptance

1. Spec section written and merged **before** the implementation.
2. Unit: enricher surfaces the model from a fixture transcript, including the
   repeated-`message.id` case and a mid-session model switch.
3. Unit: reducer stores + broadcasts it; snapshot replay of an old log
   (no model) degrades cleanly to today's UI.
4. `npm test` green, no count regression.
5. **Live**: run a server against Simon's own
   `~/.lumenade/events.jsonl`, open a real session, and see the hub name the
   model actually running — the literal question that started this. A
   screenshot of that is the deliverable.
6. `Fable 5` appears nowhere in `public/index.html`.

## Working pattern that built v2–v4 (reuse it)

Probe gate → spec amendment (the contract) → parallel builders on **disjoint
files** with explicit ownership (here: `enrich.mjs` / `server.mjs` /
`index.html` are natural, but `server.mjs` is downstream of the `enrich.mjs`
callback shape — so settle that signature first, or run it in two waves) →
"verify before reporting" in every dispatch prompt → orchestrator reconciles
cross-file fallout and does live browser verification → logical commits per
workstream.

## State at the time of writing (2026-07-19)

- `main` @ `08d6efe`. [PR #3](https://github.com/psymonbee/fleeview/pull/3)
  (Codex 0.144.5 marketplace scaffold) open and mergeable — **land it first**;
  it is the last unmerged v4 install work.
- Fresh-machine end-to-end has effectively **passed**: the `binface` account
  has a vendored `~/.lumenade/app/` with an absolute-node hook command and
  live events. §17.4 is proven on a clean account.
- Still pending, unrelated to this feature: Codex plugin registration on
  Simon's real `~/.codex` (§21.7(b) — note `notify` there is already claimed
  by Codex Computer Use, so the plugin route is the only clean one), and
  re-running the installer on Simon's own box (his live hooks still say bare
  `node`).
- Wider v5 parking lot: `docs/V5-BOOTSTRAP.md`. Composable cards (the v6/v7
  idea that is this feature's ambitious cousin): `docs/COMPOSABLE-CARDS.md`.
