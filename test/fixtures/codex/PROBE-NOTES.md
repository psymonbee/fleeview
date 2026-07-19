# Codex CLI hook probe (S2) — findings

Probe date: 2026-07-17. Codex CLI version: `0.144.5` (`/Users/simon/.local/bin/codex`, standalone install).
All commands run against a scratch git repo at
`/private/tmp/claude-501/-Users-simon-lumenADE/6c8f0e3f-1031-4f40-8491-749526a75347/scratchpad/codex-probe/scratch-project`.
No files inside `~/.codex` were edited; no plugins were installed; `~/.codex/config.toml` and
`~/.codex/auth.json` were only read, never written.

## Headline finding: hooks did not fire in `codex exec`, in any of 4 candidate wiring attempts

This is the critical, load-bearing result of this probe and it changes the shape of the S2 → adapter
work: **`codex exec` never invoked a single hook command**, across every project-local wiring we could
construct without installing a plugin or touching global Codex state. `adapters/codex.mjs` cannot be
written against captured runtime hook payloads because none could be captured. See "What we tried" and
"Why we believe this is real" below before deciding how to proceed.

### What we tried (each with the trivial-run test: "Run `echo hello-probe` and then `ls`")

| # | Candidate hooks.json location | Extra config | Result |
|---|---|---|---|
| 1 | `<project>/.codex/hooks.json` | none | no hook fired |
| 2 | `<project>/.codex/hooks.json` + `<project>/.codex/config.toml` containing `hooks = "./hooks.json"` | — | no hook fired |
| 3 | `<project>/hooks.json` (bare, at project root, mirroring the plugin-package convention) | none | no hook fired |
| 4 | `<project>/.agents/hooks.json` (mirroring the `.agents/plugins/marketplace.json` convention used by installed plugin marketplaces) | none | no hook fired |

For each attempt, `hooks.json` declared handlers for all of: `SessionStart`, `PreToolUse` (matcher `*`),
`PostToolUse` (matcher `*`), `PreToolUsePermissionRequest`, `PreCompact`, `PostCompact`, `SubagentStart`,
`SubagentStop` — every command invoked `node capture.mjs <EventName>`, appending one JSON line to
`$PROBE_OUT` on every invocation, unconditionally, even with empty stdin. `capture.mjs` never wrote a
single line across all 4 attempts, run with `--dangerously-bypass-hook-trust` every time. Trivial tool
calls (`echo`, `ls`) that should have triggered `PreToolUse`/`PostToolUse` at minimum did not.

Also tried, independent of hooks.json placement:
- A failing command (`cat /nonexistent-file-probe-xyz`) — still zero hook firings, so we could **not**
  answer "does a failing tool call get a `PostToolUse`" empirically. See `schemas/post-tool-use.command.output.json`
  for what the field would look like if it did fire — see the static-schema section below.
- A subagent-spawn prompt — subagents **do** work in `codex exec` (see "Subagent support" below), but
  again triggered no `SubagentStart`/`SubagentStop` hook.
- A permission-forcing prompt with `--sandbox read-only` — see "Permission-request" below; no hook fired,
  and in fact `codex exec` appears to have no interactive approval path at all (see that section).

### Why we believe this is real, not a misconfiguration

1. **`codex doctor` / `codex doctor --json` never mentions hooks.** Its `config.load` check reports
   `"config.toml": "/Users/simon/.codex/config.toml"` (always the **global** path, never
   `<project>/.codex/config.toml`, regardless of `cwd`) and a `"mcp servers": "1"` count, but there is no
   "hooks" line anywhere in the doctor output, even though the `hooks` feature flag is listed as
   `stable=true` in `codex features list`. This strongly suggests project-local `.codex/config.toml` is
   **not a config layer the standalone CLI loads at all** (at least not from an arbitrary project
   directory in `exec` mode) — so our attempt #2 above was never going to work even if `hooks = "..."`
   were the right key name.
2. **The one place a real, working `hooks.json` was found on disk (`~/.codex/.tmp/plugins/plugins/replayio/hooks.json`
   and `~/.codex/.tmp/plugins/plugins/figma/hooks.json`) is inside an installed-plugin package directory**,
   sitting next to a `.codex-plugin/plugin.json` manifest, `.app.json`, `skills/`, `scripts/`, etc. Neither
   plugin manifest declares a `"hooks"` key pointing at `hooks.json` — it is auto-discovered purely by
   being a file named `hooks.json` at the plugin package root. There is no evidence anywhere (in `codex
   --help`, `codex doctor`, or the binary's embedded strings) of an equivalent auto-discovery convention
   for a bare project or user directory outside the plugin system.
3. **Binary evidence (`strings` on the codex executable) ties hooks tightly to the plugin/config-layer
   system**: `HookSource` values include `plugin`, `project`, `user`, `system`, `mdm`, `cloud_requirements`,
   `cloud_managed_config`, `legacy_managed_config_file`, `legacy_managed_config_mdm`, `unknown` (exact
   segmentation of this concatenated string is our best-effort split, see "Static evidence" below) — i.e.
   hooks are explicitly modeled as coming from one of several *registered* sources, not implicitly
   discovered from cwd.
4. We deliberately avoided the one thing that plausibly *would* register a hooks-bearing plugin —
   `codex plugin marketplace add <local-path>` + `codex plugin add <name>@<marketplace>` — because it
   installs into the user's real global plugin registry (visible in `codex plugin list`, and almost
   certainly recorded in `~/.codex/state_5.sqlite` and/or a workspace-scoped ChatGPT-account setting per
   the string `"failed to fetch workspace Codex plugins setting; allowing Codex plugins"`), which is
   exactly the kind of persistent, non-`-c`-overridable change to Simon's real Codex installation the task
   brief told us to avoid ("use `-c` overrides instead of config edits"; nothing in the allowed-write list
   covers plugin registration). We did not find a `-c`-overridable, in-memory-only way to register a local
   plugin for a single invocation.
5. **`--dangerously-bypass-hook-trust` prints its warning unconditionally**, even with zero hooks
   configured anywhere (verified with a control run against an empty `.codex` dir) — so its presence in
   `--json` output is not itself evidence that any hook was found; don't be misled by it the way we almost
   were.

**Bottom line for the adapter work**: as far as this probe could determine, Codex CLI hooks in this
version are exclusively a plugin-scoped feature, gated behind `codex plugin add` (persistent, global,
account-linked installation) and possibly interactive hook-trust approval. There does not appear to be a
lightweight, ad-hoc, `-c`-overridable, or project-local way to wire up hooks for a single
`codex exec --json` invocation, the way Claude Code supports via `.claude/settings.json`. If FleetView
needs live Codex hook data, the realistic paths are: (a) accept the cost of installing a real plugin under
Simon's account and re-probe from there, (b) drive Codex via `--json` stdout event parsing instead of
hooks (see "exec --json event shapes" below — this **does** work and needs no privileged setup), or
(c) revisit whether the app-server / `codex mcp-server` protocol (which has its own
`HookStartedNotification`/`HookCompletedNotification` JSON-RPC notifications per the binary's embedded
protocol types) exposes hooks without the plugin gate — untested here, out of scope for this probe.

## Static schema evidence (NOT runtime-captured — read this before trusting field names)

The Codex binary embeds 20 complete JSON Schema (draft-07) documents — one `.command.input` and one
`.command.output` schema for each of 10 hook events — presumably used internally to validate a hook
script's stdout. We extracted these verbatim via `strings` on the compiled binary and saved them,
unmodified beyond JSON pretty-printing, to `schemas/*.json` in this directory:

```
schemas/pre-tool-use.command.input.json       schemas/pre-tool-use.command.output.json
schemas/permission-request.command.input.json schemas/permission-request.command.output.json
schemas/post-tool-use.command.input.json      schemas/post-tool-use.command.output.json
schemas/pre-compact.command.input.json        schemas/pre-compact.command.output.json
schemas/post-compact.command.input.json       schemas/post-compact.command.output.json
schemas/session-start.command.input.json      schemas/session-start.command.output.json
schemas/user-prompt-submit.command.input.json schemas/user-prompt-submit.command.output.json
schemas/subagent-start.command.input.json     schemas/subagent-start.command.output.json
schemas/subagent-stop.command.input.json      schemas/subagent-stop.command.output.json
schemas/stop.command.input.json               schemas/stop.command.output.json
```

**These are type definitions, not observed instances.** No values in them were captured from a live run.
Treat them as authoritative for field *names*, *types*, and *which fields are required*, but not for
realistic example *values* — we did not fabricate example payloads to accompany them, per the "don't fake
fixtures" instruction. They are, however, far more complete than a single sample run would have been
(they enumerate every optional field, every enum, and every `required` list).

### The real event set is 10 events, not 8 — and one name in the original brief was wrong

The task brief's known-recon list was `PreToolUse, PostToolUse, PreCompact, PostCompact, SessionStart,
SubagentStart, SubagentStop, PreToolUsePermissionRequest`. The schema titles show the actual set is:

`PreToolUse, PermissionRequest, PostToolUse, PreCompact, PostCompact, SessionStart, UserPromptSubmit,
SubagentStart, SubagentStop, Stop` (verified via each schema's `properties.hook_event_name.const`).

**`PermissionRequest` is its own event, not `PreToolUsePermissionRequest`.** The earlier recon almost
certainly concatenated two adjacent strings in a `strings` dump (`...PreToolUse` immediately followed by
`PermissionRequest...` with no separator) and misread them as one token — we saw exactly this kind of
adjacency repeatedly in our own `strings` output. `UserPromptSubmit` and `Stop` — both real Claude-Code
hook events — also exist in Codex and were missing from the original list entirely.

### Input schema field tables (verbatim `required` lists, from the extracted schemas)

| Event (`hook_event_name` const) | Required fields |
|---|---|
| `PreToolUse` | `cwd, hook_event_name, model, permission_mode, session_id, tool_input, tool_name, tool_use_id, transcript_path, turn_id` |
| `PermissionRequest` | `cwd, hook_event_name, model, permission_mode, session_id, tool_input, tool_name, transcript_path, turn_id` |
| `PostToolUse` | `cwd, hook_event_name, model, permission_mode, session_id, tool_input, tool_name, tool_response, tool_use_id, transcript_path, turn_id` |
| `PreCompact` | `cwd, hook_event_name, model, session_id, transcript_path, trigger, turn_id` |
| `PostCompact` | (same shape as PreCompact — see `schemas/post-compact.command.input.json`) |
| `SessionStart` | `cwd, hook_event_name, model, permission_mode, session_id, source, transcript_path` (`source` enum: `startup, resume, clear, compact`) |
| `UserPromptSubmit` | `cwd, hook_event_name, model, permission_mode, prompt, session_id, transcript_path, turn_id` |
| `SubagentStart` | `agent_id, agent_type, cwd, hook_event_name, model, permission_mode, session_id, transcript_path, turn_id` |
| `SubagentStop` | `agent_id, agent_transcript_path, agent_type, cwd, hook_event_name, last_assistant_message, model, permission_mode, session_id, stop_hook_active, transcript_path, turn_id` |
| `Stop` | `cwd, hook_event_name, last_assistant_message, model, permission_mode, session_id, stop_hook_active, transcript_path, turn_id` |

Notable field-name facts, all verbatim from the schemas:

- **`session_id`** is the field name (matches Claude Code exactly). `PreToolUse`/`PostToolUse` also carry
  a Codex-only `turn_id` ("Codex extension: expose the active turn id to internal turn-scoped hooks.").
- **Tool name/input fields**: `tool_name` (string), `tool_input` (schema: `true`, i.e. unvalidated/any
  JSON), `tool_use_id` (string), and for `PostToolUse` only, `tool_response` (also `true`/any-JSON).
  These field names are identical to Claude Code's own hook payload — Codex hooks look deliberately
  designed to be schema-compatible with Claude Code's hook contract.
- `permission_mode` is a closed enum: `default, acceptEdits, plan, dontAsk, bypassPermissions` — again,
  identical vocabulary to Claude Code.
- `transcript_path` is nullable (`{"$ref": "#/definitions/NullableString"}`) on every event that has it.
- `agent_type` appears on `PreToolUse`/`PermissionRequest` as an *optional* property (not in `required`)
  but is required on `SubagentStart`/`SubagentStop`.

### Output schema (what a hook's stdout JSON is allowed to contain)

- `PreToolUse` output: `decision` (`approve|block`), or the richer
  `hookSpecificOutput.permissionDecision` (`allow|deny|ask`) +
  `hookSpecificOutput.permissionDecisionReason` + `hookSpecificOutput.updatedInput` +
  `hookSpecificOutput.additionalContext`, plus generic `continue`, `reason`, `stopReason`,
  `suppressOutput`, `systemMessage`. See `schemas/pre-tool-use.command.output.json`.
- `PermissionRequest` output: `hookSpecificOutput.decision = { behavior: "allow"|"deny", message?,
  interrupt?, updatedInput?, updatedPermissions? }`. The schema descriptions explicitly say
  `interrupt`, `updatedInput`, and `updatedPermissions` are "**reserved for future** ... hooks currently
  fail closed if this field is present" — i.e. only `behavior` + `message` actually do anything today.
  See `schemas/permission-request.command.output.json`.
- `PostToolUse` output: `decision` is restricted to just `block` (`BlockDecisionWire` enum has one
  variant); `hookSpecificOutput` only carries `additionalContext` and `updatedMCPToolOutput`.
- All 10 `.command.output` schemas share the generic envelope fields `continue` (bool, default true),
  `stopReason`, `suppressOutput` (bool, default false), `systemMessage`.

### hooks.json config-file schema (from two real, installed, in-the-wild plugin packages — genuinely observed, not synthetic)

Read directly off disk at `~/.codex/.tmp/plugins/plugins/replayio/hooks.json` and
`~/.codex/.tmp/plugins/plugins/figma/hooks.json` (both real plugins in Codex's bundled marketplace cache):

```json
{
  "hooks": {
    "PostToolUse": [
      { "matcher": "Bash", "hooks": [ { "type": "command", "command": "./scripts/post_bash_upload.sh" } ] }
    ],
    "Stop": [
      { "hooks": [ { "type": "command", "command": "./scripts/stop_close_and_upload.sh" } ] }
    ]
  }
}
```
```json
{
  "hooks": {
    "PostToolUse": [
      { "matcher": "Write|Edit", "hooks": [ { "type": "command", "command": "./scripts/post_write_figma_parity_check.sh" } ] }
    ]
  }
}
```

Top-level event keys are **PascalCase** (`PostToolUse`, `Stop`) — same convention as Claude Code's
`.claude/settings.json` hooks block, and matching the schema `const` values above. Commands are relative
to the plugin package root. Note there is a second, **snake_case** event-name vocabulary
(`pre_tool_use, permission_request, post_tool_use, pre_compact, post_compact, session_start,
user_prompt_submit, subagent_start, subagent_stop`) visible in the binary immediately next to the string
literal `"hooks.json"` — we could not determine what this snake_case form is for (an internal/telemetry
identifier? an alternate accepted key syntax? never observed in an actual `hooks.json` on disk) since no
hooks.json we wrote ever got loaded. Flagging as an open question rather than guessing.

The `HookHandlerConfig` type (the object inside a matcher group's `"hooks"` array) is an internally-tagged
enum with three shapes — `command`, `prompt`, `agent` — inferred from the concatenated string
`commandcommandWindowstimeoutasyncstatusMessagepromptagent`; best-effort field guess for the `command`
variant: `{ type: "command", command, commandWindows?, timeout?, async?, statusMessage? }`. Not verified
against a real 3-field example beyond what the two files above show (`type`, `command`).

Two more binary-only facts worth carrying into the adapter:
- Hook processes are launched with env vars `PLUGIN_ROOT` / `CLAUDE_PLUGIN_ROOT` and `PLUGIN_DATA` /
  `CLAUDE_PLUGIN_DATA` — the `CLAUDE_*`-prefixed duplicates strongly suggest Codex hooks were built to be
  drop-in compatible with Claude Code plugin scripts that read those specific env var names.
- Hook trust is tracked via a `trusted_hash` (presumably a hash of the resolved command string), which is
  what `--dangerously-bypass-hook-trust` / the config key `bypass_hook_trust` (settable via
  `-c bypass_hook_trust=true`, confirmed boolean-typed: `` `bypass_hook_trust` override must be a boolean ``)
  skip the check for.

## Failure semantics: not observed

We could not determine whether a failing tool call still gets a `PostToolUse` hook, because no hook ever
fired. What we *can* say: in the `codex exec --json` stdout event stream (unrelated to hooks), a failing
command still produces a normal `item.completed` event with `status: "failed"` and a populated
`exit_code`:

```json
{"type":"item.completed","item":{"id":"item_0","type":"command_execution","command":"/bin/zsh -lc 'cat /nonexistent-file-probe-xyz'","aggregated_output":"cat: /nonexistent-file-probe-xyz: No such file or directory\n","exit_code":1,"status":"failed"}}
```

If hooks are ever made to fire (e.g. via a real plugin), `schemas/post-tool-use.command.input.json`'s
`tool_response` field (typed `true`, i.e. any JSON) is presumably where exit code / failure info would
show up — but this is inference, not observation.

## Permission-request: not observed; `codex exec` may have no interactive approval path at all

No `PreToolUsePermissionRequest`/`PermissionRequest` hook fired. Separately, and possibly relevant to why:
`codex exec --help` does **not** list `-a`/`--ask-for-approval` at all (that flag only exists on the
top-level `codex` command, for the interactive TUI) — passing it to `codex exec` errors with `unexpected
argument '-a' found`. With `--sandbox read-only` and no approval flag, a prompt asking Codex to write a
file simply got a refusal in the agent's own text output ("I can't create `probe.txt` ... the filesystem
is read-only and approvals are disabled"), not an approval prompt or hook. This suggests `codex exec` may
categorically not support the interactive-approval flow that would trigger a `PermissionRequest` hook —
untested against `workspace-write` sandbox mode or other approval-adjacent flags, so treat as a lead, not
a conclusion.

## Subagent support: confirmed working in `codex exec`, independent of hooks

Prompting "spawn a subagent to run `echo sub`" produced a real, distinct thread and a `collab_tool_call`
sequence in `--json` output — `spawn_agent` → `wait` → `close_agent`, with a genuine second
`receiver_thread_ids` thread id:

```json
{"type":"item.completed","item":{"id":"item_2","type":"collab_tool_call","tool":"spawn_agent","sender_thread_id":"019f6dea-f0bb-7101-b471-5fb23063155d","receiver_thread_ids":["019f6deb-1900-75c2-bc23-d254fab96b5c"],"prompt":"Run the shell command `echo sub` and report the exact output. Do not do anything else.","agents_states":{"019f6deb-1900-75c2-bc23-d254fab96b5c":{"status":"pending_init","message":null}},"status":"completed"}}
{"type":"item.completed","item":{"id":"item_3","type":"collab_tool_call","tool":"wait","sender_thread_id":"019f6dea-f0bb-7101-b471-5fb23063155d","receiver_thread_ids":["019f6deb-1900-75c2-bc23-d254fab96b5c"],"prompt":null,"agents_states":{"019f6deb-1900-75c2-bc23-d254fab96b5c":{"status":"completed","message":"sub"}},"status":"completed"}}
```

So `SubagentStart`/`SubagentStop` not firing is attributable to hooks not loading at all, not to
subagents being unavailable in exec mode.

## notify: works, and does not need hooks.json or a plugin at all

Unlike hooks, `notify` is a plain top-level config key, overridable per-invocation with `-c`, with **no**
plugin/trust gate. Exact syntax that worked:

```
codex exec --json --skip-git-repo-check \
  -c 'notify=["node","/abs/path/capture.mjs","NOTIFY"]' \
  "Run \`echo hello-notify\`. Nothing else."
```

Codex invokes the configured command array with **one additional argument appended**: a JSON-encoded
string payload. It is delivered purely via `argv`, never stdin. Captured (real, live) payload — see
`notify-turn-ended.json` for the full fixture:

```json
{"type":"agent-turn-complete","thread-id":"019f6dea-3ae6-7111-be5c-94005ae61023","turn-id":"019f6dea-3b37-7061-a483-c9a71a913997","cwd":"/private/tmp/.../scratch-project","client":"codex_exec","input-messages":["Run `echo hello-notify`. Nothing else."],"last-assistant-message":"hello-notify"}
```

Field names are kebab-case (`thread-id`, `turn-id`, `input-messages`, `last-assistant-message`), unlike
the hook schemas' snake_case. The binary string dump also contains the literal token `legacy_notify`
adjacent to these field names, suggesting `notify` may be considered a legacy/simpler predecessor to the
richer hooks system rather than a first-class parallel mechanism — worth keeping in mind if hooks
eventually become usable, since `notify` may be deprecated in favor of a `Stop`/turn-end hook.

## Token usage / rate limits: field path + sample

In `codex exec --json` stdout, on the `turn.completed` event:

```json
{"type":"turn.completed","usage":{"input_tokens":27493,"cached_input_tokens":3840,"output_tokens":174,"reasoning_output_tokens":0}}
```

Field path: `.usage.{input_tokens,cached_input_tokens,output_tokens,reasoning_output_tokens}`. Richer
data (including rate limits) appears in the on-disk rollout transcript's `token_count` event:

```json
{"timestamp":"2026-07-17T02:25:04.073Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":13186,"cached_input_tokens":1920,"output_tokens":78,"reasoning_output_tokens":0,"total_tokens":13264},"last_token_usage":{...},"model_context_window":258400},"rate_limits":{"limit_id":"codex","primary":{"used_percent":2.0,"window_minutes":10080,"resets_at":1784841135},"credits":{"has_credits":false,"unlimited":false,"balance":"0"},"plan_type":"plus"}}}
```

## Rollout transcript envelope

`~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<thread_id>.jsonl`, one JSON object per line:

```json
{"timestamp":"2026-07-17T02:24:59.243Z","type":"session_meta","payload":{"session_id":"019f6de4-30dd-7370-937d-c87ce07e62d0","id":"019f6de4-30dd-7370-937d-c87ce07e62d0","cwd":"...","originator":"codex_exec","cli_version":"0.144.5","source":"exec","thread_source":"user","model_provider":"openai","base_instructions":{...}}}
```

Confirmed envelope shape: `{timestamp, type, payload}`, matching the task brief's expectation exactly.
Event `type`s observed: `session_meta`, `response_item` (function_call / function_call_output / message),
`event_msg` (nested `payload.type`: `token_count`, `agent_message`, `task_complete`).

## Trust / flag gotchas

- `--dangerously-bypass-hook-trust` prints `` `--dangerously-bypass-hook-trust` is enabled. Enabled hooks
  may run without review for this invocation. `` on **every** invocation where the flag is passed, twice
  per run, regardless of whether any hooks are actually configured. Do not treat its presence as evidence
  hooks were found.
- `-a`/`--ask-for-approval` exists on `codex` (top-level/TUI) but not on `codex exec` — passing it to
  `codex exec` is a hard CLI error.
- `--strict-config` combined with a project-local `.codex/config.toml` containing an unrecognized key
  caused one run to hang indefinitely (3m46s, near-zero CPU, blocked rather than erroring or prompting) —
  we killed it (`kill <pid>`) rather than let it run further; did not investigate root cause since it's a
  side investigation, not on the critical path. Worth a wide berth in future automation: don't combine
  `--strict-config` with unvalidated project config in a non-interactive/no-TTY context.
- `timeout` is not available by default on this macOS box (no coreutils); use background (`&`/`nohup`) +
  `sleep` + `kill` instead, as done for the permission-request runs.

## Cleanup

The scratch git repo and all candidate hooks.json/config.toml files used during this probe live only
under `/private/tmp/claude-501/-Users-simon-lumenADE/6c8f0e3f-1031-4f40-8491-749526a75347/scratchpad/codex-probe/`
and were never copied anywhere persistent. No files under `~/.codex` were created or modified. No plugins
were installed; `codex plugin list` was only read, never mutated.

## Probe #2 — live payloads via user-level config hooks (2026-07-19)

The §18.1 "hooks are plugin-gated" inference above was wrong (see spec
§18.5–§18.6): hooks declared in the user-level `~/.codex/config.toml` fire,
and `plugin_hooks` is a REMOVED feature in 0.144.5. A tool-forcing
`codex exec` run in a real authenticated account (raw stdin dumpers wired to
all 10 events, four matcher variants) captured live payloads for
SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, and Stop — now the
suffix-less fixtures in this directory (paths sanitized `/Users/<account>` →
`/Users/user`; all other bytes as captured). Key value corrections vs the
old synthetics: `tool_name` is `"Bash"` (Claude-style names — `"shell"` was
a wrong guess), `tool_use_id` is `exec-<uuid>`, Bash `tool_response` is the
plain stdout string. Matcher semantics: omitted = fires for every tool;
`"*"` and `"Bash"` also fire; `"shell"` never does. SubagentStart/Stop,
Pre/PostCompact, and PermissionRequest have still never fired in any probe
and remain `-SYNTHETIC` (values updated to the corrected dialect).
