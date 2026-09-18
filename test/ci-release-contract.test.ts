import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const VERIFY_COMMAND = "npm run verify:package";

interface Step {
  name?: string;
  run?: string;
  if?: unknown;
  "continue-on-error"?: unknown;
}

function activeSteps(document: unknown): Step[] {
  const jobs = (document as { jobs?: Record<string, { steps?: Step[] }> })?.jobs;
  return Object.values(jobs ?? {}).flatMap((job) => job.steps ?? []).filter((step) =>
    step.if !== false && step.if !== "false" && step["continue-on-error"] !== true,
  );
}

function requireFailurePropagatingStep(document: unknown, name: string, command: string): void {
  const steps = activeSteps(document);
  const match = steps.find((step) => step.name === name && step.run?.trim() === command);
  if (!match) throw new Error(`missing active, failure-propagating ${name}: ${command}`);
  const buildIndex = steps.findIndex((step) => step.name === "Build");
  const matchIndex = steps.indexOf(match);
  if (buildIndex === -1 || matchIndex <= buildIndex) throw new Error(`${name} must run after Build`);
}

const loadYaml = (relative: string) => parse(readFileSync(join(root, relative), "utf8")) as unknown;

describe("parsed CI and release contracts", () => {
  it.each([".github/workflows/ci.yml", ".github/workflows/release.yml"])(
    "%s runs the shared package verifier after build and propagates failure",
    (path) => requireFailurePropagatingStep(loadYaml(path), "Verify package contents", VERIFY_COMMAND),
  );

  it("CodeRabbit protects the workflow verifier by structured rule fields", () => {
    const config = loadYaml(".coderabbit.yaml") as {
      reviews?: { path_instructions?: Array<{ path?: string; instructions?: string }> };
    };
    const rule = config.reviews?.path_instructions?.find(({ path }) => path?.includes(".github/**"));
    expect(rule?.path).toBe("{package.json,package-lock.json,tsconfig.json,.github/**,stryker.conf.*}");
    expect(rule?.instructions).toContain("`Verify package contents`");
    expect(rule?.instructions).toContain("make non-fatal");
  });

  it.each([
    ["commented command", `jobs:\n  ci:\n    steps:\n      - name: Build\n        run: npm run build\n      # - name: Verify package contents\n      #   run: ${VERIFY_COMMAND}\n`],
    ["inactive step", `jobs:\n  ci:\n    steps:\n      - name: Build\n        run: npm run build\n      - name: Verify package contents\n        if: false\n        run: ${VERIFY_COMMAND}\n`],
    ["non-propagating step", `jobs:\n  ci:\n    steps:\n      - name: Build\n        run: npm run build\n      - name: Verify package contents\n        continue-on-error: true\n        run: ${VERIFY_COMMAND}\n`],
    ["unrelated YAML value", `env:\n  NOTE: ${VERIFY_COMMAND}\njobs:\n  ci:\n    steps:\n      - name: Build\n        run: npm run build\n`],
  ])("rejects the %s mutant", (_name, yaml) => {
    expect(() => requireFailurePropagatingStep(parse(yaml), "Verify package contents", VERIFY_COMMAND)).toThrow(
      "missing active, failure-propagating",
    );
  });
});
