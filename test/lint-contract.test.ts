import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

describe("lint enforcement contract", () => {
  it("reports a configured finding as an error and exits unsuccessfully", () => {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(manifest.scripts.lint).toBe("eslint .");
    const run = spawnSync(process.execPath, [
      join(root, "node_modules/eslint/bin/eslint.js"),
      ".",
      "--stdin", "--stdin-filename", "src/lint-contract-probe.ts", "--format", "json",
    ], {
      cwd: root,
      encoding: "utf8",
      input: "export const digit = /[0-9]/;\n",
    });
    expect(run.error).toBeUndefined();
    expect(run.stderr).toBe("");
    const results = JSON.parse(run.stdout) as {
      messages: { ruleId: string; severity: number }[];
    }[];
    expect(results).toHaveLength(1);
    expect(results[0]!.messages).toContainEqual(expect.objectContaining({
      ruleId: "sonarjs/concise-regex",
      severity: 2,
    }));
    expect(run.status).toBe(1);
  });

  it.each([
    ["src/lint-contract-probe.ts", ["Buffer", "process", "window"]],
    ["test/lint-contract-probe.test.ts", ["window"]],
  ])("recognizes only the runtime globals available to %s", (filename, missing) => {
    const run = spawnSync(process.execPath, [
      join(root, "node_modules/eslint/bin/eslint.js"),
      "--stdin", "--stdin-filename", filename as string, "--format", "json",
    ], {
      cwd: root,
      encoding: "utf8",
      input: "export const probe = [TextEncoder, structuredClone, Buffer, process, window];\n",
    });
    expect(run.error).toBeUndefined();
    expect(run.stderr).toBe("");
    const results = JSON.parse(run.stdout) as {
      messages: { ruleId: string; message: string }[];
    }[];
    expect(results).toHaveLength(1);
    const references = results[0]!.messages.filter(
      message => message.ruleId === "sonarjs/no-reference-error",
    );
    expect(references.map(message => message.message.split('"')[1])).toEqual(missing);
    expect(run.status).toBe(1);
  });

  it("preserves rule options while promoting an upstream warning to an error", () => {
    // The installed recommendation currently has scalar settings only. Inject
    // an option-bearing setting before importing the real config so dropping
    // array tails cannot pass unnoticed when the recommendation gains options.
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import sonarjs from "eslint-plugin-sonarjs";
      sonarjs.configs.recommended.rules["sonarjs/cognitive-complexity"] = ["warn", 3];
      const { default: configs } = await import("./eslint.config.mjs");
      const config = configs.find(config => config.rules);
      process.stdout.write(JSON.stringify(config.rules["sonarjs/cognitive-complexity"]));
    `], { cwd: root, encoding: "utf8" });
    expect(run.error).toBeUndefined();
    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(JSON.parse(run.stdout)).toEqual(["error", 3]);
  });
});
