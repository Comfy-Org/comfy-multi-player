# Vacuity review

A check that cannot fail for the reason it claims to guard is worse than no check: it manufactures confidence and suppresses the instinct to look. Most vacuity is not a broken tool. It is a truthful narrow result read as a much wider claim, or a check that never ran.

Applies to **every** check a change adds, modifies, quotes, or relies on: tests, CI gates, lint and analyzer invocations, the prose profiles in this directory, and any result cited as evidence in a PR body, ADR, or plan. Cite the affected `KA-*` / `FC-*` IDs from [`../../docs/INVARIANTS.md`](../../docs/INVARIANTS.md).

Three questions, in order, cheapest first: **can it fail**, **did it run**, **does it say that**.

| Band | Question | Sub-types | Probes |
| --- | --- | --- | --- |
| A — the check is wrong | Can it fail? | V1 unreachable input, V2 empty universe, V3 self-referential oracle, V4 divergent double | P1, P2, P3, P4 |
| B — the check never executed | Did it run? | V5 silent skip, V6 inert check | P7 |
| C — the result was over-read | Does it say that? | V7 assertive documentation, V8 laundered evidence | P5, P8 |

## The ambiguity rule (design, not review)

Any check whose empty result is ambiguous between "clean" and "did not run" must report its unit of work and fail closed when that unit is zero. Three outcomes, not two:

- **`0` PASS** — it ran, over a nonzero unit of work, and found nothing
- **`1` FAIL** — it ran and found something
- **`2` INCONCLUSIVE** — it could not run, or ran over nothing. **Not a pass.** Never report it as one.

Reference implementation: [`../../scripts/check-import-graph.mjs`](../../scripts/check-import-graph.mjs) exits `2` when it cruises fewer modules than the op layer has. `npm run check:purity` follows the same convention. This is the only part of this profile that cannot rot: documentation asks a reviewer to remember, an exit code does not. See [`README.md`](README.md#gate-exit-code-convention) for the repo-wide convention.

## P0 (mandatory, every change) — state the failure

For each check the change adds or leans on, write one sentence in the PR body:

> this check goes red when `<concrete input or repo state>`, observed as `<test name / exit code / error message>`

The first blank must be a concrete input or repo state; the second must be an observable. If either blank cannot be filled, the check has no defined failure mode and everything below is moot. Report it as a finding. Cost: 30 seconds.

## P1 — mutant probe (tests, guards, and rules in a gate)

Revert the guarded behavior (**one mutant per source change or per rule, not one per PR** — a PR with six source changes and one red test has five unproven guards), run only the affected check, record `mutant -> failing check`, restore, confirm no residual diff.

**Paste the actual failure output** — test name and error text, or the gate's stderr and exit code. A P1 claim with no pasted red output is treated as NOT RUN, and the guard is reported as unproven, not as passing.

```bash
# comment out the guard line, then:
npx vitest run test/<file>.test.ts
git checkout -- src/<file>.ts
```

For a gate, plant one violation per rule and include a row that reproduces the original failure mode the gate was written to catch.

For V1 specifically, the mutant must be run against the **general** input, not the pinned one. If reverting the fix leaves the test green, the input never reached the guard. That is the `removed_links: []` signature: the parameter the bug is about sitting at its empty or identity value.

Precedents in this repo: PR #31 tabulated six individual mutants against six distinct failures; PR #29 re-appended `export * from "./doc.js"` to `src/index.ts` to prove `test/public-api.regression.test.ts` was non-vacuous; PR #52 planted one violation per import-graph rule **and discovered that its own first rule set passed a planted `node:fs` import**, because `--include-only` had already removed `fs` from the graph. That last one is why this profile demands pasted output instead of a claim of compliance — see [`vacuity.worked-example.md`](vacuity.worked-example.md), which re-runs it.

If no mutant can turn the check red, the check is vacuous. **Blocking.**

## P2 — nonzero work unit (gates, analyzers)

Never accept "0 violations" without the count of things examined.

```bash
npm run check:imports                  # exits 2 below the module floor
npx depcruise --info                   # `x .ts` means the extension is DISABLED
```

- A tool that prints `0 modules cruised` / `0 files scanned` / an empty `.paths.scanned` and exits `0` is INCONCLUSIVE, not a pass. **Blocking** if reported as a pass.
- The sharpest form of this tell is that **the number was already in the output**: `no dependency violations found (0 modules, 0 dependencies cruised)` says both things on one line, and this repo read it as success for as long as the profile existed.
- Precondition sweep, since every instance found here was precondition-shaped: `node_modules` present; transpiler resolvable from the tool's install location; rule fetch completed; clone not shallow; no filter flag removing the modules the rule matches on (`--include-only` deletes them from the graph, `--do-not-follow` keeps them as edges).
- Prefer a checked-in gate with a work-unit floor over a copy-pasted command. A gate enforces its own floor; a Markdown snippet rots unnoticed.
- Any documented invocation in this directory must record the work count it produced on this repo, with the date, so the next reader can diff it.
- **A passing work count is not a passing P1.** A floor proves the tool looked at something, not that the rule can fire over what it looked at. In the worked example the vacuous variant cruises 8 modules, clears the floor, and still cannot see the planted violation.

## P3 — oracle independence (fixtures, corpora, baselines)

The expected value, and the set of items expectations are asserted over, must not be produced by running the code under test. A regression must fail the check, not silently shrink the assertion set.

- `grep -n '<sutSymbol>' <testfile>`: any hit inside expectation *construction* (as opposed to exercise) is a self-referential oracle. **Blocking.**
- Reject a data-dependent assertion set (`it.each(computedSet)`) and a bare `catch {}` in expectation setup.
- An aggregate floor or percentage is not an oracle. It is a budget for undetected regressions, and its size is the number of regressions you have agreed not to see. Prefer a checked-in named known-failing allowlist where both a new divergence and a stale entry fail by name, and where a wildcard entry requires a structural marker so an unrelated regression cannot hide behind it.
- In this repo the conformance corpus (`npm run verify:corpus`) is the highest-risk host: fixtures regenerated by the applier under test would assert only that the applier agrees with itself.

## P4 — double parity (fakes, stubs, injected seams)

For the exact property asserted, the double must behave like the real collaborator.

- Read the property's implementation in the real type and in the double side by side. A plain field standing in for an accessor with side effects, or a test-supplied closure standing in for a singleton write, means the assertion is about the double. **Blocking** when the property is the point of the test.
- Decisive question: **would this test still pass if the production mechanism were deleted?** If yes, the test is about the double.
- Prefer one shared parametrized suite run against both the double and the real collaborator, or one integration test that drives the real object once. Ten unit tests against fakes do not add up to it.

## P5 — documentation fact-check (this directory, ADRs, `INVARIANTS.md`)

Prose here is executed by reviewer agents. A false code fact does not merely fail to catch a defect, it argues for one.

- For each factual claim, `grep -n` the named symbol at the named path. A contradiction is **blocking**, not a doc nit.
- Prefer **rules** ("do not export handles that permit unstamped writes") over **contracts** ("`index.ts` re-exports `doc`"). Rules survive a refactor; contracts age. Where a contract must be stated, carry `file:line` and the SHA it was true at.
- A PR removing or renaming a symbol named in this directory, an ADR, or `docs/INVARIANTS.md` must update that prose in the same commit. Grep `.agents/` and `docs/` for every removed or renamed symbol in the diff.
- Known live example: `api-contract.md` §1 described `src/index.ts` as re-exporting `doc` after PR #29 removed it, which would have coached reviewers to flag the fix and bless re-adding the vulnerability. An assertive profile does not fail to detect the defect; it **inverts** and recommends it.

## P6 — green on empty

Any check whose "nothing to do" branch is a skip, a pass, or an early return is a latent vacuous green. Make the empty case an error.

`else it.skip('no fixtures currently pass')` is the exact line that lets total failure and total success differ only in the count of green test names, and `PASSED (0 files)` from a corpus verifier over an empty manifest is the same line waiting to happen.

## P7 — did it run, and has it ever run

Two different questions. Ask both.

```bash
npx vitest run --reporter=verbose                        # passed / skipped / todo
grep -rn "it.skip\|describe.skip\|it.todo\|skipIf" test/ # local skip gates
git grep <THE_SKIP_GATE_ENV_VAR> origin/main -- .github/ # no hit = it has never run
```

- An executed count of zero is an abstention, not a pass. Any evidence line citing a run must carry the executed count, or the preconditions that make the run meaningful. `# all ok` is not evidence.
- For every environment-gated skip, name the environment that guarantees it does not fire, then open that CI file and confirm the job is not path-filtered or matrix-gated away from the changes it protects.
- **Blocking** when a committed check has never executed in CI, or when the only run that exercises a guard cannot be triggered by a change to what the guard covers. Let a local checkout skip; make the authoritative environment fail closed.

## P8 — open the citation

Before repeating a claim, open the artifact it cites and read the text next to the number.

- Look for the source's own scope disclaimer: "does not", "not exercised", "out of scope", "analogy", "simulated", "in isolation". If the source qualifies its result, the qualification travels with it.
- **One-hop rule:** cite the artifact, never a document that cites the artifact. Chains launder, and each re-citation strips context while confidence rises.
- Reserve **"proven"** for a property with an executable check that can go red. Otherwise write "observed", "demonstrated in isolation", or "argued by analogy".
- Re-derive `file:line` citations against current `origin/main` before escalating. A report can be right on mechanism and unusable on currency.
- **Blocking** when a status table marks a row proven on evidence that excludes the thing the row names.
- The reviewer's version, which costs the least and is skipped the most: any confident claim whose cited evidence you have not personally opened is unverified. Say so rather than inheriting it.

## Reporting

State the probes you ran and the artifacts they produced, not that you ran them:

- P1 — the pasted red output, per mutant
- P2 — the pasted work count, per tool
- P7 — the pasted executed/skipped counts, per suite

A line reading "vacuity check: PASS" with no such artifact is itself the failure mode this profile exists to catch (V7), and is reported as NOT RUN.

## Severity

- **Blocking** — no mutant can turn the check red; an oracle computed from the code under test; a gate whose work count is zero reported as a pass; a prose profile in this directory asserting a false code fact; a double that diverges on the asserted property; a committed check that has never run in CI; a guard whose real run is unreachable from the changes it covers; a "proven" row whose cited evidence excludes the property.
- **Major** — P0 unanswered for a new guard; an aggregate floor where per-item expectations are possible; a green-on-empty branch; an aggregate verdict quoted with no counts; an INCONCLUSIVE exit code the profile does not document.
- **Minor** — a documented invocation with no recorded work count; a fake with no contract test but no divergence on the asserted property; a two-hop citation whose source does check out.

## This profile applied to itself

A vacuousness check can itself be vacuous — that is not a rhetorical caveat, it happened to the author of PR #52 within an hour of starting the fix. So this profile carries its own P1: [`vacuity.worked-example.md`](vacuity.worked-example.md) runs the probes against a known-vacuous check and against its remediation, with real pasted output, and shows the vacuous variant passing a planted violation while clearing its work-unit floor. If the probes here ever stop catching that, the demonstration goes green and the profile is stale.
