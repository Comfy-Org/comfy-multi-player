/**
 * One shard of the nightly mutation run (.github/workflows/mutation.yml).
 *
 * A cold run of the whole `mutate` glob in `stryker.config.mjs` takes longer
 * than a GitHub job may run, and `incremental: true` only writes its report on
 * a run that completes, so the unsharded nightly never seeded its cache and
 * failed every night (issue #303). Each shard mutates one part of one file, so
 * every job finishes, seeds its own incremental report, and later runs reuse
 * it.
 *
 * Everything that decides how a mutant is scored (`timeoutMS`,
 * `timeoutFactor`, `concurrency`, `coverageAnalysis`, the test runner) comes
 * unchanged from `stryker.config.mjs`. Only the `mutate` range, the incremental
 * and report file names, and the break threshold differ. Break is judged once,
 * on the merged report (`scripts/merge-mutation-reports.mjs`, then
 * `check:mutation-report`), because a shard's local score says nothing about
 * the whole.
 *
 * MUTATION_SHARD_FILE names one `mutate` file and MUTATION_SHARD_PART is `k/n`.
 * Part boundaries fall only between TOP-LEVEL statements: Stryker emits a
 * mutant only when its node lies wholly inside a `mutate` range, so a boundary
 * inside a function would silently drop every mutant whose node crosses it
 * (the function's own block, an `if` spanning the edge). Parts are contiguous
 * and together cover the file from line 1 to its last line. The resolved range
 * is written beside the report so the merge can drop any result outside it
 * (incremental mode can carry a relocated cached result out of range).
 *
 * @type {import('@stryker-mutator/api/core').PartialStrykerOptions}
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";
import base from "./stryker.config.mjs";

/**
 * Split `source` into `n` contiguous line ranges whose edges fall between
 * top-level statements, balancing line counts. Returns `[start, end]` pairs.
 */
export function topLevelParts(source, n) {
  const file = ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, true);
  const lineOf = (pos) => file.getLineAndCharacterOfPosition(pos).line + 1;
  const lastLine = lineOf(source.length);
  const statements = file.statements;
  // A legal edge is the end line of statement i when statement i + 1 starts on a
  // later line; two statements sharing a line can never be separated.
  const edges = [];
  for (let i = 0; i + 1 < statements.length; i++) {
    const end = lineOf(statements[i].getEnd());
    if (lineOf(statements[i + 1].getStart(file)) > end) edges.push(end);
  }
  if (n - 1 > edges.length) throw new Error(`cannot split ${edges.length + 1} top-level line groups into ${n} parts`);
  const parts = [];
  let start = 1;
  let next = 0;
  for (let k = 1; k < n; k++) {
    const target = Math.round((lastLine * k) / n);
    // Leave at least one edge for each remaining part.
    const maxIndex = edges.length - (n - k);
    let i = next;
    while (i < maxIndex && edges[i] < target) i++;
    parts.push([start, edges[i]]);
    start = edges[i] + 1;
    next = i + 1;
  }
  parts.push([start, lastLine]);
  return parts;
}

const file = process.env.MUTATION_SHARD_FILE;
const rawPart = process.env.MUTATION_SHARD_PART;
const part = /^(\d+)\/(\d+)$/.exec(rawPart ?? "");
const id = process.env.MUTATION_SHARD_ID;

let config = base;
// Any shard variable set, valid or not, means a shard was asked for: never fall
// back to the full unsharded run on a half-configured environment.
if (file !== undefined || rawPart !== undefined || id !== undefined) {
  if (!file || !part || !id || !/^[a-z0-9-]+$/.test(id)) {
    throw new Error("stryker.shard.config.mjs needs MUTATION_SHARD_FILE, MUTATION_SHARD_PART (k/n) and MUTATION_SHARD_ID ([a-z0-9-]+)");
  }
  if (!base.mutate.includes(file)) throw new Error(`MUTATION_SHARD_FILE ${file} is not in stryker.config.mjs mutate`);
  const k = Number(part[1]);
  const n = Number(part[2]);
  if (k < 1 || k > n) throw new Error(`MUTATION_SHARD_PART ${k}/${n} is out of range`);
  const source = readFileSync(file, "utf8");
  const [startLine, endLine] = topLevelParts(source, n)[k - 1];
  const lastLine = source.split("\n").length;
  mkdirSync("reports/mutation/shards", { recursive: true });
  writeFileSync(
    `reports/mutation/shards/${id}.range.json`,
    JSON.stringify({ file, part: `${k}/${n}`, startLine, endLine, lastLine }),
  );
  config = {
    ...base,
    mutate: [`${file}:${startLine}-${endLine}`],
    incrementalFile: `reports/stryker-incremental-${id}.json`,
    reporters: ["clear-text", "json"],
    jsonReporter: { fileName: `reports/mutation/shards/${id}.json` },
    thresholds: { ...base.thresholds, break: null },
  };
}

export default config;
