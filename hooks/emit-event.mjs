#!/usr/bin/env node
// FleetView capture hook: raw harness payload -> adapter -> appended neutral
// event lines. Pure observer: never throws/prints, always exit 0. The adapter
// is selected by argv[2] (docs/FLEETVIEW-SPEC.md §18.4): missing -> claude-code
// (so the live wiring predating v3 keeps working unchanged), "codex" -> stdin
// payload, "codex-notify" -> payload in the last argv argument (Codex notify
// delivers JSON via argv and provides no stdin — reading stdin there could
// hang the hook into its timeout).

import { mkdirSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const ADAPTERS = {
  "claude-code": { module: "../adapters/claude-code.mjs", fn: "translate", stdin: true },
  "codex": { module: "../adapters/codex.mjs", fn: "translate", stdin: true },
  "codex-notify": { module: "../adapters/codex.mjs", fn: "translateNotify", stdin: false },
};

async function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    try {
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => (data += chunk));
      process.stdin.on("end", () => resolve(data));
      process.stdin.on("error", () => resolve(data));
    } catch {
      resolve(data);
    }
  });
}

async function main() {
  if (process.env.FLEET_IGNORE === "1") process.exit(0);

  const mode = process.argv[2] ?? "claude-code";
  const spec = ADAPTERS[mode];
  if (!spec) return;

  let raw;
  if (spec.stdin) {
    raw = await readStdin();
  } else {
    raw = process.argv[process.argv.length - 1];
    if (raw === mode) return; // no payload argument was appended
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }

  let events = [];
  try {
    const mod = await import(new URL(spec.module, import.meta.url));
    events = mod[spec.fn](payload);
  } catch {
    return;
  }

  if (!Array.isArray(events) || events.length === 0) return;

  const lines = events.map((event) => JSON.stringify(event)).join("\n") + "\n";

  // homedir() (not process.env.HOME) resolves correctly on Windows too, where
  // HOME is unset and the home path lives in USERPROFILE.
  const eventsFile =
    process.env.FLEET_EVENTS_FILE || join(homedir(), ".agenticade", "events.jsonl");

  mkdirSync(dirname(eventsFile), { recursive: true });
  appendFileSync(eventsFile, lines);
}

try {
  main()
    .then(() => process.exit(0))
    .catch(() => process.exit(0));
} catch {
  process.exit(0);
}
