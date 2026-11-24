# Mutation testing

Stryker measures whether the test suite detects behavioral regressions in the load-bearing CRDT code. The configured scope is `src/applier.ts`, `src/stamps.ts`, `src/project.ts`, `src/doc.ts`, and `src/mint.ts`. Tests, re-export-only `src/index.ts`, declarations in `src/types.ts`, and the compile-time helper `src/exhaustive.ts` are not mutated. `src/migrate.ts` and `src/schema-version.ts` are semantic files that should join the scope in a separately measured change.

`src/doc.ts` and `src/mint.ts` joined the scope in MUT-GLOB-KA4-1. Do not narrow it back: those files carry the schema §1 document layout, §1.2 opaque-widget routing, §5.3 shared-definition instance count, and §9 bootstrap-snapshot path.

## The score only means something because the run is pinned

Stryker classifies each mutant as `Killed`, `Survived`, `Timeout`, `NoCoverage`, or an error, and scores a `Timeout` as detected. That is appropriate for a genuinely non-terminating mutant and misleading for one that merely exceeded its budget on a busy host. Host-dependent timeout and worker defaults can therefore move the score in the flattering direction by reclassifying survivors as timeouts.

`stryker.config.mjs` pins `timeoutMS`, `timeoutFactor`, `concurrency`, and `coverageAnalysis` for this reason. A score produced with other values is not comparable. `dryRunTimeoutMinutes` separately bounds the initial unmutated Vitest pass and does not classify individual mutants.

The scheduled workflow reached Stryker's default five-minute initial dry-run
ceiling on 2026-08-31 before writing `reports/mutation/mutation.json`.
The missing checker report and artifact were downstream symptoms. Raising
`dryRunTimeoutMinutes` lets the unmutated suite finish without changing
per-mutant classification settings.

Incremental mode reuses a result only when Stryker determines that the mutant and its covering tests are unchanged. CI keys the incremental report by the operating system, dependency lock, and Stryker configuration, so changing a dependency or pinned measurement setting starts a full run.

Each workflow run uses a unique cache save key and restores the newest compatible
report, avoiding immutable cache-key reuse while carrying results forward.

The nightly workflow is sharded. A cold run of the whole glob takes longer than a
GitHub job may run, and the incremental report is only written by a run that
completes, so the unsharded nightly never seeded its cache and failed every night
from 2026-10-30 (issue #303). Each shard in `.github/workflows/mutation.yml`
mutates part k of n of one `mutate` file through `stryker.shard.config.mjs`,
which changes only the `mutate` range, the incremental and report file names, and
drops the per-shard break threshold. Every scoring knob comes unchanged from
`stryker.config.mjs`. Part edges fall only between top-level statements: Stryker
emits a mutant only when its node lies wholly inside a `mutate` range, so an edge
inside a function would silently drop the mutants that cross it. Each shard keeps
its own incremental cache and records the range it owned. The `merge` job runs
`scripts/merge-mutation-reports.mjs`, which drops any result outside its shard's
range (incremental mode can carry a relocated cached result there) and refuses
(exit 2) a missing shard or range, parts that do not tile a file, a `mutate` file
with no mutants, a mutant counted twice, or a mutant reported Survived after
running zero tests. That last check exists because the first sharded run
(2026-11-19) scored 25.19%: `@stryker-mutator/vitest-runner` 10.0.0 under vitest 5
built its test-name filter with the old separator, so every filtered mutant run
skipped all tests and 3152 mutants were scored Survived without being tested.
10.1.1 fixes the separator; keep the runner at 10.1.1 or later. It writes
`reports/mutation/mutation.json` with the configured thresholds, and
`check:mutation-report` then runs on the merged report.

## Baseline policy

No measured baseline is published here without retained output from `npm run check:mutation-report`. The available archived report belongs to a different historical checkout and configuration, so it cannot validate the figures formerly quoted here or in `stryker.config.mjs`.

The removed tables and withdrawn measurements remain in Git history; they are
not a current baseline and must not be re-cited without their matching report,
configuration, source revision, host conditions, and passing checker receipt.

The configured break threshold is **74** (`stryker.thresholds.mjs`), re-baselined
from 84, which was never measured on the current five-file scope. The first complete
sharded run ([run 44746876459](https://github.com/Comfy-Org/comfy-multi-player/actions/runs/44746876459),
source fe1b3932, Stryker 10.1.1, pinned settings above, GitHub-hosted ubuntu runners)
scored below 84, and two later checked runs agree within 0.02 points (table below), so
74 sits about one point under the lowest timeouts-as-survivors floor (75.05%).
That first run's merge reported no zero-test survivors, and `check:mutation-report` on its merged report gave:

```text
mutants        5633 (5 files)
killed         4227
timeout        26   <- scored as detected by Stryker
survived       1044
no coverage    333
errors         3
score          75.54%
timeouts-as-survivors floor  75.08%
```

Against the former 84 the checker exited 1 (a real threshold failure, with the report uploaded).

Checked runs of the sharded nightly. "At 74" is `check:mutation-report` on each run's
uploaded `mutation-report` artifact with `thresholds.break` set to 74; counts and scores
are unchanged by the threshold. Run 44985418397 is the first nightly with break 74; its
in-CI checker passed.

| Run | Source | Cache | Score | Floor | Break in run | At 74 |
| --- | --- | --- | --- | --- | --- | --- |
| [44746876459](https://github.com/Comfy-Org/comfy-multi-player/actions/runs/44746876459) | fe1b3932 | cold | 75.54% | 75.08% | 84, exit 1 | exit 0 |
| [44909647729](https://github.com/Comfy-Org/comfy-multi-player/actions/runs/44909647729) | 3a56f691 | cold | 75.55% | 75.05% | 75, exit 0 | exit 0 |
| [44979246982](https://github.com/Comfy-Org/comfy-multi-player/actions/runs/44979246982) | eb4cfaf1 | restored | 75.56% | 75.06% | 84, exit 1 | exit 0 |
| [44985418397](https://github.com/Comfy-Org/comfy-multi-player/actions/runs/44985418397) | ad85fc62 | restored | 75.56% | 75.06% | 74, exit 0 | exit 0 |

Checker output at 74 for the three later runs (first run above):

```text
44909647729  mutants 5633  killed 4226  timeout 28  survived 1044  no coverage 333  errors 2
             score 75.55%  timeouts-as-survivors floor 75.05%
             mutation report PASSED (timeouts within budget, score at or above threshold)
44979246982  mutants 5633  killed 4226  timeout 28  survived 1043  no coverage 333  errors 3
             score 75.56%  timeouts-as-survivors floor 75.06%
             mutation report PASSED (timeouts within budget, score at or above threshold)
44985418397  mutants 5633  killed 4226  timeout 28  survived 1043  no coverage 333  errors 3
             score 75.56%  timeouts-as-survivors floor 75.06%
             mutation report PASSED (timeouts within budget, score at or above threshold)
```

The first run's counts above also give `PASSED` at 74 (exit 0).

Per-file scores from the first run's report (Killed + Timeout over valid mutants):

| File | Detected / valid | Score |
| --- | --- | --- |
| `src/applier.ts` | 2908 / 4003 | 72.64% |
| `src/doc.ts` | 550 / 629 | 87.44% |
| `src/mint.ts` | 335 / 441 | 75.96% |
| `src/project.ts` | 322 / 390 | 82.56% |
| `src/stamps.ts` | 138 / 167 | 82.63% |

`src/applier.ts` holds most of the survivors and no-coverage mutants, so test work
there moves the overall score most.

Keep a threshold below a freshly checked baseline rather than equal to it: zero margin turns the first uncovered line in a sibling change into a nominal score regression. Raise the threshold when the checked baseline rises. That headroom is for new code, not measurement noise.

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
| 2 | **INCONCLUSIVE**: missing, unreadable or unparseable report; fewer than 500 total mutants (including zero); zero valid mutants; more than 2% of detected mutants timed out; or no numeric `thresholds.break` value |

INCONCLUSIVE is not a pass. Re-run on a suitable host and retain the checker output; do not record the score.

Stryker writes local HTML and JSON reports plus the incremental report under `reports/`. Generated reports and `.stryker-tmp/` are ignored. `.github/workflows/mutation.yml` runs nightly and by manual dispatch, caches one incremental report per shard, and uploads each shard report plus the merged `reports/mutation/` as artifacts. Each shard's cache key covers `package-lock.json` and `stryker.config.mjs`. `stryker.shard.config.mjs` is not in the key because it sets only shard ranges and file names; if a measurement setting ever moves into it, add that file to the key.
