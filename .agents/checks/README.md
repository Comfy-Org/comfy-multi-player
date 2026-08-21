# Reviewer-agent check profiles

Concern profiles a reviewer agent (or a human) applies to a change. Apply every profile relevant to the change; cite the affected `KA-*` / `FC-*` IDs from [`../../docs/INVARIANTS.md`](../../docs/INVARIANTS.md).

## Apply to every change

| Profile | Focus |
| --- | --- |
| [`vacuity.md`](vacuity.md) | can this check fail — and fail *for this property* — did it run, does the result say what is claimed from it, and does the number mean the same thing twice |

[`vacuity.md`](vacuity.md) is not a concern like the others — it is the check on the checks, and every other profile in this directory ends with a one-line pointer to it (`grep -rn "apply \[vacuity.md\]" .agents/checks/`). It applies to tests, gates, analyzer invocations, the prose in this directory, and any result cited as evidence in a PR body, ADR, or plan. [`vacuity.worked-example.md`](vacuity.worked-example.md) is its self-application: the probes run against a check that was genuinely vacuous, with the real output, plus a case where the probe goes honestly red and the guard is still unproven because the observable a reviewer records — an exit code — cannot say which of a gate's rules fired.

## Gate exit-code convention

**Every checked-in gate in this repo reports three outcomes, not two.** Stated as a rule, because it is not yet a fact: see the recorded exception below.

| Exit | Meaning | How to report it |
| --- | --- | --- |
| `0` | **PASS** — it ran, over a nonzero unit of work, and found nothing | "No issues found (`<n>` units examined)" — always with the count |
| `1` | **FAIL** — it ran and found something | the findings |
| `2` | **INCONCLUSIVE** — it could not run, or ran over nothing | "INCONCLUSIVE — `<reason>`". **Never a pass.** Fix the precondition and re-run |

A gate must therefore report its unit of work (modules cruised, files linted, packages audited, tests executed) and exit `2` when that unit falls below a floor, because an empty result is otherwise ambiguous between "clean" and "did not run" and every tool resolves that ambiguity in favour of green.

Reference implementation: [`../../scripts/check-import-graph.mjs`](../../scripts/check-import-graph.mjs), which exits `2` when it cruises fewer modules than the op layer has (`MIN_MODULES`; raise it if the layer grows, never lower it to make a run pass). `npm run check:purity` follows the same convention: `2` means no `dist/` or no `node_modules`. New gates should copy the shape.

**Recorded exception, with a sunset.** `scripts/verify-corpus.mjs` fails closed when the manifest lists zero fixtures and when a fixture is present but unlisted, and its success output reports the verified file count. It still exits only `0` or `1`: malformed input and empty-work preconditions are reported as failures (`1`), not as the convention's distinct INCONCLUSIVE outcome (`2`). Until it distinguishes those outcomes, report the failure reason rather than treating every nonzero result as evidence that the corpus contents are wrong. Writing the convention down while one gate violates part of it is exactly the assertive-documentation failure [`vacuity.md`](vacuity.md) P5 is about, so it is named here rather than glossed.

This convention is the load-bearing part of everything below it. The profiles are prose and can rot; an exit code cannot. Documentation asks a reviewer to remember, so anything that can be moved out of a profile and into a gate's exit status should be.

## Non-vacuousness rule

The rule below is the authoring-side summary; [`vacuity.md`](vacuity.md) is its operational form for a reviewer.

A profile that reports "no issues found" without having analyzed anything is worse than no profile: it manufactures false confidence and the reviewer stops looking. Two instances have already shipped here — `api-contract.md` §1 described an entrypoint re-export that issue #18 removes (so the profile coached reviewers into blessing the vulnerability), and `import-graph.md` documented a `dependency-cruiser` invocation that cruised **0 modules** and reported a clean graph.

So, for every profile that runs a command:

- **Report what was analyzed, not just what was found.** Quote the counts — modules cruised, files linted, packages audited, rules loaded. A count of zero is the finding.
- **A tool that did not run is INCONCLUSIVE, never green.** Distinguish "ran and found nothing" from "could not run", "found no files to look at", and "silently skipped every file". Only the first is "No issues found".
- **Prefer a checked-in gate over a copy-pasted command.** `npm run check:imports` and `npm run check:purity` can enforce their own floors; a shell snippet in a Markdown file cannot, and it rots without anyone noticing.
- **When a profile asserts a fact about the code** (an export exists, a file re-exports another), it is a claim that can go stale. Re-read the source before relying on it, and fix the profile in the same change.

## CRDT / op-layer profiles (this repo's core)

| Profile | Protects | Apply to |
| --- | --- | --- |
| [`purity.md`](purity.md) | KA-3, FC-3 | exports, deps, build, applier/projection/mint |
| [`convergence-idempotency.md`](convergence-idempotency.md) | KA-4 | applier, ordering, dedupe |
| [`op-identity.md`](op-identity.md) | KA-2, KA-4, FC-2, FC-7, FC-9 | mint, retry, stamps, LWW |
| [`follower-boundary.md`](follower-boundary.md) | KA-6, FC-5 | replication / write boundary |
| [`catalog-pinning.md`](catalog-pinning.md) | KA-12, FC-10 | widget catalog, mint |

## General engineering profiles (ported from ComfyUI_frontend `.agents/checks/`, adapted to this pure library)

| Profile | Focus |
| --- | --- |
| [`architecture-reviewer.md`](architecture-reviewer.md) | structure, over/under-engineering, single-implementation rule |
| [`complexity.md`](complexity.md) | cyclomatic complexity, nesting, duplication |
| [`error-handling.md`](error-handling.md) | fail-closed, no swallow, mutate-before-throw (issue #10), abort-remainder |
| [`regression-risk.md`](regression-risk.md) | git-blame bugfix-line detection |
| [`test-quality.md`](test-quality.md) | assertion strength, convergence/idempotency coverage, Vitest/`test/` conventions |
| [`import-graph.md`](import-graph.md) | circular deps, layer/purity boundaries (`npm run check:imports`, rules in [`../../.dependency-cruiser.cjs`](../../.dependency-cruiser.cjs)) |
| [`api-contract.md`](api-contract.md) | exports, op vocabulary, wire envelope, schema/catalog versioning |
| [`dep-secrets-scan.md`](dep-secrets-scan.md) | npm audit + gitleaks; yjs-only dep set |
| [`semgrep-sast.md`](semgrep-sast.md) | dangerous patterns, weak randomness on the mint path |
| [`sonarjs-lint.md`](sonarjs-lint.md) | SonarJS bug/smell rules (config: [`eslint.strict.config.js`](eslint.strict.config.js)) |

The general profiles were adapted from the frontend versions: FE-only context (Vue/Pinia, `window` globals, LiteGraph, `pnpm`, colocated tests, `useErrorHandling`) was replaced with this repo's reality — a pure `yjs`-only op-layer, `npm`, Vitest under `test/`, `OpRejectedError`/fail-closed semantics, and the `src/index.ts` + wire-envelope contract.

## Keeping restated code facts from going stale

These profiles are prose, so any code fact they restate (an exported symbol name, the wire envelope shape, an invariant ID) can drift out of sync with the code without anyone noticing — `api-contract.md` once described an export that had already been removed. Annotate each load-bearing, checkable fact with an inline claim marker:

```
<!-- claim: <exact substring> :: <repo-relative path> -->
<!-- claim-absent: <exact substring> :: <repo-relative path> -->
```

`npm run check:profile-claims` ([`../../scripts/check-profile-claims.mjs`](../../scripts/check-profile-claims.mjs)) asserts every `claim` substring is still present verbatim in its cited file, and every `claim-absent` substring is still *missing* from it. If an export is renamed or a file moves, the claim goes stale and the gate fails, forcing the prose to be corrected. The gate exits `2` (INCONCLUSIVE) if a profile set has no markers at all, so a profile that restates code facts without anchoring them is treated as an unverified pass, not a clean one. Keep the substring narrow enough to actually break when the fact changes.

**Use `claim-absent` for the two things the positive form structurally cannot say.** First, a fact whose content is an absence — `test-quality.md` argues that a projection is the wrong oracle for a rejection *because* `src/project.ts` reads neither the stamps nor the applied-ops ledger. Second, **advice that was retired for being wrong**: point a `claim-absent` at the profile itself so re-typing the retired sentence fails the gate. `test-quality.md` §2 told reviewers to compare a `project()` snapshot across a rejection, an oracle that cannot see most of the damage a rejection does. It survived a correction pass over its own file — #56 rewrote the conventions block lower down and left it standing — and four later changes (#34, #58, #60, #62) whose review notes named the defect and deferred it, because a prose profile is never in a code PR's diff. (Those notes are kept outside this repository, in the in-app-agent workspace, the same convention `test/ka4-rejection-byte-identity.test.ts` uses.) Prose alone would let it survive a fifth. Claim markers are stripped from a target's text before either test runs, which is what makes a self-targeted ban work and also stops a positive claim being satisfied by nothing but another marker.

**An absence claim is only as good as the names it enumerates, and it is a substring test, not a semantic one.** Cover every plausible *spelling* of the thing you say is absent, not just the one you happen to think of: a projection that started rendering a ledger would most likely do it by importing `stampsMap` from `doc.js`, never naming `__stamps` at all, so banning the literal alone would have left the realistic drift path unguarded. Ban the accessor names too. Expect the reverse cost as well — a ban fires on a *mention*, so a future comment in the target that merely names the banned string breaks CI with no behavioural change. That is the intended trade (loud and one reword to fix), not a bug, but it is a reason to keep bans few and load-bearing.

**Prefer needles that no reflow can split.** The gate reads raw file text. In a YAML folded scalar (`>-`), which is how [`../../.coderabbit.yaml`](../../.coderabbit.yaml) carries its `path_instructions`, a purely cosmetic rewrap inserts a newline at a space — which turns a positive claim red for no reason and, worse, makes a `claim-absent` silently stop firing. A needle containing no spaces cannot be broken that way, so use one there.

Targets are ordinary repo-relative paths, so they are not limited to `src/`. Where the same advice exists in a machine-consumed copy — `.coderabbit.yaml`'s `path_instructions`, the copy that actually runs on every PR — anchor the profile's wording to the copy in both directions (`claim` on the corrected phrasing, `claim-absent` on the retired one). Fixing one site and not the other is how the `test-quality.md` oracle survived. That file is now generated (next section), which makes the transport exact; the markers remain the check on the *content*, because a source block that was re-typed wrongly regenerates perfectly cleanly.

## The machine-consumed copy (`.coderabbit.yaml`)

`.coderabbit.yaml`'s `reviews.path_instructions` is the restatement of these profiles that CodeRabbit executes on every PR. It used to be hand-written, and it drifted: the `test/**` entry and `test-quality.md` §2 were born in one commit carrying the same wrong rejection oracle, and each of the two PRs that set out to fix it fixed only the copy it could see, because neither was greppable from the other. A substring tripwire can detect that after the fact; it cannot prevent it.

**The list is now generated.** Each entry is authored inside the profile that owns its glob, in a delimited block:

````
  <!-- coderabbit-instructions: test/** -->
  ```text
  ...the instruction the bot receives, verbatim...
  ```
  <!-- /coderabbit-instructions -->
````

(indented here only so this example is not itself collected — the generator reads markers at column 0)

`npm run gen:coderabbit` ([`../../scripts/gen-coderabbit-config.mjs`](../../scripts/gen-coderabbit-config.mjs)) splices those blocks into the sentinel-delimited region of `.coderabbit.yaml`; `npm run check:coderabbit` regenerates in memory and fails CI on any difference. The block body is whitespace-normalized to one paragraph and emitted as a YAML folded scalar, so authoring line breaks are free and the wrap is deterministic.

Four rules for authoring a block:

- **Write it for the bot, not for a human.** `path_instructions` are injected as literal text and no profile is loaded alongside them, so `"Apply .agents/checks/test-quality.md"` is a filename to CodeRabbit, not context. Every block must be self-contained.
- **Carry the carve-outs.** A restatement drifts by *omission* as readily as by contradiction, and omission is invisible to a phrase-pinning gate. The first draft of the `test/**` block dropped item 3's accepted-op exception and would have had the bot flagging seven suites that compare projections correctly. An instruction that fires on legitimate code is worse than no instruction, because it teaches people to ignore the bot.
- **Only edit the block.** Editing the generated region of `.coderabbit.yaml` directly is what `check:coderabbit` exists to catch; the fix is to move the edit into the profile and regenerate.
- **Everything outside the sentinels is hand-written and preserved.** The generator owns one region, so ordinary CodeRabbit configuration can live in the same file untouched.

Three globs have no single owning profile — the whole-`src/**` instruction, the `scripts/**` guard instruction, and the build/CI contract — so their blocks live here, in the index. They are hosted rather than owned: a block belongs in a profile whenever one profile genuinely covers its glob.

<!-- coderabbit-instructions: src/** -->
```text
Review against docs/INVARIANTS.md and every applicable profile in
.agents/checks/. Cite stable KA-* and FC-* IDs. Treat purity,
convergence/idempotency, op identity, catalog pinning, and follower boundary
violations as correctness issues. Any op-layer path that can mutate the Yjs
doc and then throw (leaving a partial mutation and a skipped op_id record)
is a blocking KA-4 issue (see issue #10); require validate-before-mutate.
Any second op-to-document implementation is a blocking FC-3 issue.
```
<!-- /coderabbit-instructions -->

<!-- coderabbit-instructions: scripts/** -->
```text
These scripts are the machine-enforced guards for the invariants
(check-purity, verify-corpus). Changes that weaken a guard (turning a
positive assertion into a denylist, skipping the corpus SHA check, or making
a gate non-fatal) are correctness issues. Keep the purity gate a positive
yjs-only assertion, not merely a denylist (issue #22).
```
<!-- /coderabbit-instructions -->

<!-- coderabbit-instructions: {package.json,package-lock.json,tsconfig.json,.github/**,stryker.conf.*} -->
```text
Guard the build and CI contract. The production dependency set must stay
yjs-only (KA-3/FC-3) — flag any new runtime dependency. Cite the frozen
vocabulary/catalog by SHA, never a moving branch (FC-10). Do not remove or
make non-fatal the build, purity, corpus-verify, or test CI steps.
```
<!-- /coderabbit-instructions -->

**What generation does not fix.** It removes the second *editable* copy, not the second *statement*: the block and the profile prose around it can still say different things, and the gate cannot read either. What changed is that they are now adjacent in one file rather than in two files in two formats, so the edit that fixes one is made by someone looking at the other. The content check remains the claim markers.
