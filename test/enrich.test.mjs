// Enricher test suite (docs/FLEETVIEW-SPEC.md §19.3, §21.1). Zero deps:
// node:test + assert/strict only. Fixtures under test/fixtures/transcripts/
// are hand-built to the real verified shape (§19.3's dedupe finding);
// a few tests also generate scratch temp files inline (incremental-append,
// synthetic-with-nonzero-usage, 1 MiB cap) rather than committing large or
// single-purpose fixtures.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { createEnricher } from "../server/enrich.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "fixtures", "transcripts");

// Mirrors fleet.config.json / server.mjs DEFAULT_CONFIG.enrichment.pricing
// (§19.4) exactly -- USD per MTok.
const PRICING = {
  "claude-fable-5": { in: 10, out: 50, cacheRead: 1, cacheWrite: 12.5 },
  "claude-opus-4-8": { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5": { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-haiku-4-5": { in: 1, out: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

function fixturePath(name) {
  return join(FIXTURES_DIR, name);
}

function makeEnricher(targetsFn, pricing = PRICING) {
  const calls = [];
  const enricher = createEnricher({
    config: { enrichment: { pricing } },
    getTargets: targetsFn,
    onUsage: (key, tokens, costUsd, model) => calls.push({ key, tokens, costUsd, model }),
  });
  return { enricher, calls };
}

function closeTo(actual, expected, tolerance = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) < tolerance,
    `expected ${actual} to be close to ${expected}`
  );
}

function makeScratchDir() {
  return mkdtempSync(join(tmpdir(), "fleetview-enrich-test-"));
}

describe("server/enrich.mjs — dedupe + cost math", () => {
  test("dedupe totals match last-line values, synthetic filtered, mixed models + prefix match priced", () => {
    const path = fixturePath("dedupe.jsonl");
    const { enricher, calls } = makeEnricher(() => [{ key: "agent:t1", path }]);

    enricher.tick();

    assert.equal(calls.length, 1, "one reported change after a single tick");
    const [{ key, tokens, costUsd }] = calls;
    assert.equal(key, "agent:t1");

    // msg_1 dedupes to its LAST occurrence (output_tokens: 522, not 8+8+522),
    // msg_synth (model "<synthetic>") is dropped entirely, msg_3's dated
    // model id "claude-opus-4-8-20260201" prefix-matches "claude-opus-4-8".
    assert.deepEqual(tokens, { in: 152, out: 597, cacheRead: 10500, cacheWrite: 23956 });
    closeTo(costUsd, 0.16296);

    // The fixture switches models mid-session: msg_1 (claude-opus-4-8) ->
    // msg_2 (claude-sonnet-5) -> msg_synth (dropped) -> msg_3
    // (claude-opus-4-8-20260201, the last qualifying line in file order).
    // "Most recent" wins, reported as the RAW id -- prettification is the
    // server's job, not the enricher's.
    assert.equal(calls[0].model, "claude-opus-4-8-20260201");
  });

  test("costUsd stays null when no message's model matched any pricing entry", () => {
    const path = fixturePath("all-unknown.jsonl");
    const { enricher, calls } = makeEnricher(() => [{ key: "agent:t2", path }]);

    enricher.tick();

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].tokens, { in: 10, out: 20, cacheRead: 0, cacheWrite: 0 });
    assert.equal(calls[0].costUsd, null);
  });

  test("mixed known/unknown models in one transcript: tokens sum all, cost sums only priced messages", () => {
    const path = fixturePath("mixed-pricing.jsonl");
    const { enricher, calls } = makeEnricher(() => [{ key: "agent:t3", path }]);

    enricher.tick();

    assert.equal(calls.length, 1);
    // msg_a (claude-sonnet-5, priced) + msg_b (unpriced model, tokens still counted)
    assert.deepEqual(calls[0].tokens, { in: 1999, out: 1499, cacheRead: 0, cacheWrite: 0 });
    // Only msg_a contributes: (1000/1e6)*3 + (500/1e6)*15
    closeTo(calls[0].costUsd, 0.0105);
    // msg_b (the unpriced "totally-unpriced-model") is the last qualifying
    // line -- a model with no pricing entry is still reported as the model
    // arg; pricing coverage and model reporting are independent.
    assert.equal(calls[0].model, "totally-unpriced-model");
  });
});

describe("server/enrich.mjs — synthetic filtering (nonzero usage)", () => {
  test("message.model === '<synthetic>' is dropped even when it carries nonzero usage", () => {
    const dir = makeScratchDir();
    try {
      const path = join(dir, "synthetic-nonzero.jsonl");
      const lines = [
        JSON.stringify({
          type: "assistant",
          message: {
            id: "msg_real",
            model: "claude-sonnet-5",
            usage: {
              input_tokens: 10,
              output_tokens: 20,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          },
        }),
        // If this were NOT filtered by model id, it would blow the totals
        // up by 999999/999999 -- a real regression the assertion below
        // would catch.
        JSON.stringify({
          type: "assistant",
          message: {
            id: "msg_synthetic",
            model: "<synthetic>",
            usage: {
              input_tokens: 999999,
              output_tokens: 999999,
              cache_read_input_tokens: 999999,
              cache_creation_input_tokens: 999999,
            },
          },
        }),
      ];
      writeFileSync(path, lines.join("\n") + "\n");

      const { enricher, calls } = makeEnricher(() => [{ key: "agent:synth", path }]);
      enricher.tick();

      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].tokens, { in: 10, out: 20, cacheRead: 0, cacheWrite: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("server/enrich.mjs — incremental reads", () => {
  test("a partial line without a trailing newline is buffered, not double-counted once completed", () => {
    const dir = makeScratchDir();
    try {
      const path = join(dir, "partial.jsonl");
      const full = JSON.stringify({
        type: "assistant",
        message: {
          id: "msg_partial",
          model: "claude-haiku-4-5",
          usage: {
            input_tokens: 7,
            output_tokens: 3,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      });
      const half = full.slice(0, Math.floor(full.length / 2));
      const rest = full.slice(Math.floor(full.length / 2));

      // Write the first half with NO trailing newline -- not a complete line.
      writeFileSync(path, half);

      const { enricher, calls } = makeEnricher(() => [{ key: "agent:partial", path }]);
      enricher.tick();
      assert.equal(calls.length, 0, "no complete line yet -- nothing reported");

      // Append the rest, completing the line.
      appendFileSync(path, rest + "\n");
      enricher.tick();

      assert.equal(calls.length, 1, "exactly one report once the line completes -- no double count");
      assert.deepEqual(calls[0].tokens, { in: 7, out: 3, cacheRead: 0, cacheWrite: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("incremental append across two ticks: the second report carries the newly-appended line's model, even with tokens/cost unchanged", () => {
    const dir = makeScratchDir();
    try {
      const path = join(dir, "model-switch.jsonl");
      const lineFor = (id, model, usage) =>
        JSON.stringify({ type: "assistant", message: { id, model, usage } }) + "\n";

      writeFileSync(
        path,
        lineFor("msg_x", "claude-sonnet-5", {
          input_tokens: 5,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        })
      );

      const { enricher, calls } = makeEnricher(() => [{ key: "agent:modelswitch", path }]);
      enricher.tick();

      assert.equal(calls.length, 1);
      assert.equal(calls[0].model, "claude-sonnet-5");
      assert.deepEqual(calls[0].tokens, { in: 5, out: 5, cacheRead: 0, cacheWrite: 0 });

      // Append a second qualifying line under a DIFFERENT model but with
      // all-zero usage -- totals and cost are unchanged from tick 1, so
      // this exercises the model-only change guard in reportIfChanged:
      // a model-only change must still trigger a report (§31.2).
      appendFileSync(
        path,
        lineFor("msg_y", "claude-opus-4-8", {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        })
      );
      enricher.tick();

      assert.equal(calls.length, 2, "model-only change (tokens/cost identical) still reports");
      assert.deepEqual(calls[1].tokens, { in: 5, out: 5, cacheRead: 0, cacheWrite: 0 });
      assert.equal(calls[1].costUsd, calls[0].costUsd);
      assert.equal(calls[1].model, "claude-opus-4-8", "second report carries the newly-appended line's model");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a 1 MiB read cap per tick does not lose data across multiple ticks", () => {
    const dir = makeScratchDir();
    try {
      const path = join(dir, "big.jsonl");
      const lineFor = (n) =>
        JSON.stringify({
          type: "assistant",
          message: {
            id: `msg_${String(n).padStart(6, "0")}`,
            model: "claude-sonnet-5",
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          },
        }) + "\n";

      // Generate enough unique-id lines to comfortably exceed the 1 MiB/tick
      // cap (each line is a bit over 150 bytes -- 8000 lines is well past
      // 1 MiB, guaranteeing at least two ticks are needed).
      const LINE_COUNT = 8000;
      let content = "";
      for (let i = 0; i < LINE_COUNT; i++) content += lineFor(i);
      writeFileSync(path, content);
      const totalBytes = Buffer.byteLength(content, "utf8");
      assert.ok(totalBytes > 1024 * 1024, "fixture must exceed the 1 MiB/tick cap to test it");

      const { enricher, calls } = makeEnricher(() => [{ key: "agent:big", path }]);

      let ticks = 0;
      let last = null;
      while (ticks < 10) {
        enricher.tick();
        ticks += 1;
        if (calls.length > 0) last = calls[calls.length - 1];
        if (last && last.tokens.in === LINE_COUNT) break;
      }

      assert.ok(ticks > 1, "more than one tick was required to consume the file (cap is real)");
      assert.ok(calls.length > 1, "intermediate progress was reported, not just a final jump");
      assert.deepEqual(last.tokens, {
        in: LINE_COUNT,
        out: LINE_COUNT,
        cacheRead: 0,
        cacheWrite: 0,
      });
      closeTo(last.costUsd, (LINE_COUNT / 1e6) * 3 + (LINE_COUNT / 1e6) * 15);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("server/enrich.mjs — tolerance and lifecycle", () => {
  test("a missing file is tolerated -- no throw, no report", () => {
    const path = join(makeScratchDir(), "does-not-exist.jsonl");
    const { enricher, calls } = makeEnricher(() => [{ key: "agent:missing", path }]);

    assert.doesNotThrow(() => enricher.tick());
    assert.equal(calls.length, 0);
  });

  test("getTargets() throwing is tolerated -- no throw", () => {
    const enricher = createEnricher({
      config: { enrichment: { pricing: PRICING } },
      getTargets: () => {
        throw new Error("boom");
      },
      onUsage: () => {},
    });
    assert.doesNotThrow(() => enricher.tick());
  });

  test("onUsage throwing is tolerated -- no throw", () => {
    const path = fixturePath("all-unknown.jsonl");
    const enricher = createEnricher({
      config: { enrichment: { pricing: PRICING } },
      getTargets: () => [{ key: "agent:throws", path }],
      onUsage: () => {
        throw new Error("caller-owned callback exploded");
      },
    });
    assert.doesNotThrow(() => enricher.tick());
  });

  test("forget(key) clears state -- a subsequent tick re-reads from scratch and re-reports", () => {
    const path = fixturePath("dedupe.jsonl");
    const { enricher, calls } = makeEnricher(() => [{ key: "agent:forgetme", path }]);

    enricher.tick();
    assert.equal(calls.length, 1);

    enricher.forget("agent:forgetme");
    enricher.tick();

    assert.equal(calls.length, 2, "forgetting clears lastTokens/lastCostUsd, so re-reading reports again");
    assert.deepEqual(calls[0].tokens, calls[1].tokens);
    assert.equal(calls[0].costUsd, calls[1].costUsd);
  });

  test("no report when nothing changed between ticks", () => {
    const path = fixturePath("dedupe.jsonl");
    const { enricher, calls } = makeEnricher(() => [{ key: "agent:steady", path }]);

    enricher.tick();
    enricher.tick();
    enricher.tick();

    assert.equal(calls.length, 1, "file has no new bytes after the first tick -- no redundant reports");
  });

  test("a target missing key/path is skipped without throwing", () => {
    const { enricher, calls } = makeEnricher(() => [{}, { key: "agent:x" }, { path: "/nope" }, null]);
    assert.doesNotThrow(() => enricher.tick());
    assert.equal(calls.length, 0);
  });
});

// --- §32.4 session titles ---------------------------------------------------
// Claude Code writes the session's name into the same transcript the enricher
// already tails, as a `custom-title` line rewritten on every rename. These
// cover the two things that make it awkward: last-one-wins, and the fact that
// a tick can carry a title with no usage at all (which the old bool return
// from ingestBuffered would have swallowed).

function makeTitleEnricher(targetsFn) {
  const usage = [];
  const titles = [];
  const enricher = createEnricher({
    config: { enrichment: { pricing: PRICING } },
    getTargets: targetsFn,
    onUsage: (key, tokens, costUsd, model) => usage.push({ key, tokens, costUsd, model }),
    onTitle: (key, title) => titles.push({ key, title }),
  });
  return { enricher, usage, titles };
}

const ASSISTANT_LINE = JSON.stringify({
  type: "assistant",
  message: {
    id: "msg-title-1",
    model: "claude-opus-4-8",
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  },
});

const titleLine = (customTitle, sessionId = "s1") =>
  JSON.stringify({ type: "custom-title", customTitle, sessionId });

describe("server/enrich.mjs — session titles (§32.4)", () => {
  test("the LAST custom-title in the file wins, not the first", () => {
    const path = join(makeScratchDir(), "renamed.jsonl");
    writeFileSync(
      path,
      [titleLine("First name"), ASSISTANT_LINE, titleLine("Second name"), titleLine("Final name")].join("\n") + "\n"
    );
    const { enricher, titles } = makeTitleEnricher(() => [{ key: "session:s1", path }]);

    enricher.tick();

    assert.deepEqual(titles, [{ key: "session:s1", title: "Final name" }]);
  });

  test("a tick with a title but no usage still reports", () => {
    const path = join(makeScratchDir(), "title-only.jsonl");
    writeFileSync(path, titleLine("Delegated otter plan") + "\n");
    const { enricher, usage, titles } = makeTitleEnricher(() => [{ key: "session:s1", path }]);

    enricher.tick();

    assert.equal(usage.length, 0, "no assistant lines -> no usage report");
    assert.deepEqual(titles, [{ key: "session:s1", title: "Delegated otter plan" }]);
  });

  test("an unchanged title is not re-reported; a rename is", () => {
    const path = join(makeScratchDir(), "stable.jsonl");
    writeFileSync(path, titleLine("Stable name") + "\n");
    const { enricher, titles } = makeTitleEnricher(() => [{ key: "session:s1", path }]);

    enricher.tick();
    appendFileSync(path, titleLine("Stable name") + "\n");
    enricher.tick();
    assert.equal(titles.length, 1, "same title again -> no second report");

    appendFileSync(path, titleLine("Renamed") + "\n");
    enricher.tick();
    assert.deepEqual(titles.at(-1), { key: "session:s1", title: "Renamed" });
    assert.equal(titles.length, 2);
  });

  test("a blank or non-string customTitle is ignored", () => {
    const path = join(makeScratchDir(), "junk-title.jsonl");
    writeFileSync(
      path,
      [
        titleLine(""),
        JSON.stringify({ type: "custom-title", customTitle: null, sessionId: "s1" }),
        JSON.stringify({ type: "custom-title", sessionId: "s1" }),
      ].join("\n") + "\n"
    );
    const { enricher, titles } = makeTitleEnricher(() => [{ key: "session:s1", path }]);

    enricher.tick();

    assert.equal(titles.length, 0);
  });

  test("truncation clears the title without clearing a known one downstream", () => {
    const path = join(makeScratchDir(), "rotated.jsonl");
    writeFileSync(path, [titleLine("Before rotation"), ASSISTANT_LINE].join("\n") + "\n");
    const { enricher, titles } = makeTitleEnricher(() => [{ key: "session:s1", path }]);

    enricher.tick();
    assert.deepEqual(titles.at(-1), { key: "session:s1", title: "Before rotation" });

    // Shrink the file -- the enricher rebuilds this path's state from scratch.
    writeFileSync(path, titleLine("After rotation") + "\n");
    enricher.tick();

    assert.deepEqual(titles.at(-1), { key: "session:s1", title: "After rotation" });
  });

  test("an enricher built without onTitle still drives onUsage unchanged", () => {
    const path = join(makeScratchDir(), "no-callback.jsonl");
    writeFileSync(path, [titleLine("Ignored"), ASSISTANT_LINE].join("\n") + "\n");
    const calls = [];
    const enricher = createEnricher({
      config: { enrichment: { pricing: PRICING } },
      getTargets: () => [{ key: "session:s1", path }],
      onUsage: (key, tokens) => calls.push({ key, tokens }),
    });

    assert.doesNotThrow(() => enricher.tick());
    assert.equal(calls.length, 1);
    assert.equal(calls[0].tokens.out, 20);
  });

  test("onTitle throwing is tolerated -- no throw", () => {
    const path = join(makeScratchDir(), "throwing.jsonl");
    writeFileSync(path, titleLine("Boom") + "\n");
    const enricher = createEnricher({
      config: { enrichment: { pricing: PRICING } },
      getTargets: () => [{ key: "session:s1", path }],
      onUsage: () => {},
      onTitle: () => {
        throw new Error("caller-owned callback exploded");
      },
    });

    assert.doesNotThrow(() => enricher.tick());
  });
});
