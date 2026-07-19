# FleetView — Codex capture via user-level hooks (session bootstrap)

Point a fresh Claude Code session at this file to rewrite §18. Repo:
`/Users/simon/lumenADE` · GitHub: https://github.com/psymonbee/fleeview
Probed and written 2026-07-19. Standing contract: `docs/FLEETVIEW-SPEC.md`.

## Top line

**Broken:** §18 delivers Codex hooks through an installed Codex *plugin*.
Codex 0.144.5 has **removed** plugin hooks. The plugin installs, validates,
registers, reports `installed, enabled` — and is never invoked. Codex capture
has therefore never worked, in any version.

**Achievable:** hooks declared in the **user-level** `~/.codex/config.toml`
fire correctly, and FleetView's existing adapter turns them into correct
neutral events **unchanged**. Proven live, first attempt. The fix is a
delivery-mechanism swap, not new capture logic.

**Proven end to end** on a real authenticated Codex (2026-07-19): approve the
hook-trust prompt once interactively, and headless `codex exec` then captures
on its own — `session.start`, `turn.start`, `turn.end`, correctly namespaced,
no bypass flag. Nothing about this feature is speculative any more. See
"Probe gate — ANSWERED" below.

## The evidence (all verified 2026-07-19 — do NOT re-probe)

### 1. Plugin hooks are removed, permanently

```
$ codex features list
hooks          stable    true
plugin_hooks   removed   false
```

`codex --enable plugin_hooks` does **not** flip it — removed features are
hard-disabled. Confirmed against binface's real install too: plugin
`installed, enabled`, `hooks.json` correct and byte-comparable to shipping
OpenAI plugins (figma/replayio), full successful `codex exec` session, and
**zero** events written.

### 2. User-level `config.toml` hooks DO fire

`hooks = "<path>"` is rejected with a message that gives the game away:

```
Error loading config.toml: invalid type: string "...", expected struct HooksToml
in `hooks`
```

So the key is real and supported; it wants a struct. This shape works:

```toml
[[hooks.SessionStart]]
[[hooks.SessionStart.hooks]]
type = "command"
command = "<abs-node> <app>/hooks/emit-event.mjs codex"
```

Codex then prints `hook: SessionStart` / `hook: SessionStart Completed`, and
FleetView wrote, unmodified and first try:

```json
{"v":1,"source":"codex","t":"2026-07-19T12:55:51.406Z",
 "sessionId":"codex:019f7a72-7a1c-73f1-89b8-0b91dfa61c2e",
 "kind":"session.start","cwd":"...","transcriptPath":"..."}
```

Correct source, correct `codex:` id namespacing (§18.2), correct neutral
kind. **`adapters/codex.mjs` needs no changes for this to work.**

### 3. The synthetic fixtures were right

Every `test/fixtures/codex/*-SYNTHETIC.json` was inferred from binary schema
strings, never from a live payload. Two are now confirmed against the real
thing — **field-for-field identical**, only values differ (see Appendix).
That raises confidence in the other eight considerably, but they remain
formally unverified.

### 4. Hook trust is load-bearing

Hooks ran only with `--dangerously-bypass-hook-trust`. Without it: silence,
no warning, no event. The binary exposes `TrustHook`, `TrustHooks`,
`SetHookTrusted`, `SetHookEnabled` and a `current_hash` — so interactive
Codex prompts once, trust is keyed to a **hash of the hook config**, and
changing the config re-prompts.

**This is the single biggest open risk.** See "Probe gate" below.

### 5. Why the original S2 probe missed it

It tried four `hooks.json` locations plus a **project-level**
`.codex/config.toml` — which Codex never loads — and concluded "hooks must be
plugin-gated." It never tried the **user-level** config with the struct
shape. That one untested inference sent v3 and v4 down a dead road.

## Probe gate — ANSWERED 2026-07-19: trust persists ✅

> **Does interactively granting hook trust persist, and does that trust then
> apply to headless `codex exec`?**
>
> **YES.** Verified end to end in the `binface` account on a real,
> authenticated Codex.

Sequence run: `[hooks.*]` block appended to binface's `~/.codex/config.toml`
(10 events) → interactive `codex`, trust prompt approved once → quit →
`codex exec --skip-git-repo-check "say hi"` with **no** bypass flag. Captured
in `~/.lumenade/events.jsonl`:

```json
{"v":1,"source":"codex","t":"2026-07-19T17:40:03.924Z","sessionId":"codex:019f7b76-ab4a-78f1-939d-2fceabfa8e3e","kind":"session.start","cwd":"/Users/binface/test","transcriptPath":"/Users/binface/.codex/sessions/2026/07/19/rollout-…jsonl"}
{"v":1,"source":"codex","t":"2026-07-19T17:40:03.972Z","sessionId":"codex:019f7b76-…","kind":"turn.start"}
{"v":1,"source":"codex","t":"2026-07-19T17:40:05.776Z","sessionId":"codex:019f7b76-…","kind":"turn.end"}
```

`SessionStart` → `session.start` (with `cwd` + `transcriptPath`),
`UserPromptSubmit` → `turn.start`, `Stop` → `turn.end`. Correct `codex:`
namespacing throughout, adapter unmodified.

**Therefore the product is the good version:** the one-time user action is
"paste a config block, run `codex` once, approve the prompt." Headless
`codex exec` is captured, so `codex-runner` sessions appear on the canvas.
FleetView never needs to recommend `--dangerously-bypass-hook-trust`.

Trust is keyed to a **hash of the hook config**, so changing the block
re-prompts. The installer's instructions must say so, or users who later
re-run the installer will silently lose capture until they re-approve — the
exact silent-failure class as §17.4.

### Remaining gap (smaller, no longer blocking)

Only 3 of the 10 wired events had anything to fire on — a "say hi" turn makes
no tool calls, spawns no subagents, triggers no compaction. **`PreToolUse` /
`PostToolUse` are still unverified against a real payload**, and they are the
two that matter most (they drive the activity line and files-touched chips).
Also unresolved: whether config-level tool hooks need a `matcher`, and in what
dialect — FleetView emits `"*"`, OpenAI's own plugins use `"Bash"` /
`"Write|Edit"`.

Cheap to close: same account, one prompt that forces a tool call
(`codex exec --skip-git-repo-check "run the command: echo probe"`), then read
the new events. Do this early — it could still change the TOML the installer
emits. Use the raw-dumper pattern in the Appendix to capture the payloads and
promote all remaining `-SYNTHETIC` fixtures to real ones.

## Shape of the fix

Delivery swap. Capture logic stays.

1. **`bin/install.mjs`** — `scaffoldCodexPlugin()` (`:195`, called at `:418`)
   currently writes a marketplace + plugin and prints two `codex plugin`
   commands (`:255-261`). Replace with emitting a `[hooks.*]` TOML block for
   all 10 `CODEX_EVENTS` (`:175`), using `NODE_BIN` (§17.4 — absolute
   interpreter, non-negotiable).
   **Decision required:** print the block for the user to paste, or write
   `~/.codex/config.toml` directly? §18.4 currently promises *"the installer
   never runs `codex` commands and never edits `~/.codex/*`"* — writing it
   breaks that promise and needs merge-not-clobber logic (Simon's own config
   has `[plugins.*]`, `[features]`, and a `notify` already claimed by Codex
   Computer Use). **Printing is the smaller, safer change and keeps the
   promise; recommend printing unless Simon wants otherwise.**
2. **`adapters/codex.mjs`** — likely untouched. Verify against the newly
   captured real payloads rather than assuming.
3. **Spec** — rewrite §18.4/§18.5 around user-level config; retain the plugin
   history as a numbered "why not the plugin" note so nobody re-attempts it.
   Add the trust gate and the probe result. §21.7(b) becomes "trust granted
   and firing verified," not "plugin registered."
4. **Delete or demote the plugin scaffold.** It is now dead weight — correct
   code serving a removed mechanism. Removing it also removes
   `test/install.test.mjs`'s `--with-codex (§18.4/§18.5)` assertions, which
   must be rewritten, not deleted.
5. **README / usage text** — `--with-codex` help still says "scaffold a Codex
   hooks plugin."

## Decisions for Simon

- **Print vs write** `~/.codex/config.toml` (above; recommend print).
- **Does `--with-codex` keep its name?** It no longer scaffolds a plugin.
- **What happens to the `notify` fallback?** It still works and is
  independent of all this — but on Simon's real machine the `notify` slot is
  already taken by Codex Computer Use, so it is not a viable fallback *for
  him*. Say so in the docs rather than implying it's universal.
- **Does Codex capture stay "experimental"?** If the trust probe passes
  cleanly it has a real claim to graduating.

## Gotchas

- **Silent failure is this feature's signature.** Untrusted hooks, a bad
  interpreter path (§17.4), and a malformed matcher all fail with no output.
  Every acceptance step must assert on a **captured event**, never on a
  command exiting 0.
- Matcher shape: FleetView emits `"*"` for tool events; OpenAI's own plugins
  use regex-ish `"Bash"` / `"Write|Edit"`. Unverified which Codex expects for
  config-level hooks — check when `PreToolUse` is captured.
- `CODEX_HOME=<dir>` fully isolates a scratch Codex — use it for anything
  that doesn't need auth. It does **not** carry credentials, so any test
  needing a model turn must run in a real account.
- Codex refuses to run outside a git repo without `--skip-git-repo-check`.
- Never point a test server at `~/.lumenade/events.jsonl`; use scratch
  `FLEET_EVENTS_FILE` + ports 48xx. Port 4747 belongs to binface's rig.

## Acceptance

1. ~~Trust probe answered~~ — **done, see above**. Carry the result into the
   spec. Close the `PreToolUse`/`PostToolUse` + matcher gap early, since it
   can still change the emitted TOML.
2. Spec §18 rewritten and merged before implementation (standing rule).
3. Installer emits a correct `[hooks.*]` block with an absolute interpreter;
   install suite asserts the TOML shape and the absolute path.
4. Real captured payloads promoted to fixtures, replacing `-SYNTHETIC` for
   every event that fired; adapter tests run against them.
5. `npm test` green, no count regression.
6. **Live**: a real Codex session in `binface` writes `source:"codex"` events
   to that account's `events.jsonl`, with **no** bypass flag, and they render
   on a FleetView canvas. Screenshot is the deliverable.
7. No stale claim anywhere that a Codex *plugin* delivers hooks.

## Appendix — real captured payloads (2026-07-19, Codex 0.144.5)

`SessionStart`:

```json
{"session_id":"019f7a86-ec58-7b23-bf21-26a2baaab271",
 "transcript_path":"<CODEX_HOME>/sessions/2026/07/19/rollout-2026-07-19T14-18-10-019f7a86-….jsonl",
 "cwd":"<cwd>","hook_event_name":"SessionStart","model":"gpt-5.6-sol",
 "permission_mode":"bypassPermissions","source":"startup"}
```

`UserPromptSubmit` (adds `turn_id` + `prompt`):

```json
{"session_id":"019f7a86-ec58-7b23-bf21-26a2baaab271",
 "turn_id":"019f7a86-ecb5-7662-83e7-d490c958025f",
 "transcript_path":"…","cwd":"<cwd>","hook_event_name":"UserPromptSubmit",
 "model":"gpt-5.6-sol","permission_mode":"bypassPermissions",
 "prompt":"run the command: echo probe"}
```

Both match their `-SYNTHETIC` fixtures field-for-field.

Raw-dumper pattern used to capture them (wire it to every event, run Codex,
read the file):

```js
import { appendFileSync } from "node:fs";
let d=""; process.stdin.setEncoding("utf8");
process.stdin.on("data",c=>d+=c);
process.stdin.on("end",()=>{ appendFileSync(process.env.DUMP_OUT,(d||"<EMPTY>")+"\n"); process.exit(0); });
setTimeout(()=>{appendFileSync(process.env.DUMP_OUT,(d||"<EMPTY-TIMEOUT>")+"\n");process.exit(0);},2000);
```

## State at time of writing

`main` @ `5f7cbb8`. PR #3 (marketplace scaffold) and PR #4 (hub-model
bootstrap) merged today. PR #3 is correct code for a dead mechanism — it is
how this was found, and step 4 above unwinds it. Related: the hub-model gap
(`docs/HUB-MODEL-BOOTSTRAP.md`) and the wider v5 list
(`docs/V5-BOOTSTRAP.md`).
