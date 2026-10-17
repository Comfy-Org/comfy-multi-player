#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean);
const referencePattern = /docs\/adr\/[A-Za-z0-9._/-]+\.md/g;
const failures = [];

for (const filename of files) {
  const absolute = join(root, filename);
  if (!existsSync(absolute)) continue;
  const contents = readFileSync(absolute);
  if (contents.includes(0)) continue;
  const text = contents.toString("utf8");
  for (const match of text.matchAll(referencePattern)) {
    const target = match[0];
    if (existsSync(join(root, target))) continue;
    const line = text.slice(0, match.index).split("\n").length;
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
