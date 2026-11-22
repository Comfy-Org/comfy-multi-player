/**
 * Mutation score gate, imported by stryker.config.mjs and copied into the
 * merged report by scripts/merge-mutation-reports.mjs.
 *
 * Kept OUT of stryker.config.mjs on purpose: the nightly workflow keys each
 * shard's incremental cache on the lockfile and stryker.config.mjs, so that a
 * change to a measurement knob starts clean. Thresholds do not change how any
 * mutant is measured, so moving them must not force a cold run of every shard.
 *
 * Threshold must sit strictly under a checker-validated score, not at it. A
 * threshold equal to the measurement passes with zero margin and turns red on
 * the first uncovered line any sibling PR adds, a failure that would say
 * "mutation score regression" while meaning "new code arrived". Raise it
 * whenever the score is raised; the margin is for new code, NOT for
 * measurement noise. Pinning alone does not prove noise is zero.
 */
export default {
  // Re-baselined from 84 (never measured on the current five files). Three
  // checked runs on the sharded nightly scored 75.54-75.56%, timeouts-as-
  // survivors floor 75.05-75.08%; 74 leaves about one point for new code.
  break: 74,
  low: 74,
  high: 90,
};
