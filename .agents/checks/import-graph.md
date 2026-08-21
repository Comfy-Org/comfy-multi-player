# Import-graph review

Validate import boundaries and detect circular dependencies. This reinforces purity (KA-3, FC-3) at the module-graph level and complements `scripts/check-purity.mjs`, which reasons about the installed dependency tree and a bare-Node import of `dist/` and therefore cannot see which source module reached for what.

## Steps

1. `npm ci` (dependency-cruiser is a devDependency; its rules live in `.dependency-cruiser.cjs`).
2. Run the gate:
   ```bash
   npm run check:imports
   ```
3. Read the exit code. **`0` is the only green.**
   - `0` — clean. The line reports how many modules and dependencies were cruised; a run that analyzed nothing cannot reach this code.
   - `1` — rule violations, listed with rule name and the offending edge or cycle.
   - `2` — INCONCLUSIVE. Either dependency-cruiser is missing or the run cruised fewer modules than the floor. Report this as unresolved, never as "no issues found".
4. Map violations to findings: `no-circular` → major, category architecture; other `error` rules → major; `warn` → minor; `info` → nitpick.
5. For anything the rules cannot express, read the diff against the repo-specific rules below and report by hand.

## Do not run it the old way

The previous version of this profile documented `npx --yes dependency-cruiser --no-config --output-type json --do-not-follow "node_modules" --include-only "^src" src`. In this repo that invocation printed `✔ no dependency violations found (0 modules, 0 dependencies cruised)` and exited `0` — a **vacuous green**: a reviewer agent reported "no issues found" having analyzed nothing. Two independent causes, both worth remembering because either alone is enough to hollow out a check:

- **`npx --yes` installs dependency-cruiser outside the project.** It enables a language extension only when that transpiler resolves from its own install location, so `typescript` was not found, `.ts` was a DISABLED extension (`npx depcruise --info` shows this), and a directory scan of a 100%-TypeScript `src/` matched zero files. Naming a file explicitly (`… src/index.ts`) still worked, which is why the flaw survived review.
- **`--include-only "^src"` deletes every external module from the graph.** With it, `node_modules/**` and Node builtins are not in the graph at all, so a purity rule of the form "from `src` to a non-`yjs` package" has nothing to match and can never fire — even with `.ts` working. Use `doNotFollow` instead: external modules stay as edges, their own dependencies simply are not traversed.

If you must invoke the tool directly, use the project-local binary (`npx depcruise --output-type json src`) so it resolves this project's `typescript`, and check `summary.totalCruised` before believing `summary.violations`.

## Repo-specific rules

Encoded in `.dependency-cruiser.cjs` and enforced by the gate:

- `no-circular` — circular imports among the pure modules are a design smell that makes the package harder to tree-shake and reason about; extract the shared type or helper.
- `src-runtime-dep-is-yjs-only` — `src/**` may import no npm package other than `yjs`. This is the positive yjs-only assertion at the module-graph level; the purity gate's denylist is the negative one (issue #22).
- `src-no-node-builtins` — a Node builtin in the op layer makes it server-only and unrunnable in a browser or at a peer (FC-3).
- `no-unresolvable` — an unresolvable import is a typo or a module that exists in only one of the two runtimes.

Still review by hand, because no rule covers them:

- A DOM, framework, or LiteGraph global used without an import (`document`, `window`, `LGraphNode`) is a blocking FC-3 finding.
- Test-only imports (`test/**` reaching into `src`) are expected; do not flag them. The gate scopes itself to `src` by argument, so they do not appear.

## Error handling

- If `npm run check:imports` exits `2`, report: "Import-graph check INCONCLUSIVE — <reason>". Do not substitute a hand-rolled `npx --yes` invocation to get a green.
- If more than 20 violations, the gate prints the first 20 and the total; report the same.
- If the gate exits `0`, report "No issues found (<n> modules, <m> dependencies cruised)" — always quote the counts, so a future vacuous run is visible in the review itself.
- The module floor bounds vacuity, not rule adequacy. A run can clear it and still be blind: with `includeOnly: "^src"` restored, a planted `node:fs` import in `src/doc.ts` cruises 8 modules / 18 dependencies and exits `0`, because the filter removed the external modules the purity rules target. If you change `.dependency-cruiser.cjs`, re-prove each rule by planting one violation **per rule** and confirming that rule is the one named in the output — `mutant -> the named rule`, never `mutant -> red`.
