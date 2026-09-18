import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const VERIFY_COMMAND = "npm run verify:package";
const REQUIRED_STEPS = {
  Install: "npm ci",
  "Verify conformance corpus": "npm run verify:corpus",
  Build: "npm run build",
  "Type-check gate": "npm run typecheck",
  "Purity gate": "npm run check:purity",
  "Statelessness gate": "npm run check:stateless",
  "Profile-claim staleness gate": "npm run check:profile-claims",
  "CodeRabbit config drift gate": "npm run check:coderabbit",
  "Import-graph gate": "npm run check:imports",
  "Citation-pin gate (FC-10)": "npm run check:pins",
  Tests: "npm test -- --exclude test/stateless.test.ts",
  "Clock ordering matrix": "npm run test:clock-matrix",
  "Verify package contents": VERIFY_COMMAND,
};

interface Step {
  name?: string;
  run?: string;
  if?: unknown;
  "continue-on-error"?: unknown;
}

interface Job extends Step {
  steps?: Step[];
}

interface CiFixture {
  jobs: { ci: Job & { steps: Step[] }; decoy?: Job };
  env?: Record<string, unknown>;
}

// These gates are unconditional today. New conditions require a deliberate
// contract update; do not try to evaluate GitHub's expression language here.
function unconditionalGate(value: Step): boolean {
  return value.if === undefined &&
    (value["continue-on-error"] === undefined || value["continue-on-error"] === false);
}

function requireWorkflow(document: unknown, jobId: string): void {
  const job = (document as { jobs?: Record<string, Job> })?.jobs?.[jobId];
  if (!job || !unconditionalGate(job)) throw new Error(`missing required job: ${jobId}`);
  const steps = job.steps ?? [];
  for (const [name, command] of Object.entries(REQUIRED_STEPS)) {
    const matches = steps.filter((step) => step.name === name);
    if (matches.length !== 1 || !unconditionalGate(matches[0]!) || matches[0]!.run?.trim() !== command) {
      throw new Error(`missing active, failure-propagating ${name}: ${command}`);
    }
  }
  const buildIndex = steps.findIndex((step) => step.name === "Build");
  const packIndex = steps.findIndex((step) => step.name === "Verify package contents");
  if (packIndex <= buildIndex) throw new Error("Verify package contents must run after Build");
}

const loadYaml = (relative: string) => parse(readFileSync(join(root, relative), "utf8")) as unknown;

describe("parsed CI and release contracts", () => {
  it.each([["ci", "ci"], ["release", "publish"]])(
    "%s runs every required gate and propagates failure",
    (file, job) => requireWorkflow(loadYaml(`.github/workflows/${file}.yml`), job),
  );

  it("CodeRabbit protects the workflow verifier by structured rule fields", () => {
    const config = loadYaml(".coderabbit.yaml") as {
      reviews?: { path_instructions?: Array<{ path?: string; instructions?: string }> };
    };
    const rule = config.reviews?.path_instructions?.find(({ path }) => path?.includes(".github/**"));
    expect(rule?.path).toBe("{package.json,package-lock.json,tsconfig.json,.github/**,stryker.conf.*}");
    for (const name of Object.keys(REQUIRED_STEPS)) expect(rule?.instructions).toContain(`\`${name}\``);
    expect(rule?.instructions).toContain("make non-fatal");
  });

  it.each(Object.keys(REQUIRED_STEPS))("rejects a missing %s even when named in comments", (name) => {
    const yaml = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
    const document = parse(`${yaml}\n# ${name}: ${REQUIRED_STEPS[name as keyof typeof REQUIRED_STEPS]}\n`) as CiFixture;
    document.jobs.ci.steps = document.jobs.ci.steps.filter((step: Step) => step.name !== name);
    expect(() => requireWorkflow(document, "ci")).toThrow(`missing active, failure-propagating ${name}:`);
  });

  it.each([false, "${{ false }}", "github.ref == 'refs/heads/never'"])("rejects a conditional gate: %s", (condition) => {
    const document = loadYaml(".github/workflows/ci.yml") as CiFixture;
    document.jobs.ci.steps.find((step) => step.name === "Verify package contents")!.if = condition;
    expect(() => requireWorkflow(document, "ci")).toThrow("missing active, failure-propagating Verify package contents");
  });

  it.each([true, "${{ true }}"])("rejects non-fatal steps and jobs: %s", (value) => {
    const document = loadYaml(".github/workflows/ci.yml") as CiFixture;
    document.jobs.ci.steps.find((step) => step.name === "Verify package contents")!["continue-on-error"] = value;
    expect(() => requireWorkflow(document, "ci")).toThrow("missing active, failure-propagating Verify package contents");
    document.jobs.ci["continue-on-error"] = value;
    expect(() => requireWorkflow(document, "ci")).toThrow("missing required job");
  });

  it("rejects a disabled job and a command copied to an unrelated value or job", () => {
    const document = loadYaml(".github/workflows/ci.yml") as CiFixture;
    document.jobs.ci.if = "${{ false }}";
    expect(() => requireWorkflow(document, "ci")).toThrow("missing required job");
    delete document.jobs.ci.if;
    const step = document.jobs.ci.steps.find((candidate) => candidate.name === "Verify package contents")!;
    document.env = { NOTE: step.run };
    document.jobs.decoy = { steps: [structuredClone(step)] };
    step.run = "echo skipped";
    expect(() => requireWorkflow(document, "ci")).toThrow("missing active, failure-propagating Verify package contents");
  });

  it("rejects verification before the build", () => {
    const document = loadYaml(".github/workflows/ci.yml") as CiFixture;
    const steps = document.jobs.ci.steps;
    const index = steps.findIndex((step) => step.name === "Verify package contents");
    steps.unshift(...steps.splice(index, 1));
    expect(() => requireWorkflow(document, "ci")).toThrow("Verify package contents must run after Build");
  });
});
