#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const root = process.cwd();
const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean);
const markdownTargetPattern = /\]\(\s*<?([^)\s>]+)>?/g;
const markdownReferenceTargetPattern = /^[ \t]{0,3}\[[^\]]+\]:[ \t]*<?([^>\s]+)>?/gm;
const repositoryAdrPattern = /docs\/adr\/[A-Za-z0-9._/-]+\.md/g;
const failures = [];

function adrTargets(filename, text) {
  const targets = new Map();
  const add = (target, index) => {
    if (!targets.has(target)) {
      targets.set(target, text.slice(0, index).split("\n").length);
    }
  };
  for (const match of text.matchAll(repositoryAdrPattern)) {
    add(match[0], match.index);
  }
  for (const match of [
    ...text.matchAll(markdownTargetPattern),
    ...text.matchAll(markdownReferenceTargetPattern),
  ]) {
    const rawTarget = match[1];
    if (!rawTarget || rawTarget.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(rawTarget)) {
      continue;
    }
    let pathname;
    try {
      pathname = decodeURIComponent(rawTarget.split(/[?#]/, 1)[0] ?? "");
    } catch {
      continue;
    }
    if (!pathname.endsWith(".md")) continue;
    const resolved = resolve(root, dirname(filename), pathname);
    const fromRoot = relative(root, resolved);
    if (fromRoot === "docs/adr" || fromRoot.startsWith(`docs${sep}adr${sep}`)) {
      add(fromRoot, match.index);
    }
  }
  return targets;
}

for (const filename of files) {
  const absolute = join(root, filename);
  if (!existsSync(absolute)) continue;
  const contents = readFileSync(absolute);
  if (contents.includes(0)) continue;
  const text = contents.toString("utf8");
  for (const [target, line] of adrTargets(filename, text)) {
    if (existsSync(join(root, target))) continue;
    failures.push(`${filename}:${line} -> ${target}`);
  }
}

if (failures.length > 0) {
  process.stderr.write(
    `Dangling docs/adr references:\n${failures.join("\n")}\n`,
  );
  process.exit(1);
}

process.stdout.write("ADR link validation passed\n");
