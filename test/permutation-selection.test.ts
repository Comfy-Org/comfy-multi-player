import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const suite = "test/permutation/full-op-pool.permutation.test.ts";
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

describe("permutation scheduling contract", () => {
  it.each([
    ["test", "representative"],
    ["test:exhaustive", "exhaustive"],
  ])("%s selects both %s cases, and only those cases", (script, tier) => {
    const command = manifest.scripts[script];
    expect(command).toEqual(expect.stringMatching(/^vitest run(?: |$)/));
    // Ask the installed Vitest to collect using the actual script's flags and
    // config. A string-only check misses an intersected/unsupported tag filter.
    const args = command.split(" ").slice(2);
    if (script === "test") args.push(suite);
    const result = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "list", ...args, "--json"], {
      cwd: root, encoding: "utf8", timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    const tests = JSON.parse(result.stdout) as Array<{ name: string }>;
    expect(tests.map(({ name }) => name)).toEqual([
      `full op-pool permutation equivalence ('${tier}') > covers every declared op-kind pair across representative state, stamp, actor, order, and batch dimensions`,
      `full op-pool permutation equivalence ('${tier}') > samples reproducible length-3-to-6 full-vocabulary streams with shrinking enabled`,
    ]);
  });

  it("runs exhaustive coverage in an unconditional, failure-propagating CI job", () => {
    const workflow = parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
    expect(workflow.on).toHaveProperty("pull_request");
    expect(workflow.on.push.branches).toContain("main");
    const job = workflow.jobs["permutation-exhaustive"];
    expect(job).toBeDefined();
    expect(job.if).toBeUndefined();
    expect(job.needs).toBeUndefined();
    expect(job["continue-on-error"]).toBeUndefined();
    // As in ci-release-contract.test.ts, shell overrides could echo a script
    // instead of executing it even when its run field names the right command.
    expect(workflow.defaults?.run?.shell).toBeUndefined();
    expect(job.defaults?.run?.shell).toBeUndefined();
    const steps = job.steps as Array<Record<string, unknown>>;
    const commands = steps.filter((step) => step.run !== undefined);
    expect(commands.map((step) => step.run)).toEqual(["npm ci", "npm run test:exhaustive"]);
    for (const step of commands) {
      expect(step.if).toBeUndefined();
      expect(step.shell).toBeUndefined();
      expect(step["continue-on-error"]).toBeUndefined();
    }
  });
});
