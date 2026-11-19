/**
 * One shard of the nightly mutation run (.github/workflows/mutation.yml).
 *
 * A cold run of the whole `mutate` glob in `stryker.config.mjs` takes longer
 * than a GitHub job may run, and `incremental: true` only writes its report on
 * a run that completes, so the unsharded nightly never seeded its cache and
 * failed every night. Each shard mutates one line range of the same files, so
 * every job finishes, seeds its own incremental report, and later runs reuse
 * it.
 *
 * Everything that decides how a mutant is scored (`timeoutMS`,
 * `timeoutFactor`, `concurrency`, `coverageAnalysis`, the test runner) comes
 * unchanged from `stryker.config.mjs`. Only three things differ per shard: the
 * `mutate` range, the incremental and report file names, and the break
 * threshold, which is judged once on the merged report by
 * `scripts/merge-mutation-reports.mjs` + `check:mutation-report` rather than
 * per shard (a shard's local score says nothing about the whole).
 *
 * MUTATION_SHARD is a Stryker mutate pattern with a line range, for example
 * `src/applier.ts:1-550`; MUTATION_SHARD_ID names the shard's files.
 *
 * @type {import('@stryker-mutator/api/core').PartialStrykerOptions}
 */
import base from "./stryker.config.mjs";

const shard = process.env.MUTATION_SHARD;
const id = process.env.MUTATION_SHARD_ID;
if (!shard || !id || !/^[a-z0-9-]+$/.test(id)) {
  throw new Error("stryker.shard.config.mjs needs MUTATION_SHARD (e.g. src/applier.ts:1-550) and MUTATION_SHARD_ID ([a-z0-9-]+)");
}
const file = shard.replace(/:.*$/, "");
if (!base.mutate.includes(file)) {
  throw new Error(`MUTATION_SHARD file ${file} is not in stryker.config.mjs mutate`);
}

export default {
  ...base,
  mutate: [shard],
  incrementalFile: `reports/stryker-incremental-${id}.json`,
  reporters: ["clear-text", "json"],
  jsonReporter: { fileName: `reports/mutation/shards/${id}.json` },
  thresholds: { ...base.thresholds, break: null },
};
