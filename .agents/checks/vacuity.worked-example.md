# Worked example: applying `vacuity.md` to a known-vacuous check

Fixture for [`vacuity.md`](vacuity.md). It exists because a profile that only *describes* vacuity is exactly the artifact class it warns about (V7, assertive documentation): a reviewer can write "vacuity check: PASS" without anything having gone red. So the profile carries a run of itself.

The subject is the `import-graph` check, chosen because both its vacuous and its remediated states are reachable from this tree: the vacuous version is what `.agents/checks/import-graph.md` documented before PR #52, and the remediated version is [`../../scripts/check-import-graph.mjs`](../../scripts/check-import-graph.mjs) / `npm run check:imports`.

**Provenance.** Run on `828dc82ea56cea78555c03bcf9fdbb63b79d11ef` (`fix/import-graph-check-vacuous-green`), 2026-08-20, Node v25.9.0, dependency-cruiser 17.4.3, after `npm ci`. All output below is pasted verbatim from that run; nothing is reconstructed.

**P0.** *This check goes red when a module under `src/` imports anything other than `yjs` — observed as `import-graph check FAILED: … error src-no-node-builtins: src/doc.ts → fs`, exit `1`.*

## The mutant

One line, prepended to `src/doc.ts`. A Node builtin in the op layer makes the package server-only and unrunnable at a peer — the `src-no-node-builtins` rule exists to make that fail (KA-3, FC-3).

```ts
import { readFileSync } from "node:fs";
void readFileSync;
```

## The four states

| # | State | Command | Work count | Verdict | Exit |
| --- | --- | --- | --- | --- | --- |
| 1 | clean tree | `npm run check:imports` | 9 modules / 23 deps | PASSED | `0` |
| 2 | mutant planted, remediated gate | `npm run check:imports` | 10 modules / 24 deps | FAILED `src-no-node-builtins` | `1` |
| 3 | **mutant still planted**, `includeOnly: "^src"` restored | `depcruise --config <variant> src` | **8 modules / 18 deps** | **no violations found** | **`0`** |
| 4 | clean tree, `typescript` unresolvable | `npm run check:imports` | 0 modules | INCONCLUSIVE | `2` |

### 1. Baseline — the gate is green on a clean tree

```
$ npm run check:imports
import-graph check PASSED (9 modules, 23 dependencies cruised, 0 violations)
$ echo $?
0
```

A green with a stated work count. Without the count this line is indistinguishable from state 3 and state 4.

### 2. P1, mutant probe — the remediated gate goes red for the right reason

```
$ npm run check:imports
import-graph check FAILED: 1 violation(s) over 10 modules / 24 dependencies

  error src-no-node-builtins: src/doc.ts → fs

Rules live in .dependency-cruiser.cjs; see docs/INVARIANTS.md (KA-3, FC-3).
$ echo $?
1
```

Red, named rule, named edge. This is the artifact `vacuity.md` P1 demands; a claim of compliance would not have distinguished state 2 from state 3.

### 3. The one that matters — the same mutant, a vacuous variant, still green

The only difference from state 2 is one restored option in `.dependency-cruiser.cjs`, the one PR #52 removed and left a comment about:

```js
  options: {
    doNotFollow: { path: "node_modules" },
    includeOnly: "^src",          // <- the only change
```

The variant is deliberately **not** checked in — a vacuous config sitting next to a gate that reads `.dependency-cruiser.cjs` by default is a loaded gun. Regenerate it into a scratch path:

```bash
sed 's|doNotFollow: { path: "node_modules" },|&\n    includeOnly: "^src",|' \
  .dependency-cruiser.cjs > /tmp/dc-includeonly.cjs
```

`src/doc.ts` still imports `node:fs`. The rule set is byte-identical. The result:

```
$ ./node_modules/.bin/depcruise --config /tmp/dc-includeonly.cjs src

✔ no dependency violations found (8 modules, 18 dependencies cruised)

$ echo $?
0
```

```
$ ./node_modules/.bin/depcruise --config /tmp/dc-includeonly.cjs --output-type json src \
    | jq '.summary | {totalCruised, totalDependenciesCruised, violations: (.violations|length)}'
{
  "totalCruised": 8,
  "totalDependenciesCruised": 18,
  "violations": 0
}
```

`includeOnly: "^src"` removes every module outside `src` from the graph, so `fs` is not a node the rule can match against. `src-no-node-builtins` has nothing left to fire on and can never fire, no matter what is imported.

**This is the demonstration.** Read the three properties off it:

- **P2 alone would have missed it.** 8 modules cruised clears `MIN_MODULES = 8` in `check-import-graph.mjs`. The work-unit floor is satisfied. A reviewer who checked only the work count would have reported a pass.
- **Reading the rule would have missed it.** The rule is correct as written. The defect is one option in a different file, deleting the rule's matching set.
- **Only P1 caught it.** The gate is proven non-vacuous by the planted violation going red, and the variant is proven vacuous by the *same* planted violation staying green. That contrast is unavailable to anyone who did not plant the line.

This is not a hypothetical reconstruction. It is the defect that bit the author of PR #52 mid-fix: their first repaired rule set passed a planted `node:fs` import for this exact reason, after the `.ts` resolution bug had already been fixed.

### 4. Reproducing the original failure mode — INCONCLUSIVE, not a pass

The pre-#52 profile documented `npx --yes dependency-cruiser …`, which installs the tool outside the project, where `typescript` does not resolve, so `.ts` is a disabled extension and a scan of a TypeScript-only `src/` matches zero files while exiting `0`. Simulated here by making `typescript` unresolvable from the gate:

```
$ mv node_modules/typescript /tmp/ts-hidden
$ npm run check:imports
import-graph check INCONCLUSIVE: cruised 0 modules, expected at least 8.
Nothing meaningful was analyzed, so 'no violations' proves nothing. Check that `.ts` is an enabled extension (`npx depcruise --info`); it requires typescript resolvable from dependency-cruiser's install location.
$ echo $?
2
```

The exit-code convention is what converts this from a green into a distinct outcome. Note that the *cause* is environment-dependent and can come and go silently: re-running the original `npx --yes … --include-only "^src" src` command on this machine today reports `no dependency violations found (8 modules, 16 dependencies cruised)` rather than the `0 modules` recorded in the source reports, because `npx` now resolves the project's `typescript`. The `includeOnly` defect in state 3 is deterministic and did not come and go. **Prefer the deterministic reproduction when writing a P1 row; an environment-dependent one can turn green without anyone touching the code.**

### Restore

```
$ git checkout -- src/doc.ts && mv /tmp/ts-hidden node_modules/typescript
$ npm run check:imports
import-graph check PASSED (9 modules, 23 dependencies cruised, 0 violations)
$ git status --porcelain
(empty)
```

No residual diff, as P1 requires.

## What this fixture is for

Re-run states 1 to 4 whenever `vacuity.md`, `.dependency-cruiser.cjs`, or `scripts/check-import-graph.mjs` changes. If state 2 stops going red or state 3 stops going green, the demonstration no longer demonstrates anything and this file is stale — which is the staleness signal `vacuity.md` P5 says every prose profile ought to have and most do not.

The generalizable form, for any check under review: find an input for which the check must go red, run it, paste the output. If you cannot construct one, that is the finding.
