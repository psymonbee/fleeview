// Installer test suite (docs/FLEETVIEW-SPEC.md §17.2). Zero deps: node:test +
// node:assert only. Spawns bin/install.mjs as a child process with HOME
// pointed at a scratch directory (the test seam — the installer derives all
// home-relative paths from os.homedir()), so it never touches the real
// ~/.claude/settings.json or ~/.lumenade/.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INSTALLER = join(__dirname, "..", "bin", "install.mjs");
const STARTER_AGENTS = [
  "builder.md",
  "checker.md",
  "codex-runner.md",
  "researcher.md",
  "writer.md",
];
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

function makeScratchHome() {
  return mkdtempSync(join(tmpdir(), "fleetview-install-test-"));
}

function runInstaller(home, args = ["--yes"]) {
  return spawnSync(process.execPath, [INSTALLER, ...args], {
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
}

function settingsPath(home) {
  return join(home, ".claude", "settings.json");
}

function readSettings(home) {
  return JSON.parse(readFileSync(settingsPath(home), "utf8"));
}

function backupFiles(home) {
  const claudeDir = join(home, ".claude");
  if (!existsSync(claudeDir)) return [];
  return readdirSync(claudeDir).filter((f) => f.includes("fleetview-backup"));
}

function agentsDir(home) {
  return join(home, ".claude", "agents");
}

// Minimal frontmatter sanity check — mirrors the shape server/discovery.mjs
// (spec §22) expects: a `---` fence, `key: value` scalar lines inside it,
// then a closing `---` fence.
function parseFrontmatterKeys(text) {
  if (!text.startsWith("---\n")) return null;
  const end = text.indexOf("\n---", 4);
  if (end === -1) return null;
  const body = text.slice(4, end);
  const keys = {};
  for (const line of body.split("\n")) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (m) keys[m[1]] = m[2].trim();
  }
  return keys;
}

describe("bin/install.mjs — fresh install", () => {
  const home = makeScratchHome();

  test("exits 0 and wires all 8 events", () => {
    const result = runInstaller(home);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const settings = readSettings(home);
    for (const eventName of EIGHT_EVENTS) {
      assert.ok(Array.isArray(settings.hooks[eventName]), `${eventName} present`);
      assert.equal(settings.hooks[eventName].length, 1);
    }
  });

  test("matcher '.*' present only on PreToolUse/PostToolUse; timeout 5 everywhere", () => {
    const settings = readSettings(home);
    for (const eventName of EIGHT_EVENTS) {
      const [entry] = settings.hooks[eventName];
      if (TOOL_EVENTS.has(eventName)) {
        assert.equal(entry.matcher, ".*", `${eventName} matcher`);
      } else {
        assert.equal(entry.matcher, undefined, `${eventName} should have no matcher`);
      }
      assert.equal(entry.hooks[0].type, "command");
      assert.equal(entry.hooks[0].timeout, 5);
      assert.ok(entry.hooks[0].command.includes("/hooks/emit-event.mjs"));
    }
  });

  test("app dir populated and copied hook passes node --check", () => {
    const hookPath = join(home, ".lumenade", "app", "hooks", "emit-event.mjs");
    assert.ok(existsSync(hookPath), "copied hook exists");
    const check = spawnSync(process.execPath, ["--check", hookPath], { encoding: "utf8" });
    assert.equal(check.status, 0, `node --check failed: ${check.stderr}`);
  });

  rmSync(home, { recursive: true, force: true });
});

describe("bin/install.mjs — pre-existing settings with sentinel keys", () => {
  test("preserves foreign keys/hooks and appends FleetView entry", () => {
    const home = makeScratchHome();
    try {
      mkdirSync(join(home, ".claude"), { recursive: true });
      const original = {
        theme: "dark",
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: "some-foreign-hook", timeout: 3 }],
            },
          ],
        },
      };
      writeFileSync(settingsPath(home), JSON.stringify(original, null, 2));

      const result = runInstaller(home);
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);

      const settings = readSettings(home);
      assert.equal(settings.theme, "dark");
      assert.equal(settings.hooks.PreToolUse.length, 2);
      const foreign = settings.hooks.PreToolUse.find((e) => e.matcher === "Bash");
      assert.ok(foreign, "foreign PreToolUse entry survives");
      assert.equal(foreign.hooks[0].command, "some-foreign-hook");
      const fleetview = settings.hooks.PreToolUse.find((e) => e.matcher === ".*");
      assert.ok(fleetview, "FleetView entry appended");

      // backup exists and parses, and matches the pre-install content
      const backups = backupFiles(home);
      assert.equal(backups.length, 1);
      const backupContent = JSON.parse(
        readFileSync(join(home, ".claude", backups[0]), "utf8")
      );
      assert.deepEqual(backupContent, original);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("bin/install.mjs — idempotency", () => {
  test("second run does not duplicate entries", () => {
    const home = makeScratchHome();
    try {
      mkdirSync(join(home, ".claude"), { recursive: true });
      const original = {
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: "some-foreign-hook" }],
            },
          ],
        },
      };
      writeFileSync(settingsPath(home), JSON.stringify(original, null, 2));

      const first = runInstaller(home);
      assert.equal(first.status, 0);
      const second = runInstaller(home);
      assert.equal(second.status, 0);

      const settings = readSettings(home);
      for (const eventName of EIGHT_EVENTS) {
        const fleetviewEntries = settings.hooks[eventName].filter(
          (e) => e.hooks[0].command.includes("/hooks/emit-event.mjs")
        );
        assert.equal(fleetviewEntries.length, 1, `${eventName} has exactly one FleetView entry`);
      }
      assert.equal(settings.hooks.PreToolUse.length, 2, "foreign entry still present, no dupes");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("bin/install.mjs — corrupt settings JSON", () => {
  test("aborts non-zero, leaves the file byte-identical, no backup", () => {
    const home = makeScratchHome();
    try {
      mkdirSync(join(home, ".claude"), { recursive: true });
      const corrupt = "{not valid json, oops";
      writeFileSync(settingsPath(home), corrupt);

      const result = runInstaller(home);
      assert.notEqual(result.status, 0);

      const after = readFileSync(settingsPath(home), "utf8");
      assert.equal(after, corrupt, "file must be untouched");
      assert.equal(backupFiles(home).length, 0, "no backup should be written");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("bin/install.mjs — --uninstall", () => {
  test("removes only FleetView entries; foreign hook survives", () => {
    const home = makeScratchHome();
    try {
      // Install first, then hand-inject a foreign hook alongside it.
      const install = runInstaller(home);
      assert.equal(install.status, 0);

      const settings = readSettings(home);
      settings.hooks.PreToolUse.push({
        matcher: "Bash",
        hooks: [{ type: "command", command: "some-foreign-hook" }],
      });
      writeFileSync(settingsPath(home), JSON.stringify(settings, null, 2));

      const result = runInstaller(home, ["--yes", "--uninstall"]);
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);

      const after = readSettings(home);
      // No FleetView entries remain anywhere.
      for (const eventName of EIGHT_EVENTS) {
        const remaining = after.hooks?.[eventName] || [];
        for (const entry of remaining) {
          assert.ok(
            !entry.hooks.some((h) => h.command.includes("/hooks/emit-event.mjs")),
            `${eventName} should have no FleetView hooks left`
          );
        }
      }
      // Foreign hook survives.
      assert.ok(after.hooks.PreToolUse.some((e) => e.matcher === "Bash"));

      // App dir is left alone (removal is a manual rm -rf per spec §17.3).
      assert.ok(existsSync(join(home, ".lumenade", "app")));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("bin/install.mjs — --dev", () => {
  test("wires hooks at the given path without copying", () => {
    const home = makeScratchHome();
    try {
      const devPath = join(home, "dev-checkout");
      const result = runInstaller(home, ["--yes", "--dev", devPath]);
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);

      const settings = readSettings(home);
      const [entry] = settings.hooks.SessionStart;
      assert.equal(entry.hooks[0].command, `node ${join(devPath, "hooks", "emit-event.mjs")}`);

      assert.ok(!existsSync(join(home, ".lumenade", "app")), "no vendored copy created");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("bin/install.mjs — --with-codex (§18.4)", () => {
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

  test("scaffolds the plugin package and prints registration steps; never touches ~/.codex", () => {
    const home = makeScratchHome();
    try {
      const result = runInstaller(home, ["--yes", "--with-codex"]);
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);

      const pluginDir = join(home, ".lumenade", "app", "codex-plugin");
      const manifest = JSON.parse(
        readFileSync(join(pluginDir, ".codex-plugin", "plugin.json"), "utf8")
      );
      assert.equal(manifest.name, "fleetview");

      const { hooks } = JSON.parse(readFileSync(join(pluginDir, "hooks.json"), "utf8"));
      assert.deepEqual(Object.keys(hooks).sort(), [...CODEX_EVENTS].sort());
      for (const eventName of CODEX_EVENTS) {
        const [entry] = hooks[eventName];
        const isToolEvent = eventName === "PreToolUse" || eventName === "PostToolUse";
        assert.equal(entry.matcher, isToolEvent ? "*" : undefined, `${eventName} matcher`);
        assert.ok(
          entry.hooks[0].command.endsWith("emit-event.mjs codex"),
          `${eventName} command uses the codex adapter arg`
        );
        assert.ok(
          entry.hooks[0].command.includes(join(home, ".lumenade", "app")),
          `${eventName} command points at the vendored app`
        );
      }

      assert.ok(result.stdout.includes("codex plugin marketplace add"), "prints registration");
      assert.ok(result.stdout.includes("codex-notify"), "prints notify alternative");
      assert.ok(!existsSync(join(home, ".codex")), "nothing created under ~/.codex");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("--dev --with-codex scaffolds under ~/.lumenade/codex-plugin pointing at the checkout", () => {
    const home = makeScratchHome();
    try {
      const devPath = join(home, "dev-checkout");
      const result = runInstaller(home, ["--yes", "--dev", devPath, "--with-codex"]);
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);

      const pluginDir = join(home, ".lumenade", "codex-plugin");
      const { hooks } = JSON.parse(readFileSync(join(pluginDir, "hooks.json"), "utf8"));
      const [entry] = hooks.SessionStart;
      assert.equal(
        entry.hooks[0].command,
        `node ${join(devPath, "hooks", "emit-event.mjs")} codex`
      );
      assert.ok(!existsSync(join(home, ".lumenade", "app")), "still no vendored copy");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("bin/install.mjs — --with-agents (§23)", () => {
  test("writes all 5 starter agents with parseable frontmatter and prints 'written'", () => {
    const home = makeScratchHome();
    try {
      const result = runInstaller(home, ["--yes", "--with-agents"]);
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);

      for (const file of STARTER_AGENTS) {
        const dest = join(agentsDir(home), file);
        assert.ok(existsSync(dest), `${file} written`);
        const keys = parseFrontmatterKeys(readFileSync(dest, "utf8"));
        assert.ok(keys, `${file} has a parseable frontmatter fence`);
        assert.ok(keys.name, `${file} frontmatter has name`);
        assert.ok(keys.description, `${file} frontmatter has description`);
        assert.ok(keys.model, `${file} frontmatter has model`);
        assert.ok(result.stdout.includes(`written ${dest}`), `stdout announces ${file} written`);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("pre-seeded builder.md is preserved byte-identical and reported skipped; others still written", () => {
    const home = makeScratchHome();
    try {
      mkdirSync(agentsDir(home), { recursive: true });
      const sentinel = "---\nname: builder\ndescription: my own thing\nmodel: opus\n---\n\nDo not touch this.\n";
      const builderPath = join(agentsDir(home), "builder.md");
      writeFileSync(builderPath, sentinel);

      const result = runInstaller(home, ["--yes", "--with-agents"]);
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);

      assert.equal(readFileSync(builderPath, "utf8"), sentinel, "builder.md untouched byte-for-byte");
      assert.ok(
        result.stdout.includes(`skipped (exists) ${builderPath}`),
        "stdout announces builder.md skipped"
      );

      for (const file of ["checker.md", "codex-runner.md", "researcher.md", "writer.md"]) {
        const dest = join(agentsDir(home), file);
        assert.ok(existsSync(dest), `${file} still written`);
        assert.ok(result.stdout.includes(`written ${dest}`), `stdout announces ${file} written`);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("without the flag, ~/.claude/agents is never created", () => {
    const home = makeScratchHome();
    try {
      const result = runInstaller(home, ["--yes"]);
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      assert.ok(!existsSync(agentsDir(home)), "~/.claude/agents absent without --with-agents");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("--uninstall never touches ~/.claude/agents; starter agents survive", () => {
    const home = makeScratchHome();
    try {
      const install = runInstaller(home, ["--yes", "--with-agents"]);
      assert.equal(install.status, 0, `stderr: ${install.stderr}`);

      const result = runInstaller(home, ["--yes", "--uninstall"]);
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);

      for (const file of STARTER_AGENTS) {
        const dest = join(agentsDir(home), file);
        assert.ok(existsSync(dest), `${file} survives --uninstall`);
        assert.ok(
          result.stdout.includes("left in place (yours now)"),
          "stdout notes agents left in place"
        );
        assert.ok(result.stdout.includes(dest), `stdout names ${file}'s path`);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("vendored ~/.lumenade/app contains starter-agents/ with all 5 files", () => {
    const home = makeScratchHome();
    try {
      const result = runInstaller(home, ["--yes"]);
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);

      const vendoredDir = join(home, ".lumenade", "app", "starter-agents");
      assert.ok(existsSync(vendoredDir), "starter-agents/ vendored");
      for (const file of STARTER_AGENTS) {
        assert.ok(existsSync(join(vendoredDir, file)), `${file} vendored`);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
