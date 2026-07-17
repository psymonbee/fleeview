// FleetView narrator (docs/FLEETVIEW-SPEC.md §14): turns a running agent's
// recent log activity into one short human-readable sentence, via a spawned
// `claude -p` call. Dependency-injected factory — no import of server.mjs —
// so it is unit-testable in isolation. Zero npm dependencies, node:child_
// process only. Never throws back into the caller: every failure path is
// swallowed here and turns into a per-agent backoff instead.

import { spawn } from "node:child_process";

const PROMPT_PREFIX =
  "One sentence, ≤120 chars, present tense, plain text: what is this coding agent doing right now?";
const MAX_LOG_LINES = 15;
const NARRATIVE_MAX = 160;

// Renders one agentLogs ring entry (server.mjs LogEntry: {t, tool, hint?,
// file?, error?, ms?}) as a single plain-text line for the prompt body.
function formatLogLine(entry) {
  let line = String(entry.tool ?? "");
  if (entry.hint) line += `: ${entry.hint}`;
  if (entry.file) line += ` [${entry.file}]`;
  if (entry.ms !== undefined) line += ` (${entry.ms}ms)`;
  if (entry.error) line += " (error)";
  return line;
}

export function createNarrator({ config, getRunningAgents, getNewLogEntries, onNarrative }) {
  const narration = (config && config.narration) || {};
  const model = narration.model;
  const debounceMs = narration.debounceMs;
  const minNewLines = narration.minNewLines;
  const maxConcurrent = narration.maxConcurrent;
  const timeoutMs = narration.timeoutMs;

  /** @type {Map<string, { nextEligibleAt: number }>} agentId -> spawn gate */
  const perAgent = new Map();
  /** @type {Set<string>} agentIds with a narration spawn currently in flight */
  const inFlight = new Set();
  let running = 0;
  let disabled = false; // spawn ENOENT -> disabled for the rest of the process
  let warnedEnoent = false;

  function stateFor(agentId) {
    let s = perAgent.get(agentId);
    if (!s) {
      s = { nextEligibleAt: 0 };
      perAgent.set(agentId, s);
    }
    return s;
  }

  // A failed/timed-out attempt backs the agent off 2x the normal debounce,
  // measured from the spawn that just failed.
  function markFailure(state, spawnedAt) {
    state.nextEligibleAt = spawnedAt + 2 * debounceMs;
  }

  function spawnNarration(agentId, logEntries, state, now) {
    running += 1;
    inFlight.add(agentId);
    state.nextEligibleAt = now + debounceMs;

    const prompt =
      PROMPT_PREFIX + "\n" + logEntries.slice(-MAX_LOG_LINES).map(formatLogLine).join("\n");

    let settled = false;
    let timedOut = false;
    let timer = null;
    const stdoutChunks = [];

    function settle({ failed = false, enoent = false, text = null } = {}) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      running -= 1;
      inFlight.delete(agentId);

      if (enoent) {
        disabled = true;
        if (!warnedEnoent) {
          warnedEnoent = true;
          console.warn(
            "[narrator] `claude` executable not found on PATH; narrator disabled for this process."
          );
        }
        return;
      }

      if (failed) {
        markFailure(state, now);
        return;
      }

      if (text) {
        try {
          onNarrative(agentId, text.trim().slice(0, NARRATIVE_MAX));
        } catch {
          // onNarrative is caller-owned; a throw there must not crash us.
        }
      }
    }

    let child;
    try {
      child = spawn("claude", ["-p", "--model", model], {
        env: { ...process.env, FLEET_IGNORE: "1" },
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch (err) {
      settle({ failed: true, enoent: err && err.code === "ENOENT" });
      return;
    }

    timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // Process may have already exited; nothing to do.
      }
    }, timeoutMs);

    child.on("error", (err) => {
      settle({ failed: true, enoent: err && err.code === "ENOENT" });
    });

    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));

    // Deliberately `exit`, not `close`: `close` waits for the stdio pipes
    // themselves to fully close, which can hang indefinitely if the killed
    // process forked a grandchild that inherited the pipe fd and outlives
    // the SIGKILL (observed with a `sleep`-based shim in a shell script) —
    // that would wedge the concurrency slot open forever. `exit` fires as
    // soon as this process itself terminates, matching the spec's "exit 0
    // ... else SIGKILL" wording exactly. A microtask defer gives already
    // in-flight stdout `data` events (which normally arrive before or
    // alongside `exit` for the small amount of output we expect) a chance
    // to land before we read stdoutChunks.
    child.on("exit", (code) => {
      setImmediate(() => {
        if (timedOut) {
          settle({ failed: true });
        } else if (code === 0) {
          settle({ text: Buffer.concat(stdoutChunks).toString("utf8") });
        } else {
          settle({ failed: true });
        }
      });
    });

    try {
      child.stdin.write(prompt);
      child.stdin.end();
    } catch {
      // Stdin may already be gone if the process died immediately; the
      // 'error'/'close' handlers above cover that outcome.
    }
  }

  function tick() {
    if (disabled) return;

    let agentsList;
    try {
      agentsList = getRunningAgents() || [];
    } catch {
      return;
    }

    const now = Date.now();

    for (const agent of agentsList) {
      if (disabled || running >= maxConcurrent) break;

      const agentId = agent && agent.id;
      if (!agentId || inFlight.has(agentId)) continue;

      const state = stateFor(agentId);
      if (now < state.nextEligibleAt) continue;

      let newEntries;
      try {
        newEntries = getNewLogEntries(agentId, agent.narrativeAt) || [];
      } catch {
        newEntries = [];
      }
      if (newEntries.length < minNewLines) continue;

      spawnNarration(agentId, newEntries, state, now);
    }
  }

  return { tick };
}
