# Composable cards — AI-composed card content (v6/v7 candidate)

Status: **design note only, nothing implemented.** Parked here so the idea
survives until a version has room for it.

## The idea

Today every agent card renders the same fixed anatomy — label, model pill,
status, activity line, files-touched chips, capability chips, token badge —
because FleetView was designed while watching coding fleets. But the harness
capture is use-case-neutral (v4/v5 proved that: any agent type renders), and
the fixed anatomy is quietly coding-shaped: "files touched" is the star of
the card, which is exactly right for a builder and nearly meaningless for a
researcher, whose interesting state is *sources consulted* and *question
being chased*.

The proposal: let a small model decide, per session, what each card should
foreground. The user's initial prompt and the task list already say what
kind of work this is — Haiku can read that once, cheaply, and emit *layout
hints*, not prose: "this is a research session; cards for `researcher`
agents should lead with domains fetched and a claim count; keep the token
badge; drop the files row unless files actually get touched." The UI then
composes each card from a fixed palette of blocks it already knows how to
draw. AI chooses the arrangement; it never draws.

## Why this is plausible now (what already exists)

- **A model-in-the-loop sidecar precedent** — `server/narrator.mjs` (§14)
  already spawns local `claude -p --model haiku` calls against an agent's
  recent log, with debounce, concurrency caps, timeout-kill, ENOENT
  self-disable, and the two-sided `FLEET_IGNORE` guard so FleetView never
  observes itself. The composer is the same shape of sidecar with a
  different prompt and a structured (JSON) output instead of a sentence.
- **The inputs are already captured** — `UserPromptSubmit` carries the
  initial prompt; the plan rail already tracks the task list; per-agent
  log rings hold recent tool activity. No new hooks needed.
- **The UI is already block-ish** — files row, capability chips, activity
  line, token badge are independent pieces with show/hide states (v4's
  `[hidden]` fix exists precisely because blocks toggle). "Composable"
  is a formalization of what the card already is, not a rewrite.
- **Additive schema precedent** — v4 shipped `parentAgentId`,
  `session.activity`, and capabilities as additive fields with `v` staying
  1. A `session.composition` (or per-agent `layoutHints`) field follows
  the same pattern: old UIs ignore it, old logs replay fine.

## Sketch

Three layers, deliberately unequal in freedom:

1. **Intent read (AI, once per session + on plan change).** A composer
   sidecar sends the initial prompt + task-list titles to Haiku and gets
   back a small JSON verdict: session flavor (build / research / write /
   mixed / unknown), and per-agentType block orderings with optional
   relabelings ("files touched" → "sources", chip source `domains` instead
   of `paths`). Strict JSON schema, reject-and-backoff on parse failure,
   exactly like narrator failures back off today.
2. **Recipe resolution (deterministic).** The server merges the verdict
   over built-in default recipes (current card = the fallback recipe,
   forever — a session with the composer off, erroring, or undecided
   renders exactly today's UI). Result is broadcast as an additive SSE
   field.
3. **Rendering (fixed palette, zero AI).** The UI owns a closed set of
   block types — headline stat, chip row, activity line, progress fraction,
   token badge — and renders whatever ordered subset the recipe names.
   No free-form HTML or CSS ever crosses the wire from a model. That
   constraint is what makes "AI-composed UI" shippable rather than a
   prompt-injection surface and a visual-chaos generator.

## Guardrails (non-negotiable if this gets built)

- **Off by default**, like narration — it spawns model calls from a
  passive observer, and that must be opted into.
- **Palette-constrained**: the model picks and labels blocks; it cannot
  invent markup, colors, or geometry. Card geometry stays reducer-stable
  (the v4 CARD_H/RHYTHM discipline).
- **Prompt text is data**: the composer reads the user's prompt, which can
  contain anything. Its output is schema-validated JSON or it is dropped;
  a relabel string is rendered as text, never interpreted.
- **Fail to today's UI**: every failure mode (no `claude` on PATH, timeout,
  bad JSON, weird verdict) degrades to the current fixed card, silently.
- **Spec first**: block palette, recipe schema, and the SSE field get a
  spec section before any code, per the standing rule.

## Open questions

- Per-agentType recipes or per-agent? (Start per-agentType — cheaper, more
  stable; a per-agent override could come from the same call that narrates.)
- Does the composer re-run when the plan changes mid-session, or is one
  read per session enough for v1 of the feature?
- Should discovered agent frontmatter (§22) be a *third* recipe source —
  an agent author declaring "my card leads with X" — beating the inferred
  verdict the way explicit config beats discovery today? (Probably yes;
  it's the same precedence philosophy.)
- How does the demo script exercise it without a live model? (Canned
  verdict fixture, same trick as every other sidecar test.)

## Why v6/v7, not now

It depends on nothing unshipped — but it deserves its own probe-gate pass
(what does Haiku actually return for messy real prompts?), its own spec
sections, and honest cost accounting before an always-on-adjacent model
call joins the default experience. The starter-agent work (§30) is the
cheap half of the same thesis: prove non-coding fleets render today, so
the composed-card version has real sessions to learn from.
