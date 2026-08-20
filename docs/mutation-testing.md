# Mutation testing

Stryker measures whether the test suite detects behavioral regressions in the load-bearing CRDT code. The initial scope is deliberately limited to `src/applier.ts`, `src/stamps.ts`, and `src/project.ts`; tests and the rest of `src/` are not mutated.

## The score only means something because the run is pinned

Stryker classifies each mutant `Killed`, `Survived`, `Timeout`, `NoCoverage` or an error, and **scores a `Timeout` as detected**. That is right for a mutant that genuinely cannot terminate (`while (…)` mutated to `while (true)`) and wrong for a mutant that merely ran slowly because the machine was busy — and the report cannot tell those apart on its own. With `timeoutMS` and `concurrency` left at their defaults, the score is therefore a function of host load, and it moves in the flattering direction: **more contention, more timeouts, higher score.** Three runs of one commit on one machine once produced 84.38%, 88.01% and 74.59% (`reports/audit/mutation-survivors.md` §2).

`stryker.config.mjs` pins `timeoutMS`, `timeoutFactor`, `concurrency` and `coverageAnalysis` for exactly this reason. **Do not unpin them.** A score produced with different values is not comparable to any score recorded here.

## Current baseline

Measured 2026-08-20 on the pinned settings: **80.53% overall** (`applier.ts` 77.90%, `stamps.ts` 92.63%, `project.ts` 83.83%), reproduced on three runs at host load averages 3.6, 10.6 and 45.2 — identical to two decimal places each time. The break threshold is **80%**, just under the measured score; that narrow a margin is only defensible because the number no longer moves. Raise the threshold whenever the score is raised.

The earlier figures **63.70%** (recorded here) and **74.81%** (recorded in the workspace) were produced with the knobs unpinned and are void — not low, not high, just not measurements of the test suite.

## Running it

```sh
npm ci
npm run build
npm run test:mutation
npm run check:mutation-report
```

Node 22 or newer.

`check:mutation-report` is the fail-closed half of the fix. It re-derives the score from `reports/mutation/mutation.json`, prints `Timeout` as its own outcome next to the "timeouts-as-survivors floor" the score cannot fall below, and exits:

| Exit | Meaning |
| --- | --- |
| 0 | conclusive, at or above the break threshold |
| 1 | conclusive, below the break threshold |
| 2 | **INCONCLUSIVE** — no report, fewer than 500 mutants, or more than 2% of detected mutants were timeouts |

INCONCLUSIVE is not a pass. Re-run on a quieter machine; do not record the score.

Stryker writes local HTML and JSON reports under `reports/mutation/`; generated reports and `.stryker-tmp/` are ignored by git. `.github/workflows/mutation.yml` runs nightly and by manual `workflow_dispatch`, not on every pull request; it uploads `reports/mutation/` as a build artifact so a failing run leaves something to read.
