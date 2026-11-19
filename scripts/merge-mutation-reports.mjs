#!/usr/bin/env node
/**
 * Merge the nightly mutation shards into the one report `check:mutation-report`
 * judges.
 *
 * Usage: node scripts/merge-mutation-reports.mjs <expected-shard-count>
 *
 * Each shard of stryker.shard.config.mjs leaves `reports/mutation/shards/<id>.json`
 * (its Stryker report) and `<id>.range.json` (the file and line range it owned).
 * This keeps only the mutants that lie inside their shard's range, so a cached
 * result that incremental mode carried out of range is not counted twice,
 * concatenates each file's mutants, and writes `reports/mutation/mutation.json`
 * with the break/low/high thresholds from `stryker.config.mjs`. Mutant ids
 * restart in every Stryker run, so each id is prefixed with its shard name.
 *
 * Exits 2 (INCONCLUSIVE, as `check:mutation-report` uses the code) rather than
 * score part of the mutate glob as the whole: a missing or unreadable shard, a
 * file whose shard ranges do not tile it from line 1 without gaps or overlap, a
 * `mutate` file with no mutants, or the same mutant reported twice.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const shardDir = join(root, "reports", "mutation", "shards");
const outPath = join(root, "reports", "mutation", "mutation.json");

function inconclusive(msg) {
  console.error(`\nmutation merge INCONCLUSIVE: ${msg}`);
  process.exit(2);
}

function readJson(name) {
  try {
    return JSON.parse(readFileSync(join(shardDir, name), "utf8"));
  } catch (error) {
    return inconclusive(`could not read or parse shard ${name}: ${error.message}`);
  }
}

const expected = Number(process.argv[2]);
if (!Number.isInteger(expected) || expected < 1) {
  console.error("usage: merge-mutation-reports.mjs <expected-shard-count>");
  process.exit(2);
}

const ids = existsSync(shardDir)
  ? readdirSync(shardDir).filter((n) => n.endsWith(".json") && !n.endsWith(".range.json")).map((n) => n.slice(0, -5)).sort()
  : [];
if (ids.length !== expected) {
  inconclusive(`found ${ids.length} shard report(s) in ${shardDir}, expected ${expected}: [${ids.join(", ")}]`);
}

const { default: config } = await import(pathToFileURL(join(root, "stryker.config.mjs")).href);
const files = {};
const ranges = {};
const seen = new Set();
let schemaVersion;
let dropped = 0;
for (const id of ids) {
  const report = readJson(`${id}.json`);
  if (!existsSync(join(shardDir, `${id}.range.json`))) inconclusive(`shard ${id} has no ${id}.range.json`);
  const range = readJson(`${id}.range.json`);
  (ranges[range.file] ??= []).push([range.startLine, range.endLine, id]);
  schemaVersion ??= report.schemaVersion;
  for (const [path, file] of Object.entries(report.files ?? {})) {
    const target = (files[path] ??= { language: file.language, source: file.source, mutants: [] });
    for (const mutant of file.mutants ?? []) {
      const { start, end } = mutant.location ?? {};
      if (path !== range.file || !(start?.line >= range.startLine && end?.line <= range.endLine)) {
        dropped++;
        continue;
      }
      const key = JSON.stringify([path, mutant.mutatorName, mutant.replacement, mutant.location]);
      if (seen.has(key)) inconclusive(`mutant ${key} is reported by more than one shard`);
      seen.add(key);
      target.mutants.push({ ...mutant, id: `${id}-${mutant.id}` });
    }
  }
}

for (const [path, parts] of Object.entries(ranges)) {
  parts.sort((a, b) => a[0] - b[0]);
  let next = 1;
  for (const [start, end, id] of parts) {
    if (start !== next) inconclusive(`shard ranges for ${path} do not tile it: ${id} starts at line ${start}, expected ${next}`);
    next = end + 1;
  }
}

const missing = config.mutate.filter((path) => !files[path]?.mutants.length);
if (missing.length > 0) {
  inconclusive(`no mutants from ${missing.join(", ")}: the shards do not cover the stryker.config.mjs mutate glob`);
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify({ schemaVersion: schemaVersion ?? "1", thresholds: config.thresholds, files }));
const total = Object.values(files).reduce((n, f) => n + f.mutants.length, 0);
console.log(`merged ${ids.length} shard(s): ${total} mutants over ${Object.keys(files).length} file(s) -> ${outPath}`);
if (dropped > 0) console.log(`dropped ${dropped} result(s) outside their shard's range (relocated incremental results)`);
