import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const temporary: string[] = [];

function temp(prefix: string) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("portable harness regressions", () => {
  it.each([0, 1, 2])("the documented SonarJS command preserves exit %i", (status) => {
    const profile = readFileSync(join(repoRoot, ".agents/checks/sonarjs-lint.md"), "utf8");
    const command = [...profile.matchAll(/```bash\n([\s\S]*?)\n\s*```/g)]
      .map((match) => match[1])
      .find((block) => block?.includes("npx eslint"));
    expect(command).toBeDefined();
    expect(command).not.toContain("npm i");
    const bin = temp("sonar-command-");
    writeFileSync(join(bin, "npx"), `#!/bin/sh\nexit ${status}\n`);
    chmodSync(join(bin, "npx"), 0o755);
    const run = spawnSync("bash", ["-c", command!.replace("<changed_files>", "fixture.ts")], {
      encoding: "utf8",
      cwd: bin,
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` },
    });
    expect(run.status).toBe(status);
    expect(run.stdout).toContain(`eslint exit: ${status}`);
  });

  it("the driver's root calculation decodes a URL-encoded checkout path", () => {
    const checkout = join(temp("dochost path "), "repo root");
    const driver = join(checkout, "examples/dochost-poc/dochost-driver.mjs");
    mkdirSync(dirname(driver), { recursive: true });
    const source = readFileSync(join(repoRoot, "examples/dochost-poc/dochost-driver.mjs"), "utf8");
    // Run the actual setup, stopping before catalog I/O and network operations.
    const boundary = source.indexOf("const catalog =");
    expect(boundary).toBeGreaterThan(0);
    writeFileSync(driver, `${source.slice(0, boundary)}\nprocess.stdout.write(CMP);\n`);
    const env = { ...process.env };
    delete env.CMP_PIN;
    const converted = spawnSync(process.execPath, [driver], { encoding: "utf8", env });
    expect(converted.status).toBe(0);
    expect(converted.stdout.trim()).toBe(`${checkout}/`);
  });

  for (const { name, expectedStatus, healthy } of [
    { name: "unhealthy", expectedStatus: 1, healthy: false },
    { name: "healthy", expectedStatus: 0, healthy: true },
  ]) {
    it(`${name} sidecar controls whether the driver runs`, () => {
      const root = temp("dochost-run-");
      const bin = join(root, "bin");
      const sidecar = join(root, "sidecar");
      mkdirSync(bin);
      mkdirSync(sidecar);
      writeFileSync(join(bin, "npm"), "#!/bin/sh\nexit 0\n");
      writeFileSync(join(bin, "seq"), "#!/bin/sh\necho 1\n");
      writeFileSync(join(bin, "sleep"), "#!/bin/sh\nexit 0\n");
      writeFileSync(join(bin, "curl"), `#!/bin/sh\nexit ${healthy ? 0 : 1}\n`);
      writeFileSync(
        join(bin, "node"),
        "#!/bin/sh\ncase \"$1\" in *dist/server.js) while :; do /bin/sleep 1; done;; *) echo driver-ran; exit 0;; esac\n",
      );
      for (const executable of ["npm", "seq", "sleep", "curl", "node"])
        chmodSync(join(bin, executable), 0o755);
      const run = spawnSync("bash", [join(repoRoot, "examples/dochost-poc/run.sh")], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, DOCHOST_SRC: sidecar },
      });
      expect(run.status).toBe(expectedStatus);
      expect(run.stdout.includes("driver-ran")).toBe(healthy);
      if (!healthy) expect(run.stderr).toContain("sidecar did not become healthy");
    });
  }

  it("rejects equal-count readers with unequal link values", () => {
    const source = readFileSync(join(repoRoot, "scripts/bench-read.mjs"), "utf8");
    const assertion = source.match(/const ok =([\s\S]*?);/)?.[1];
    expect(assertion).toBeDefined();
    const nodes = new Map([["1", { id: "1" }]]);
    const left = { nodes, links: new Map([["7", { id: "7", targetId: "1" }]]) };
    const right = { nodes, links: new Map([["7", { id: "7", targetId: "2" }]]) };
    expect(runInNewContext(assertion!, { ra: left, rb: right })).toBe(false);
    expect(runInNewContext(assertion!, { ra: left, rb: left })).toBe(true);
  });
});
