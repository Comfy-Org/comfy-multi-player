import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const BEGIN = "  # BEGIN GENERATED path_instructions";
const END = "  # END GENERATED path_instructions";
const BUILD_CONTRACT_PATH =
  "{package.json,package-lock.json,tsconfig.json,.github/**,stryker.conf.*}";

function requiredCiStepNames(workflow: string): string[] {
  return workflow
    .split("\n")
    .map((line) => /^ {6}- name:\s*(.+?)\s*$/.exec(line)?.[1])
    .filter((name): name is string => name !== undefined)
    .map((name) => name.replace(/^(?:"(.*)"|'(.*)')$/, "$1$2"));
}

function generatedInstruction(config: string, path: string): string {
  const begin = config.indexOf(BEGIN);
  const end = config.indexOf(END, begin + BEGIN.length);
  expect(begin).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(begin);

  const generated = config.slice(begin, end);
  const lines = generated.split("\n");
  const pathLine = `    - path: "${path}"`;
  const pathIndex = lines.indexOf(pathLine);
  expect(pathIndex).toBeGreaterThanOrEqual(0);

  const instructionStart = lines.indexOf("      instructions: >-", pathIndex + 1);
  expect(instructionStart).toBeGreaterThan(pathIndex);

  const body: string[] = [];
  for (const line of lines.slice(instructionStart + 1)) {
    if (!line.startsWith("        ")) break;
    body.push(line.slice(8));
  }
  return body.join(" ");
}

describe("CI contract CodeRabbit instruction", () => {
  it("names every required CI step from the workflow", () => {
    const workflow = readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8");
    const config = readFileSync(join(repoRoot, ".coderabbit.yaml"), "utf8");
    const stepNames = requiredCiStepNames(workflow);
    const instruction = generatedInstruction(config, BUILD_CONTRACT_PATH);

    expect(stepNames.length).toBeGreaterThan(0);
    for (const stepName of stepNames) {
      expect(instruction, `missing required CI step: ${stepName}`).toContain(stepName);
    }
  });
});
