# SonarJS static analysis

Run `eslint-plugin-sonarjs` on changed files for SonarQube-grade bug and code-smell detection without a server.

## Steps

1. Probe: `npx --yes eslint --version`. If unavailable, skip and report: "Skipped: eslint not available."
2. Identify changed `.ts`/`.js` files from the diff.
3. Use the colocated strict config `.agents/checks/eslint.strict.config.js`. If it is missing or fails to load, skip and report: "Skipped: `.agents/checks/eslint.strict.config.js` missing; SonarJS rules require explicit config."
4. Run:
   ```bash
   npx --yes --package eslint --package eslint-plugin-sonarjs eslint \
     --no-config-lookup --config .agents/checks/eslint.strict.config.js \
     --format json <changed_files> 2>/dev/null || true
   ```
5. Parse the JSON. Map eslint `severity 2`→major, `severity 1`→minor. Categorize `sonarjs/no-*`→logic, `*cognitive-complexity*`→dx, others→style.
6. Report rule ID, `path:line`, message, and a fix suggestion.

## What it catches

- Bugs: duplicated/identical branches, element overwrite, identical conditions/expressions, one-iteration loops, empty return values, collection-size mischecks.
- Smells: cognitive complexity (threshold 15), duplicate strings (threshold 3), redundant booleans, small switches, invertible boolean checks.

## Repo-specific emphasis

- The applier and stamp comparator are the highest-value targets: a `no-identical-conditions`, `no-identical-expressions`, or `no-element-overwrite` hit there can indicate a real ordering/LWW or autogrow bug, not merely a smell. Escalate such findings and cross-check the affected KA-*/FC-* invariant.

## Error handling

- Skip un-parseable files and continue. If the plugin fails to install, skip and report. If no output, report "No issues found."
