#!/usr/bin/env node
// FleetView npx installer (docs/FLEETVIEW-SPEC.md §17.2). Zero-dep, hand-rolled
// arg parsing, all home-relative paths derive from os.homedir() (the test seam
// — tests run with a scratch HOME). Two jobs:
//   1. Self-vendor a stable copy of this package to ~/.lumenade/app (npx's own
//      cache is ephemeral; hooks need a stable absolute path to invoke).
//   2. Merge FleetView's eight hook entries into ~/.claude/settings.json
//      without disturbing anything else the user has configured there.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  cpSync,
  rmSync,
  renameSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const EIGHT_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "Stop",
  "SubagentStart",
  "SubagentStop",
  "PreToolUse",
  "PostToolUse",
];
const TOOL_EVENTS = new Set(["PreToolUse", "PostToolUse"]);
const VENDOR_WHITELIST = [
  "LICENSE",
  "hooks",
  "adapters",
  "server",
  "public",
  "scripts",
  "fleet.config.json",
  "package.json",
  "README.md",
  join("docs", "FLEETVIEW-SPEC.md"),
];

function parseArgs(argv) {
  const opts = { yes: false, uninstall: false, dev: null, withCodex: false, start: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--yes") opts.yes = true;
    else if (arg === "--uninstall") opts.uninstall = true;
    else if (arg === "--with-codex") opts.withCodex = true;
    else if (arg === "--start") opts.start = true;
    else if (arg === "--dev") {
      opts.dev = argv[++i];
      if (!opts.dev) {
        console.error("fleetview: --dev requires a path argument");
        process.exit(1);
      }
    } else if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else {
      console.error(`fleetview: unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  return opts;
}

async function confirm(question, opts) {
  if (opts.yes) return true;
  if (!process.stdin.isTTY) return true; // nothing to prompt against; proceed
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((res) => rl.question(question, res));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

function readSettings(settingsPath) {
  if (!existsSync(settingsPath)) return { settings: {}, existed: false, raw: null };
  const raw = readFileSync(settingsPath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: true, raw };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: true, raw };
  }
  return { settings: parsed, existed: true, raw };
}

function backupSettings(settingsPath, raw) {
  const iso = new Date().toISOString();
  const backupPath = `${settingsPath}.fleetview-backup-${iso}`;
  writeFileSync(backupPath, raw);
  return backupPath;
}

function writeSettings(settingsPath, settings) {
  mkdirSync(dirname(settingsPath), { recursive: true });
  const tmpPath = `${settingsPath}.tmp-${process.pid}`;
  writeFileSync(tmpPath, `${JSON.stringify(settings, null, 2)}\n`);
  renameSync(tmpPath, settingsPath);
}

function entryHasFleetviewHook(entry) {
  if (!entry || !Array.isArray(entry.hooks)) return false;
  return entry.hooks.some(
    (h) => h && typeof h.command === "string" && h.command.includes("/hooks/emit-event.mjs")
  );
}

function buildFleetviewEntry(eventName, hookScriptPath) {
  const hookDef = { type: "command", command: `node ${hookScriptPath}`, timeout: 5 };
  return TOOL_EVENTS.has(eventName) ? { matcher: ".*", hooks: [hookDef] } : { hooks: [hookDef] };
}

function mergeHooks(settings, hookScriptPath) {
  if (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) {
    settings.hooks = {};
  }
  for (const eventName of EIGHT_EVENTS) {
    const existing = Array.isArray(settings.hooks[eventName]) ? settings.hooks[eventName] : [];
    const filtered = existing.filter((entry) => !entryHasFleetviewHook(entry));
    filtered.push(buildFleetviewEntry(eventName, hookScriptPath));
    settings.hooks[eventName] = filtered;
  }
}

function removeHooks(settings) {
  if (!settings.hooks || typeof settings.hooks !== "object") return;
  for (const eventName of EIGHT_EVENTS) {
    if (!Array.isArray(settings.hooks[eventName])) continue;
    const filtered = settings.hooks[eventName].filter((entry) => !entryHasFleetviewHook(entry));
    if (filtered.length > 0) settings.hooks[eventName] = filtered;
    else delete settings.hooks[eventName];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
}

// Codex hooks are plugin-gated (spec §18.1), so --with-codex only scaffolds a
// plugin package and prints the registration commands — the `codex plugin add`
// itself is a persistent, account-linked change the user performs. We never
// run codex commands or write under ~/.codex.
const CODEX_EVENTS = [
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "SessionStart",
  "UserPromptSubmit",
  "SubagentStart",
  "SubagentStop",
  "Stop",
];
const CODEX_TOOL_EVENTS = new Set(["PreToolUse", "PostToolUse"]);

function scaffoldCodexPlugin(pluginDir, hookScriptPath) {
  mkdirSync(join(pluginDir, ".codex-plugin"), { recursive: true });
  writeFileSync(
    join(pluginDir, ".codex-plugin", "plugin.json"),
    `${JSON.stringify(
      {
        name: "fleetview",
        version: "3.0.0",
        description: "FleetView capture hooks for Codex CLI (experimental)",
      },
      null,
      2
    )}\n`
  );

  const hooks = {};
  for (const eventName of CODEX_EVENTS) {
    const hookDef = { type: "command", command: `node ${hookScriptPath} codex` };
    hooks[eventName] = [
      CODEX_TOOL_EVENTS.has(eventName)
        ? { matcher: "*", hooks: [hookDef] }
        : { hooks: [hookDef] },
    ];
  }
  writeFileSync(join(pluginDir, "hooks.json"), `${JSON.stringify({ hooks }, null, 2)}\n`);

  console.log(`Scaffolded Codex plugin at ${pluginDir} (experimental).`);
  console.log("Codex hooks only run from a registered plugin. To register it, run these yourself");
  console.log("(this records the plugin into your Codex installation):");
  console.log(`  codex plugin marketplace add ${pluginDir}`);
  console.log("  codex plugin add fleetview");
  console.log("No-plugin alternative (turn boundaries only): add to ~/.codex/config.toml:");
  console.log(`  notify = ["node", "${hookScriptPath}", "codex-notify"]`);
}

// Self-vendoring copy: package root -> ~/.lumenade/app.staging-<pid> -> rename
// into place at ~/.lumenade/app. Preserves a user-modified app/fleet.config.json
// across upgrades.
function selfVendor(packageRoot, home) {
  const lumenadeDir = join(home, ".lumenade");
  const appDir = join(lumenadeDir, "app");
  const staging = join(lumenadeDir, `app.staging-${process.pid}`);

  mkdirSync(lumenadeDir, { recursive: true });
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  for (const item of VENDOR_WHITELIST) {
    const src = join(packageRoot, item);
    if (!existsSync(src)) continue;
    const dest = join(staging, item);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest, { recursive: true });
  }

  let notice = null;
  const bundledConfig = join(packageRoot, "fleet.config.json");
  const oldConfig = join(appDir, "fleet.config.json");
  if (existsSync(oldConfig) && existsSync(bundledConfig)) {
    const oldContent = readFileSync(oldConfig, "utf8");
    const bundledContent = readFileSync(bundledConfig, "utf8");
    if (oldContent !== bundledContent) {
      writeFileSync(join(staging, "fleet.config.json"), oldContent);
      notice = "Preserved your existing app/fleet.config.json (it differs from the bundled default).";
    }
  }

  rmSync(appDir, { recursive: true, force: true });
  renameSync(staging, appDir);
  return { appDir, notice };
}

function printUsage() {
  console.log(
    [
      "Usage: fleetview [--yes] [--uninstall] [--dev <repo-path>] [--with-codex] [--start]",
      "",
      "  --yes           non-interactive, skip confirmation",
      "  --uninstall     remove FleetView's hook entries from ~/.claude/settings.json",
      "  --dev <path>    wire hooks at an existing checkout instead of vendoring a copy",
      "  --with-codex    experimental — scaffold a Codex hooks plugin + print registration steps",
      "                  (plugin dir: <app>/codex-plugin, or ~/.lumenade/codex-plugin with --dev)",
      "  --start         run the server in the foreground after installing",
    ].join("\n")
  );
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printUsage();
    return;
  }
  const home = homedir();
  const settingsPath = join(home, ".claude", "settings.json");

  const loaded = readSettings(settingsPath);
  if (loaded.error) {
    console.error(
      `fleetview: ${settingsPath} contains invalid JSON. Aborting without making any changes.`
    );
    process.exit(1);
  }
  const { settings, existed, raw } = loaded;

  if (opts.uninstall) {
    const ok = await confirm("Remove FleetView's hooks from settings.json? [y/N] ", opts);
    if (!ok) {
      console.log("Aborted — no changes made.");
      return;
    }
    if (!existed) {
      console.log("fleetview: nothing to uninstall — no settings.json found.");
      return;
    }
    const backupPath = backupSettings(settingsPath, raw);
    removeHooks(settings);
    writeSettings(settingsPath, settings);
    console.log(`Removed FleetView's hook entries from ${settingsPath}.`);
    console.log(`Backup kept at ${backupPath}.`);
    console.log(`To finish removal: rm -rf ${join(home, ".lumenade")}`);
    return;
  }

  const ok = await confirm("Install FleetView's hooks into settings.json? [y/N] ", opts);
  if (!ok) {
    console.log("Aborted — no changes made.");
    return;
  }

  let hookScriptPath;
  let appDir = null;
  if (opts.dev) {
    const devRoot = resolve(opts.dev);
    hookScriptPath = join(devRoot, "hooks", "emit-event.mjs");
    console.log(`Wiring hooks at dev checkout: ${devRoot} (no files copied).`);
  } else {
    const __filename = fileURLToPath(import.meta.url);
    const packageRoot = dirname(dirname(__filename));
    const vendored = selfVendor(packageRoot, home);
    appDir = vendored.appDir;
    hookScriptPath = join(appDir, "hooks", "emit-event.mjs");
    console.log(`Installed app to ${appDir}.`);
    if (vendored.notice) console.log(vendored.notice);
  }

  if (existed) {
    const backupPath = backupSettings(settingsPath, raw);
    console.log(`Backed up existing settings to ${backupPath}.`);
  }
  mergeHooks(settings, hookScriptPath);
  writeSettings(settingsPath, settings);
  console.log(`Wired FleetView's hooks into ${settingsPath}.`);

  if (opts.withCodex) {
    const pluginDir = appDir
      ? join(appDir, "codex-plugin")
      : join(home, ".lumenade", "codex-plugin");
    scaffoldCodexPlugin(pluginDir, hookScriptPath);
  }

  if (opts.start) {
    const serverPath = opts.dev
      ? join(resolve(opts.dev), "server", "server.mjs")
      : join(appDir, "server", "server.mjs");
    console.log(`Starting server: node ${serverPath}`);
    const child = spawn(process.execPath, [serverPath], { stdio: "inherit" });
    child.on("exit", (code) => process.exit(code ?? 0));
    return;
  }
}

main().catch((err) => {
  console.error(`fleetview: ${err && err.message ? err.message : err}`);
  process.exit(1);
});
