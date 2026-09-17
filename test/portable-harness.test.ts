import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  it.each([
    { name: "clean", eslintStatus: 0, output: '[{"filePath":"fixture.ts","messages":[]}]', expected: 0 },
    {
      name: "findings",
      eslintStatus: 1,
      output:
        '[{"filePath":"fixture.ts","messages":[{"severity":2,"ruleId":"sonarjs/no-identical-expressions","line":17,"message":"Correct one of the identical sub-expressions on both sides of operator."}]}]',
      expected: 1,
    },
    { name: "execution error", eslintStatus: 2, output: '[{"filePath":"fixture.ts","messages":[]}]', expected: 2 },
    { name: "malformed JSON", eslintStatus: 0, output: '{', expected: 2 },
    { name: "empty output", eslintStatus: 0, output: '', expected: 2 },
    { name: "malformed result row", eslintStatus: 0, output: '[{}]', expected: 2 },
    {
      name: "non-array messages",
      eslintStatus: 0,
      output: '[{"filePath":"fixture.ts","messages":{}}]',
      expected: 2,
    },
  ])("the documented SonarJS command classifies $name", ({ name, eslintStatus, output, expected }) => {
    const profile = readFileSync(join(repoRoot, ".agents/checks/sonarjs-lint.md"), "utf8");
    const command = [...profile.matchAll(/```bash\n([\s\S]*?)\n\s*```/g)]
      .map((match) => match[1])
      .find((block) => block?.includes("npx eslint"));
    expect(command).toBeDefined();
    expect(command).not.toContain("npm i");
    const bin = temp("sonar-command-");
    const ambientBin = temp("hostile-ambient-node-");
    writeFileSync(join(bin, "npx"), `#!/bin/sh\nprintf '%s' '${output}'\nexit ${eslintStatus}\n`);
    symlinkSync(process.execPath, join(bin, "node"));
    writeFileSync(join(ambientBin, "node"), "#!/bin/sh\necho hostile ambient node >&2\nexit 127\n");
    chmodSync(join(bin, "npx"), 0o755);
    chmodSync(join(ambientBin, "node"), 0o755);
    const run = spawnSync("bash", ["-c", command!.replace("<changed_files>", "fixture.ts")], {
      encoding: "utf8",
      cwd: bin,
      env: { ...process.env, PATH: `${bin}:${ambientBin}:/usr/bin:/bin` },
    });
    expect(run.status, `documented command stderr:\n${run.stderr}`).toBe(expected);
    expect(run.stdout).toContain(`eslint exit: ${eslintStatus}`);
    if (name === "findings") {
      expect(run.stdout).toContain('"severity":2');
      expect(run.stdout).toContain('"ruleId":"sonarjs/no-identical-expressions"');
      expect(run.stdout).toContain('"line":17');
      expect(run.stdout).toContain('"message":"Correct one of the identical sub-expressions on both sides of operator."');
    }
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

  it("bounds an actual stalled health request", async () => {
    const root = temp("dochost-stalled-");
    const bin = join(root, "bin");
    const sidecar = join(root, "sidecar");
    mkdirSync(bin);
    mkdirSync(sidecar);
    writeFileSync(join(bin, "npm"), "#!/bin/sh\nexit 0\n");
    writeFileSync(join(bin, "seq"), "#!/bin/sh\necho 1\n");
    writeFileSync(join(bin, "sleep"), "#!/bin/sh\nexit 0\n");
    writeFileSync(join(bin, "node"), "#!/bin/sh\ncase \"$1\" in *dist/server.js) while :; do /bin/sleep 1; done;; *) exit 0;; esac\n");
    for (const executable of ["npm", "seq", "sleep", "node"]) chmodSync(join(bin, executable), 0o755);

    const serverFile = join(root, "stall.mjs");
    writeFileSync(serverFile, "import net from 'node:net'; net.createServer(() => {}).listen(0, '127.0.0.1', function () { console.log(this.address().port); });\n");
    const server = spawn(process.execPath, [serverFile], { stdio: ["ignore", "pipe", "inherit"] });
    const port = await new Promise<string>((resolve, reject) => {
      server.once("error", reject);
      server.stdout.once("data", (chunk) => resolve(String(chunk).trim()));
    });
    try {
      const started = Date.now();
      const run = spawnSync("bash", [join(repoRoot, "examples/dochost-poc/run.sh")], {
        encoding: "utf8",
        timeout: 2_000,
        env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, DOCHOST_SRC: sidecar, PORT: port },
      });
      expect(run.error).toBeUndefined();
      expect(run.status).toBe(1);
      expect(Date.now() - started).toBeLessThan(1_500);
      expect(run.stderr).toContain("within 15s");
    } finally {
      server.kill();
    }
  });

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
