import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const script = join(root, "scripts", "verify-package.mjs");

function runManifest(value: string) {
  const fixture = mkdtempSync(join(tmpdir(), "pack-manifest-"));
  try {
    const path = join(fixture, "pack.json");
    writeFileSync(path, value);
    return spawnSync(process.execPath, [script, path], { encoding: "utf8" });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

const manifest = (paths: unknown[]) =>
  JSON.stringify([{ files: paths.map((path) => ({ path })) }]);

describe("package verifier", () => {
  it("accepts the runtime and declarations without source", () => {
    const run = runManifest(manifest(["package.json", "dist/index.js", "dist/index.d.ts"]));
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("package verification passed");
  });

  it.each([
    ["malformed JSON", "not JSON", "malformed JSON"],
    ["wrong top-level shape", JSON.stringify({ files: [] }), "one npm pack result"],
    ["missing declarations", manifest(["dist/index.js"]), "missing dist/index.d.ts"],
    ["source included", manifest(["dist/index.js", "dist/index.d.ts", "src/index.ts"]), "includes src/index.ts"],
    ["malformed file entry", manifest(["dist/index.js", "dist/index.d.ts", 12]), "path must be a string"],
  ])("fails on %s", (_name, input, message) => {
    const run = runManifest(input);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(message);
  });
});
