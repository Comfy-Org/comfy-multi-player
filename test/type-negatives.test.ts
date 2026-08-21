/**
 * Runs the issue #17 negative type tests as a real gate.
 *
 * `test/` is outside `tsconfig.json`'s `include`, so `npm run build` cannot see
 * anything in it (noted as finding 2 of the #21 report). A type-level
 * constraint that nothing type-checks is a constraint that quietly rots, so
 * `test/types/invalid-states.negative.ts` gets its own `tsc` invocation here.
 *
 * That file is built entirely out of `@ts-expect-error` directives plus
 * positive controls, so `tsc` exiting 0 means BOTH that every invalid state is
 * still rejected (a directive with no error underneath it is itself an error,
 * TS2578) and that valid ops still compile. There is no way for it to pass
 * vacuously.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
const project = join(root, "test", "types", "tsconfig.json");

describe("invalid op states are unrepresentable (issue #17)", () => {
  it("compiles test/types/invalid-states.negative.ts with zero diagnostics", () => {
    expect(existsSync(tsc), "typescript devDependency missing — run `npm ci`").toBe(true);

    const run = spawnSync(process.execPath, [tsc, "-p", project], {
      cwd: root,
      encoding: "utf8",
    });

    // tsc prints diagnostics on stdout. A TS2578 ("Unused '@ts-expect-error'
    // directive") means an invalid state became constructible again; anything
    // else means a positive control stopped compiling.
    expect(`${run.stdout}${run.stderr}`.trim()).toBe("");
    expect(run.status).toBe(0);
  }, 60_000);
});
