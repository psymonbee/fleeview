#!/usr/bin/env node
// FleetView capture hook: stdin JSON -> adapters/claude-code.mjs -> appended
// neutral event lines. Pure observer: never throws/prints, always exit 0.
// All filtering/truncation policy lives in the adapter.

import { mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";

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

  const raw = await readStdin();

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }

  let events = [];
  try {
    const { translate } = await import(new URL("../adapters/claude-code.mjs", import.meta.url));
    events = translate(payload);
  } catch {
    return;
  }

  if (!Array.isArray(events) || events.length === 0) return;

  const lines = events.map((event) => JSON.stringify(event)).join("\n") + "\n";

  const eventsFile =
    process.env.FLEET_EVENTS_FILE || `${process.env.HOME}/.lumenade/events.jsonl`;

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
