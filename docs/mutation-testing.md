# Mutation testing

Stryker measures whether the test suite detects behavioral regressions in the load-bearing CRDT code. The configured scope is `src/applier.ts`, `src/stamps.ts`, `src/project.ts`, `src/doc.ts`, and `src/mint.ts`. Tests, re-export-only `src/index.ts`, declarations in `src/types.ts`, and the compile-time helper `src/exhaustive.ts` are not mutated. `src/migrate.ts` and `src/schema-version.ts` are semantic files that should join the scope in a separately measured change.

`src/doc.ts` and `src/mint.ts` joined the scope in MUT-GLOB-KA4-1. Do not narrow it back: those files carry the schema §1 document layout, §1.2 opaque-widget routing, §5.3 shared-definition instance count, and §9 bootstrap-snapshot path.

## The score only means something because the run is pinned

Stryker classifies each mutant as `Killed`, `Survived`, `Timeout`, `NoCoverage`, or an error, and scores a `Timeout` as detected. That is appropriate for a genuinely non-terminating mutant and misleading for one that merely exceeded its budget on a busy host. Host-dependent timeout and worker defaults can therefore move the score in the flattering direction by reclassifying survivors as timeouts.

`stryker.config.mjs` pins `timeoutMS`, `timeoutFactor`, `concurrency`, and `coverageAnalysis` for this reason. A score produced with other values is not comparable. `dryRunTimeoutMinutes` separately bounds the initial unmutated Vitest pass and does not classify individual mutants.

Incremental mode reuses a result only when Stryker determines that the mutant and its covering tests are unchanged. CI keys the incremental report by the operating system, dependency lock, and Stryker configuration, so changing a dependency or pinned measurement setting starts a full run.

## Baseline policy

No measured baseline is published here without retained output from `npm run check:mutation-report`. The available archived report belongs to a different historical checkout and configuration, so it cannot validate the figures formerly quoted here or in `stryker.config.mjs`.

The configured break threshold remains **84**. Keep a threshold below a freshly checked baseline rather than equal to it: zero margin turns the first uncovered line in a sibling change into a nominal score regression. Raise the threshold when the checked baseline rises. That headroom is for new code, not measurement noise.

Adding files to the mutation glob changes both the mutant population and the tests that run. Compare checked per-file outcomes, not only the overall score, when judging a change.

## Running it

```sh
npm ci
npm run build
npm run test:mutation
npm run check:mutation-report
```

Use Node 22 or newer. Do not quote a score unless the checker passes and its output is retained with the baseline evidence.

`check:mutation-report` re-derives the score from `reports/mutation/mutation.json`, reports `Timeout` separately, and also computes a floor with every timeout treated as a survivor. It exits:

| Exit | Meaning |
| --- | --- |
| 0 | Conclusive and at or above the break threshold |
| 1 | Conclusive and below the break threshold |
| 2 | **INCONCLUSIVE**: no report, fewer than 500 mutants, more than 2% of detected mutants timed out, or no `thresholds.break` value |

INCONCLUSIVE is not a pass. Re-run on a suitable host and retain the checker output; do not record the score.

Stryker writes local HTML and JSON reports plus the incremental report under `reports/`. Generated reports and `.stryker-tmp/` are ignored. `.github/workflows/mutation.yml` runs nightly and by manual dispatch, caches the incremental report, and uploads `reports/mutation/` as an artifact.
