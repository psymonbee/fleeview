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
  "starter-agents",
  "fleet.config.json",
  "package.json",
  "README.md",
  join("docs", "FLEETVIEW-SPEC.md"),
];
const STARTER_AGENTS = [
  "builder.md",
  "checker.md",
  "codex-runner.md",
  "researcher.md",
  "writer.md",
];

function parseArgs(argv) {
  const opts = {
    yes: false,
    uninstall: false,
    dev: null,
    withCodex: false,
    withAgents: false,
    start: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--yes") opts.yes = true;
    else if (arg === "--uninstall") opts.uninstall = true;
    else if (arg === "--with-codex") opts.withCodex = true;
    else if (arg === "--with-agents") opts.withAgents = true;
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
  // Windows forbids ':' in filenames (it's the drive/ADS separator), so a raw
  // ISO timestamp like 2026-07-20T19:47:19.747Z makes writeFileSync throw
  // ENOENT there — aborting the install before any hooks are wired. Swap the
  // colons for '-'; the suffix stays sortable, unique, and cross-platform.
  const stamp = new Date().toISOString().replace(/:/g, "-");
  const backupPath = `${settingsPath}.fleetview-backup-${stamp}`;
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

// Hook commands must name the interpreter by ABSOLUTE path (spec §17.4).
// Hooks are spawned by whatever launched the harness, and a GUI-launched
// Claude.app inherits the macOS default PATH (/usr/bin:/bin:/usr/sbin:/sbin) —
// which contains no nvm/fnm/volta node. A bare `node` there dies with "command
// not found", silently (a failing hook neither blocks the harness nor surfaces
// an error), so the events file is never created and the canvas stays empty.
// process.execPath is the node running this installer, so it always resolves.
const NODE_BIN = process.execPath;

function buildFleetviewEntry(eventName, hookScriptPath) {
  const hookDef = { type: "command", command: `${NODE_BIN} ${hookScriptPath}`, timeout: 5 };
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

// Codex loads hooks only from the user-level ~/.codex/config.toml (spec
// §18.4). Plugin delivery is a REMOVED Codex feature — a plugin installs,
// validates, reports "installed, enabled", and is never invoked (§18.6);
// do not re-attempt it. --with-codex therefore PRINTS the [hooks.*] block
// for the user to paste: the installer never runs codex commands and never
// writes under ~/.codex. Hook trust is hash-keyed to the exact block text
// (§18.5), so putting it in place — and re-approving after any change — is
// deliberately the user's action.
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

// No matcher on any entry: omitting it fires for every tool (verified live,
// §18.5 — and the real tool names are Claude-style, e.g. "Bash", so a
// "shell" matcher would silently match nothing).
function codexConfigBlock(hookScriptPath) {
  const lines = ["# --- FleetView capture hooks ---"];
  for (const eventName of CODEX_EVENTS) {
    lines.push(`[[hooks.${eventName}]]`);
    lines.push(`[[hooks.${eventName}.hooks]]`);
    lines.push('type = "command"');
    lines.push(`command = "${NODE_BIN} ${hookScriptPath} codex"`);
    lines.push("");
  }
  return lines.join("\n");
}

function printCodexInstructions(hookScriptPath) {
  console.log("");
  console.log("Codex capture (experimental) — nothing was written; wire it yourself in two steps:");
  console.log("");
  console.log("1. Paste this block at the END of ~/.codex/config.toml:");
  console.log("");
  console.log(codexConfigBlock(hookScriptPath));
  console.log("2. Run `codex` interactively once and approve its hook-trust prompt.");
  console.log("   Headless `codex exec` sessions are then captured too.");
  console.log("");
  console.log("Trust is tied to the exact hook text above. If it ever changes — including a");
  console.log("FleetView re-install printing a fresh block — Codex silently stops capturing");
  console.log("until you re-approve: no warning, no error, no events.");
  console.log("Alternative without hooks (turn boundaries only; requires the `notify` key to");
  console.log("be free — some tools already claim it): add to ~/.codex/config.toml:");
  console.log(`  notify = ["${NODE_BIN}", "${hookScriptPath}", "codex-notify"]`);
}

// Starter agents (spec §23, §30): copy the genericized agent definitions into
// ~/.claude/agents, never overwriting a file the user already has there. All
// of them are always offered — no PATH detection for codex; that's the owner's
// call to make (or not) after the fact.
function installStarterAgents(packageRoot, home) {
  const srcDir = join(packageRoot, "starter-agents");
  const destDir = join(home, ".claude", "agents");
  mkdirSync(destDir, { recursive: true });
  for (const file of STARTER_AGENTS) {
    const src = join(srcDir, file);
    const dest = join(destDir, file);
    if (existsSync(dest)) {
      console.log(`skipped (exists) ${dest}`);
      continue;
    }
    cpSync(src, dest);
    console.log(`written ${dest}`);
  }
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
      "Usage: fleetview [--yes] [--uninstall] [--dev <repo-path>] [--with-codex] [--with-agents] [--start]",
      "",
      "  --yes           non-interactive, skip confirmation",
      "  --uninstall     remove FleetView's hook entries from ~/.claude/settings.json",
      "  --dev <path>    wire hooks at an existing checkout instead of vendoring a copy",
      "  --with-codex    experimental — print the ~/.codex/config.toml hooks block + trust",
      "                  steps (prints only; you paste it — nothing under ~/.codex is touched)",
      "  --with-agents   copy the five starter agents (builder/checker/codex-runner/",
      "                  researcher/writer) into ~/.claude/agents (never overwrites a file",
      "                  already there)",
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
    const survivingAgents = STARTER_AGENTS.map((f) =>
      join(home, ".claude", "agents", f)
    ).filter(existsSync);
    if (survivingAgents.length > 0) {
      console.log("Starter agents left in place (yours now):");
      for (const p of survivingAgents) console.log(`  ${p}`);
    }
    return;
  }

  const ok = await confirm("Install FleetView's hooks into settings.json? [y/N] ", opts);
  if (!ok) {
    console.log("Aborted — no changes made.");
    return;
  }

  const __filename = fileURLToPath(import.meta.url);
  const packageRoot = dirname(dirname(__filename));

  let hookScriptPath;
  let appDir = null;
  if (opts.dev) {
    const devRoot = resolve(opts.dev);
    hookScriptPath = join(devRoot, "hooks", "emit-event.mjs");
    console.log(`Wiring hooks at dev checkout: ${devRoot} (no files copied).`);
  } else {
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
    printCodexInstructions(hookScriptPath);
  }

  if (opts.withAgents) {
    installStarterAgents(packageRoot, home);
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
