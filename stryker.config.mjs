/**
 * Stryker configuration.
 *
 * `timeoutMS`, `timeoutFactor`, `concurrency` and `coverageAnalysis` are PINNED
 * DELIBERATELY. Stryker scores a `Timeout` outcome as *killed*, so with those
 * knobs left at their defaults the mutation score is a function of host load
 * rather than of the test suite — and it moves in the flattering direction: the
 * busier the machine, the more mutants time out, the HIGHER the score. Three
 * runs of the same commit on the same machine produced 84.38% / 88.01% /
 * 74.59% (reports/audit/mutation-survivors.md §2). Do not unpin these without
 * re-measuring; any score produced with different values is not comparable.
 *
 * `coverageAnalysis: "all"` rather than `"perTest"`: `perTest` under-selects in
 * the opposite direction, reporting mutants as Survived that the full suite
 * kills. `"all"` runs every test against every mutant, which is slower and
 * correct.
 *
 * @type {import('@stryker-mutator/api/core').PartialStrykerOptions}
 */
export default {
  testRunner: "vitest",
  mutate: ["src/applier.ts", "src/stamps.ts", "src/project.ts"],
  reporters: ["clear-text", "html", "json"],
  coverageAnalysis: "all",
  // Per-mutant budget = netTime * timeoutFactor + timeoutMS. Generous on
  // purpose: only a genuinely non-terminating mutant should ever time out.
  timeoutMS: 60000,
  timeoutFactor: 1.5,
  // Fixed worker count so the measurement does not vary with core count.
  concurrency: 4,
  // Measured 2026-08-20 on the pinned settings above: 80.53% overall, on three
  // runs at host load averages 3.6 / 10.6 / 45.2 — identical to two decimals
  // every time. The same tree on the previous unpinned settings scored 80.64%
  // idle and 82.84% under deliberate CPU contention. Threshold sits just under
  // the measured score, which is only defensible because the score no longer
  // moves; raise it whenever the score is raised.
  thresholds: {
    break: 80,
    low: 80,
    high: 90,
  },
};
