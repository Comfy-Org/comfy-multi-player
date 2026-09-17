import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const script = join(repoRoot, "scripts", "check-stateless.mjs");

function executable(path: string, body: string) {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

describe("check-stateless gate", () => {
  let root: string;
  let bin: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "stateless-check-"));
    bin = join(root, "node_modules", ".bin");
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "test"));
    mkdirSync(join(root, "scripts"));
    copyFileSync(script, join(root, "scripts", "check-stateless.mjs"));
    mkdirSync(join(root, ".agents", "checks"), { recursive: true });
    for (const dependency of ["eslint", "@typescript-eslint/parser", "eslint-plugin-sonarjs"]) {
      mkdirSync(join(root, "node_modules", dependency), { recursive: true });
    }
    writeFileSync(join(root, "src", "index.ts"), "export const value = 1;\n");
    writeFileSync(join(root, "test", "stateless.test.ts"), "// fixture probe\n");
    writeFileSync(join(root, ".agents", "checks", "eslint.strict.config.js"), "export default [];\n");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "stateless-fixture" }));
    executable(
      join(bin, "eslint"),
      `printf '%s\\n' '[{"filePath":"${join(root, "src", "index.ts")}","messages":[]}]'`,
    );
    executable(join(bin, "vitest"), "exit 0");
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function run() {
    return spawnSync("node", [join(root, "scripts", "check-stateless.mjs")], {
      encoding: "utf8",
    });
  }

  it("passes only after lint and the process probe both succeed", () => {
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "No issues found (1 source files linted; stateless-fixture stateless probe passed)",
    );
  });

  it("returns exit 2 when the vitest executable is missing", () => {
    rmSync(join(bin, "vitest"));
    const result = run();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("INCONCLUSIVE — vitest is not installed; run npm ci");
  });

  it("returns exit 2 when the stateless probe is missing", () => {
    rmSync(join(root, "test", "stateless.test.ts"));
    const result = run();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("INCONCLUSIVE — test/stateless.test.ts is missing");
  });

  it("returns exit 2 when spawning the stateless probe fails", () => {
    writeFileSync(join(bin, "vitest"), "#!/definitely/missing/interpreter\n");
    chmodSync(join(bin, "vitest"), 0o755);
    const result = run();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("INCONCLUSIVE — could not run the stateless probe: spawnSync");
  });

  it("preserves a genuine lint finding as exit 1", () => {
    executable(
      join(bin, "eslint"),
      `printf '%s\\n' '[{"filePath":"${join(root, "src", "index.ts")}","messages":[{"ruleId":"no-warning-comments","message":"finding"}]}]'`,
    );
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('"message": "finding"');
  });

  it("preserves a failing stateless probe as exit 1", () => {
    executable(join(bin, "vitest"), "exit 1");
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("No issues found");
  });
});
