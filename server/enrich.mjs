// FleetView enricher sidecar (docs/FLEETVIEW-SPEC.md §19.3): tails real
// Claude Code transcript JSONL files and turns `message.usage` blocks into
// per-agent / per-session token and cost totals. Dependency-injected factory
// — no import of server.mjs — so it is unit-testable in isolation. Zero npm
// dependencies, node:fs only. Never throws back into the caller: every
// failure path (missing file, truncated file, malformed line, a throwing
// onUsage callback) is swallowed here.
//
// Correctness rule that matters most (verified 2026-07-17 against a real
// transcript): a transcript repeats an assistant line per content block,
// every repeat carrying the SAME message.id but a growing output_tokens
// (one message read 10 on its first line, 54065 on its last). Summing every
// occurrence overcounts input/cache tokens ~5x. The fix is to dedupe by
// message.id, keep only the LAST occurrence seen, and recompute totals from
// that deduped map on every tick rather than accumulating a running sum.

import { statSync, openSync, readSync, closeSync } from "node:fs";

const MAX_BYTES_PER_TICK = 1024 * 1024; // 1 MiB cap per file per tick

// Trailing date-suffix on model ids, e.g. "claude-opus-4-8-20260201" — mirrors
// server.mjs's prettifyModel suffix-stripping so pricing and display agree.
const DATE_SUFFIX_RE = /-\d{4}-?\d{2}-?\d{2}$|-\d{8}$/;

// exact id -> strip trailing date suffix -> longest prefix match -> null
// (unknown model: tokens are still reported, costUsd stays null for that
// message's contribution).
function priceForModel(pricing, modelId) {
  if (typeof modelId !== "string" || modelId === "") return null;
  if (Object.prototype.hasOwnProperty.call(pricing, modelId)) return pricing[modelId];

  const stripped = modelId.replace(DATE_SUFFIX_RE, "");
  let best = null;
  for (const key of Object.keys(pricing)) {
    if (stripped === key || stripped.startsWith(key)) {
      if (!best || key.length > best.length) best = key;
    }
  }
  return best ? pricing[best] : null;
}

export function createEnricher({ config, getTargets, onUsage }) {
  const enrichment = (config && config.enrichment) || {};
  const pricing = enrichment.pricing || {};

  /**
   * @type {Map<string, {
   *   path: string, offset: number, buf: string,
   *   perMessage: Map<string, {in:number, out:number, cacheRead:number, cacheWrite:number, model:string}>,
   *   lastTokens: {in:number, out:number, cacheRead:number, cacheWrite:number} | null,
   *   lastCostUsd: number | null,
   * }>}
   * keyed by the opaque target key the server hands us (e.g. "agent:<id>" /
   * "session:<id>") — this module never interprets the key, only stores
   * per-key state and reports back through it.
   */
  const state = new Map();

  function stateFor(key, filePath) {
    let s = state.get(key);
    if (!s || s.path !== filePath) {
      // New key, or the resolved path changed under us (e.g. an agent's own
      // transcriptPath became known after we'd started reading a derived
      // path) — start clean rather than mixing offsets across files.
      s = {
        path: filePath,
        offset: 0,
        buf: "",
        perMessage: new Map(),
        lastTokens: null,
        lastCostUsd: null,
      };
      state.set(key, s);
    }
    return s;
  }

  // Recomputes totals + cost from the deduped per-message map and reports
  // via onUsage iff either changed since the last report for this key.
  function reportIfChanged(key, s) {
    const totals = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
    let costUsd = 0;
    let anyPriced = false;

    for (const m of s.perMessage.values()) {
      totals.in += m.in;
      totals.out += m.out;
      totals.cacheRead += m.cacheRead;
      totals.cacheWrite += m.cacheWrite;

      const price = priceForModel(pricing, m.model);
      if (price) {
        anyPriced = true;
        costUsd +=
          (m.in / 1e6) * (price.in || 0) +
          (m.out / 1e6) * (price.out || 0) +
          (m.cacheRead / 1e6) * (price.cacheRead || 0) +
          (m.cacheWrite / 1e6) * (price.cacheWrite || 0);
      }
    }

    // Some messages priced, some not (mixed-model transcript, one unknown
    // model) -> sum what's priced. Zero messages matched any pricing entry
    // -> costUsd stays null rather than reporting a misleading $0.
    const finalCost = anyPriced ? costUsd : null;

    const prev = s.lastTokens;
    const sameTokens =
      prev &&
      prev.in === totals.in &&
      prev.out === totals.out &&
      prev.cacheRead === totals.cacheRead &&
      prev.cacheWrite === totals.cacheWrite;
    const sameCost = s.lastCostUsd === finalCost;
    if (sameTokens && sameCost) return;

    s.lastTokens = totals;
    s.lastCostUsd = finalCost;

    try {
      onUsage(key, totals, finalCost);
    } catch {
      // onUsage is caller-owned; a throw there must not crash us.
    }
  }

  // Consumes complete lines out of s.buf (up to the last newline), folding
  // each qualifying assistant/usage line into the per-message dedupe map.
  // Returns true iff at least one line updated the map.
  function ingestBuffered(s) {
    const lastNewline = s.buf.lastIndexOf("\n");
    if (lastNewline === -1) return false; // no complete line yet this tick

    const complete = s.buf.slice(0, lastNewline + 1);
    s.buf = s.buf.slice(lastNewline + 1);

    let changed = false;
    for (const line of complete.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let obj;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        continue; // skip unparseable lines
      }
      if (!obj || obj.type !== "assistant") continue;

      const message = obj.message;
      if (!message || !message.usage) continue;
      if (message.model === "<synthetic>") continue;
      if (typeof message.id !== "string" || message.id === "") continue;

      const usage = message.usage;
      s.perMessage.set(message.id, {
        in: usage.input_tokens || 0,
        out: usage.output_tokens || 0,
        cacheRead: usage.cache_read_input_tokens || 0,
        cacheWrite: usage.cache_creation_input_tokens || 0,
        model: message.model,
      });
      changed = true;
    }
    return changed;
  }

  // Incremental read from the last offset, capped 1 MiB/file/tick. Missing
  // or shrunk (truncated/rotated) files reset that path's state quietly and
  // return without processing — never throws.
  function processTarget(key, filePath) {
    let stat;
    try {
      stat = statSync(filePath);
    } catch {
      // Missing/deleted -- drop state quietly; a later tick may find it
      // again (e.g. transiently unmounted), starting from offset 0.
      state.delete(key);
      return;
    }

    const s = stateFor(key, filePath);

    if (stat.size < s.offset) {
      // Truncated or rotated -- rebuild this path's state from scratch.
      s.offset = 0;
      s.buf = "";
      s.perMessage.clear();
    }

    if (stat.size === s.offset) return; // nothing new this tick

    const toRead = Math.min(stat.size - s.offset, MAX_BYTES_PER_TICK);

    let fd;
    try {
      fd = openSync(filePath, "r");
    } catch {
      return; // transient open failure -- retry next tick, offset unchanged
    }
    try {
      const buffer = Buffer.alloc(toRead);
      const bytesRead = readSync(fd, buffer, 0, toRead, s.offset);
      s.offset += bytesRead;
      s.buf += buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      closeSync(fd);
    }

    if (ingestBuffered(s)) reportIfChanged(key, s);
  }

  function tick() {
    let targets;
    try {
      targets = getTargets() || [];
    } catch {
      return;
    }

    for (const target of targets) {
      if (!target || !target.key || !target.path) continue;
      try {
        processTarget(target.key, target.path);
      } catch {
        // Never throw back to the caller -- leave this key's state as-is
        // and retry next tick.
      }
    }
  }

  function forget(key) {
    state.delete(key);
  }

  return { tick, forget };
}
