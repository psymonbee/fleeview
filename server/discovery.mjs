// Agent auto-discovery (docs/FLEETVIEW-SPEC.md §22): finds Claude Code agent
// definitions (`~/.claude/agents/*.md`, `<cwd>/.claude/agents/*.md`) so
// bolt-on users' custom agents render with real labels/models instead of
// falling back to generic styling. Zero npm dependencies, node:fs only.
// Never throws back into the caller: every failure path (missing dir,
// unreadable file, malformed frontmatter) is swallowed here.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const FRONTMATTER_KEYS = new Set(["name", "description", "model"]);

// Hand-rolled frontmatter parser -- not a general YAML parser. The file must
// begin with a `---` fence line, single-line `key: value` scalars are read
// up to the closing `---` fence, and only `name`/`description`/`model` are
// kept (unknown keys ignored). Values may be single- or double-quoted; CRLF
// line endings are tolerated. No fence, an unterminated fence, or an empty
// file all resolve to `null`. Multiline (block-scalar) values are ignored --
// a continuation line simply doesn't match `key: value` and is skipped.
export function parseFrontmatter(text) {
  if (typeof text !== "string" || text.length === 0) return null;

  const lines = text.split(/\r\n|\n/);
  if (lines[0] !== "---") return null;

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return null; // unterminated fence

  const result = {};
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    const colon = line.indexOf(":");
    if (colon === -1) continue; // not a `key: value` line -- ignored
    const key = line.slice(0, colon).trim();
    if (!FRONTMATTER_KEYS.has(key)) continue;

    let value = line.slice(colon + 1).trim();
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      }
    }
    result[key] = value;
  }
  return result;
}

// Non-recursive scan of `dir` for `*.md` agent definitions. Returns
// `{ [name]: {label, description?, model?} }`. Missing dir or unreadable
// file -> skipped silently (never throws).
export function scanAgentDir(dir) {
  const result = {};

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return result; // missing/unreadable dir
  }

  for (const entry of entries) {
    if (entry.isDirectory()) continue; // non-recursive
    if (!entry.name.endsWith(".md")) continue;

    let text;
    try {
      text = readFileSync(path.join(dir, entry.name), "utf8");
    } catch {
      continue; // unreadable file -- skipped silently
    }

    const fm = parseFrontmatter(text);
    const stem = entry.name.slice(0, -3);
    const name = (fm && fm.name) || stem;

    const meta = { label: name };
    if (fm && fm.description !== undefined) meta.description = fm.description;
    if (fm && fm.model !== undefined) meta.model = fm.model;
    result[name] = meta;
  }

  return result;
}
