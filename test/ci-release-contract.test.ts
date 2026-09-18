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
  uses?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
  if?: unknown;
  shell?: unknown;
  "continue-on-error"?: unknown;
}

interface Job extends Step {
  steps?: Step[];
  defaults?: { run?: { shell?: unknown } };
}

interface CiFixture {
  jobs: { ci: Job & { steps: Step[] }; decoy?: Job };
  env?: Record<string, unknown>;
  defaults?: { run?: { shell?: unknown } };
}

// These gates are unconditional today. New conditions require a deliberate
// contract update; do not try to evaluate GitHub's expression language here.
// Shell overrides likewise need review because they can skip the run script.
function unconditionalGate(value: Step): boolean {
  return value.if === undefined && value.shell === undefined &&
    (value["continue-on-error"] === undefined || value["continue-on-error"] === false);
}

function requireWorkflow(document: unknown, jobId: string): void {
  const workflow = document as { jobs?: Record<string, Job>; defaults?: Job["defaults"] };
  const job = workflow?.jobs?.[jobId];
  if (!job || !unconditionalGate(job)) throw new Error(`missing required job: ${jobId}`);
  if (workflow.defaults?.run?.shell !== undefined || job.defaults?.run?.shell !== undefined) {
    throw new Error("required gates must use the default runner shell");
  }
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
  if (jobId === "publish") requireRelease(steps);
}

function requireRelease(steps: Step[]): void {
  const recovery = steps.filter((step) => step.name === "Verify identity and recover release");
  if (recovery.length !== 1 || !unconditionalGate(recovery[0]!) ||
    recovery[0]!.run !== "node scripts/release-retry.mjs" || recovery[0]!.env?.GH_TOKEN !== "${{ github.token }}") {
    throw new Error("missing failure-propagating release identity/recovery gate");
  }
  const recoveryIndex = steps.indexOf(recovery[0]!);
  for (const name of Object.keys(REQUIRED_STEPS)) {
    if (steps.findIndex((step) => step.name === name) >= recoveryIndex) {
      throw new Error(`release recovery must follow ${name}`);
    }
  }
  const toolchain = steps.filter((step) => step.name === "Pin release npm");
  if (toolchain.length !== 1 || !unconditionalGate(toolchain[0]!) ||
    toolchain[0]!.run !== "npm install --global npm@11.19.0 --ignore-scripts" ||
    steps.indexOf(toolchain[0]!) >= steps.findIndex((step) => step.name === "Install")) {
    throw new Error("missing supported pinned npm before Install");
  }
  const node = steps.find((step) => step.uses?.startsWith("actions/setup-node@"));
  if (!node || !unconditionalGate(node) || node.with?.["node-version"] !== "24.21.0") {
    throw new Error("missing pinned release Node");
  }
  if (steps.some((step) => /npm publish|gh release create/.test(step.run ?? ""))) {
    throw new Error("release writes must go through identity/recovery gate");
  }
}

const loadYaml = (relative: string) => parse(readFileSync(join(root, relative), "utf8")) as unknown;

describe("standalone package ownership", () => {
  // Recovery: https://github.com/Comfy-Org/comfy-multi-player/pull/217
  it("routes README development to the standalone repository with npm", () => {
    const readme = readFileSync(join(root, "README.md"), "utf8");
    const develop = readme.split("## Develop\n")[1]?.split("\n## ")[0];
    expect(develop).toBeDefined();
    expect(develop).toContain("https://github.com/Comfy-Org/comfy-multi-player");
    expect(develop).toContain("npm ci");
    expect(develop).not.toMatch(/pnpm|packages\/comfy-multi-player/);
  });

  it("installs a specific published version and saves an exact dependency", () => {
    const readme = readFileSync(join(root, "README.md"), "utf8");
    const install = readme.split("## Install\n")[1]?.split("\n## ")[0];
    expect(install).toBeDefined();
    expect(install).toContain("npm install --save-exact @comfyorg/comfy-multi-player@0.2.1");
  });

  it("keeps the roadmap migration deferred and standalone development writable", () => {
    const roadmap = readFileSync(join(root, "docs/ROADMAP.md"), "utf8");
    const plan = roadmap.split("## Repository plan\n")[1];
    expect(plan).toBeDefined();
    expect(plan).toContain("canonical writable source");
    expect(plan).toContain("deferred");
    expect(plan).toContain("https://github.com/Comfy-Org/comfy-multi-player");
    expect(plan).not.toMatch(/Completed by|read-only record|ownership moved/);
  });

  it("does not turn historical schema compatibility into a completed migration", () => {
    const schema = readFileSync(join(root, "docs/multiplayer-schema.md"), "utf8");
    expect(schema).not.toContain("canonical workspace source");
    expect(schema).toContain("frontend source migration is deferred");
  });

  it("accepts standalone issues and provides a private security contact", () => {
    const config = loadYaml(".github/ISSUE_TEMPLATE/config.yml") as {
      blank_issues_enabled: boolean;
      contact_links: Array<{ name: string; url: string }>;
    };
    expect(config.blank_issues_enabled).toBe(true);
    expect(config.contact_links).toContainEqual(expect.objectContaining({
      name: "Security report", url: "mailto:support@comfy.org",
    }));
    expect(config.contact_links.some(({ url }) => url.includes("ComfyUI_frontend"))).toBe(false);
  });
});

describe("parsed CI and release contracts", () => {
  it.each([["ci", "ci"], ["release", "publish"]])(
    "%s runs every required gate and propagates failure",
    (file, job) => requireWorkflow(loadYaml(`.github/workflows/${file}.yml`), job),
  );

  it.each(Object.keys(REQUIRED_STEPS))("rejects release recovery before %s", (name) => {
    const document = loadYaml(".github/workflows/release.yml") as { jobs: { publish: { steps: Step[] } } };
    const steps = document.jobs.publish.steps;
    const index = steps.findIndex((step) => step.name === "Verify identity and recover release");
    const recovery = steps.splice(index, 1)[0]!;
    steps.splice(steps.findIndex((step) => step.name === name), 0, recovery);
    expect(() => requireWorkflow(document, "publish")).toThrow("release recovery must follow");
  });

  it.each([
    ["conditional recovery", (steps: Step[]) => { steps.find((step) => step.name === "Verify identity and recover release")!.if = "${{ success() }}"; }],
    ["non-fatal recovery", (steps: Step[]) => { steps.find((step) => step.name === "Verify identity and recover release")!["continue-on-error"] = true; }],
    ["changed helper", (steps: Step[]) => { steps.find((step) => step.name === "Verify identity and recover release")!.run = "echo skipped"; }],
    ["old npm", (steps: Step[]) => { steps.find((step) => step.name === "Pin release npm")!.run = "npm install --global npm@10.9.7"; }],
    ["moving Node", (steps: Step[]) => { steps.find((step) => step.uses?.startsWith("actions/setup-node@"))!.with!["node-version"] = 24; }],
    ["unguarded publication", (steps: Step[]) => { steps.push({ run: "npm publish --provenance --access public" }); }],
  ] as const)("rejects %s", (_name, change) => {
    const document = loadYaml(".github/workflows/release.yml") as { jobs: { publish: { steps: Step[] } } };
    change(document.jobs.publish.steps);
    expect(() => requireWorkflow(document, "publish")).toThrow();
  });

  it("CodeRabbit protects the workflow verifier by structured rule fields", () => {
    const config = loadYaml(".coderabbit.yaml") as {
      reviews?: { path_instructions?: Array<{ path?: string; instructions?: string }> };
    };
    const rule = config.reviews?.path_instructions?.find(({ path }) => path?.includes(".github/**"));
    expect(rule?.path).toBe("{package.json,package-lock.json,tsconfig.json,.github/**,stryker.conf.*}");
    for (const name of Object.keys(REQUIRED_STEPS)) expect(rule?.instructions).toContain(`\`${name}\``);
    expect(rule?.instructions).toContain("Do not remove or make non-fatal");
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

  it.each(["step", "job", "workflow"])("rejects a %s shell that skips gate execution", (scope) => {
    const document = loadYaml(".github/workflows/ci.yml") as CiFixture;
    if (scope === "step") {
      document.jobs.ci.steps.find((step) => step.name === "Verify package contents")!.shell = "echo {0}";
    } else if (scope === "job") {
      document.jobs.ci.defaults = { run: { shell: "echo {0}" } };
    } else {
      document.defaults = { run: { shell: "echo {0}" } };
    }
    expect(() => requireWorkflow(document, "ci")).toThrow();
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
