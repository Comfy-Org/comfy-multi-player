#!/usr/bin/env node
/**
 * Merge the nightly mutation shards into the one report `check:mutation-report`
 * judges.
 *
 * Usage: node scripts/merge-mutation-reports.mjs <expected-shard-count>
 *
 * Reads every `reports/mutation/shards/*.json` (one per shard of
 * stryker.shard.config.mjs), concatenates each file's mutants, and writes
 * `reports/mutation/mutation.json` with the break/low/high thresholds from
 * `stryker.config.mjs`. Mutant ids restart in every Stryker run, so each id is
 * prefixed with its shard name to keep them unique.
 *
 * A missing shard is not merged around: fewer reports than expected exits 2
 * (INCONCLUSIVE, as `check:mutation-report` uses the code), because a score
 * over part of the mutate glob is not the score.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const shardDir = join(root, "reports", "mutation", "shards");
const outPath = join(root, "reports", "mutation", "mutation.json");

function inconclusive(msg) {
  console.error(`\nmutation merge INCONCLUSIVE: ${msg}`);
  process.exit(2);
}

const expected = Number(process.argv[2]);
if (!Number.isInteger(expected) || expected < 1) {
  console.error("usage: merge-mutation-reports.mjs <expected-shard-count>");
  process.exit(2);
}

const names = existsSync(shardDir) ? readdirSync(shardDir).filter((n) => n.endsWith(".json")).sort() : [];
if (names.length !== expected) {
  inconclusive(`found ${names.length} shard report(s) in ${shardDir}, expected ${expected}: [${names.join(", ")}]`);
}

const { default: config } = await import(pathToFileURL(join(root, "stryker.config.mjs")).href);
const files = {};
let schemaVersion;
for (const name of names) {
  const shard = basename(name, ".json");
  let report;
  try {
    report = JSON.parse(readFileSync(join(shardDir, name), "utf8"));
  } catch (error) {
    inconclusive(`could not read or parse shard ${name}: ${error.message}`);
  }
  schemaVersion ??= report.schemaVersion;
  for (const [path, file] of Object.entries(report.files ?? {})) {
    const target = (files[path] ??= { language: file.language, source: file.source, mutants: [] });
    for (const mutant of file.mutants ?? []) {
      target.mutants.push({ ...mutant, id: `${shard}-${mutant.id}` });
    }
  }
}

const missing = config.mutate.filter((path) => !files[path]);
if (missing.length > 0) {
  inconclusive(`no mutants from ${missing.join(", ")}: the shards do not cover the stryker.config.mjs mutate glob`);
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify({ schemaVersion: schemaVersion ?? "1", thresholds: config.thresholds, files }));
const total = Object.values(files).reduce((n, f) => n + f.mutants.length, 0);
console.log(`merged ${names.length} shard(s): ${total} mutants over ${Object.keys(files).length} file(s) -> ${outPath}`);
