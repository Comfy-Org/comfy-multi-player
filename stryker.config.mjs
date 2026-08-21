/**
 * Stryker configuration.
 *
 * `timeoutMS`, `timeoutFactor`, `concurrency` and `coverageAnalysis` are PINNED
 * DELIBERATELY. Stryker scores a `Timeout` outcome as *killed*, so with those
 * knobs left at their defaults the mutation score is a function of host load
 * rather than of the test suite — and it moves in the flattering direction: the
 * busier the machine, the more mutants time out, the HIGHER the score.
 * Measured on this tree, unpinned: 80.00% idle and 81.41% under 20 CPU
 * spinners, because 13 real survivors were reclassified as timeouts and scored
 * as kills. Do not unpin these without re-measuring; any score produced with
 * different values is not comparable.
 *
 * `coverageAnalysis: "all"` rather than `"perTest"`: `"all"` runs every test
 * against every mutant, so the outcome cannot depend on Stryker's per-test
 * coverage attribution. On this tree the two agree on an idle host (identical
 * 154-survivor set), and `"all"` costs about 2.4x the wall time; it is pinned
 * because it removes a variable, not because `perTest` was observed to
 * mis-classify here.
 *
 * @type {import('@stryker-mutator/api/core').PartialStrykerOptions}
 */
export default {
  testRunner: "vitest",
  // `src/doc.ts` and `src/mint.ts` joined the glob in MUT-GLOB-KA4-1. They had
  // never been mutation-tested, and they carry the schema §1 doc layout, the
  // §1.2 opaque-widgets routing, the §5.3 shared-definition instance count and
  // the §9 bootstrap-snapshot path — see reports/audit/mut-glob-ka4.md.
  // `src/index.ts` (re-exports only), `src/types.ts` (declarations) and
  // `src/migrate.ts` (owned by PR #30) remain out.
  mutate: ["src/applier.ts", "src/stamps.ts", "src/project.ts", "src/doc.ts", "src/mint.ts"],
  reporters: ["clear-text", "html", "json"],
  coverageAnalysis: "all",
  // Per-mutant budget = netTime * timeoutFactor + timeoutMS. Generous on
  // purpose: only a genuinely non-terminating mutant should ever time out.
  timeoutMS: 60000,
  timeoutFactor: 1.5,
  // Fixed worker count so the measurement does not vary with core count.
  concurrency: 4,
  // Measured RE-DERIVE-DATE on the pinned settings above, over the five-file
  // glob: RE-DERIVE% overall (RE-DERIVE mutants). The three-file glob this
  // replaces scored 80.00% over 925 mutants (reproduced idle and under 20 CPU
  // spinners, element-for-element identical Survived/NoCoverage sets — that
  // stability is the whole point of the pins).
  //
  // Threshold sits strictly UNDER the measured score, not at it — the rule #56
  // wrote in when it lowered the three-file threshold from 80 to 79. A
  // threshold equal to the measurement passes with zero margin and turns red on
  // the first uncovered line any sibling PR adds, a failure that would say
  // "mutation score regression" while meaning "new code arrived". Raise it
  // whenever the score is raised; the margin is for new code, NOT for
  // measurement noise, which is now zero.
  thresholds: {
    break: 84,
    low: 84,
    high: 95,
  },
};
