/**
 * The nightly mutation run is sharded (issue #303). The merge must never score
 * part of the mutate glob as the whole: a missing shard or an uncovered mutate
 * file is INCONCLUSIVE (exit 2), and a complete merge carries the configured
 * break threshold so check:mutation-report can judge it.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtures: string[] = [];

const config = `export default { mutate: ["src/a.ts", "src/b.ts"], thresholds: { break: 84, low: 84, high: 90 } };\n`;

function shard(path: string, statuses: string[]) {
  return JSON.stringify({
    schemaVersion: "1",
    thresholds: { high: 90, low: 84, break: null },
    files: { [path]: { language: "typescript", source: "", mutants: statuses.map((status, i) => ({ id: String(i), status })) } },
  });
}

function runMerge(shards: Record<string, string>, expected: number) {
  const fixture = mkdtempSync(join(tmpdir(), "mutation-merge-"));
  fixtures.push(fixture);
  mkdirSync(join(fixture, "scripts"));
  mkdirSync(join(fixture, "reports", "mutation", "shards"), { recursive: true });
  copyFileSync(join(root, "scripts", "merge-mutation-reports.mjs"), join(fixture, "scripts", "merge-mutation-reports.mjs"));
  writeFileSync(join(fixture, "stryker.config.mjs"), config);
  for (const [name, body] of Object.entries(shards)) {
    writeFileSync(join(fixture, "reports", "mutation", "shards", `${name}.json`), body);
  }
  const run = spawnSync(process.execPath, [join(fixture, "scripts", "merge-mutation-reports.mjs"), String(expected)], { encoding: "utf8" });
  const outPath = join(fixture, "reports", "mutation", "mutation.json");
  return { run, read: () => JSON.parse(readFileSync(outPath, "utf8")) };
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

describe("merge-mutation-reports", () => {
  it("concatenates every shard's mutants per file with unique ids and the configured thresholds", () => {
    const { run, read } = runMerge(
      {
        "a-1": shard("src/a.ts", ["Killed", "Survived"]),
        "a-2": shard("src/a.ts", ["Killed"]),
        b: shard("src/b.ts", ["Timeout"]),
      },
      3,
    );
    expect(run.status).toBe(0);
    const report = read();
    expect(report.thresholds).toEqual({ break: 84, low: 84, high: 90 });
    expect(report.files["src/a.ts"].mutants.map((m: { id: string }) => m.id)).toEqual(["a-1-0", "a-1-1", "a-2-0"]);
    expect(report.files["src/b.ts"].mutants.map((m: { status: string }) => m.status)).toEqual(["Timeout"]);
  });

  it("is INCONCLUSIVE when a shard report is missing", () => {
    const { run } = runMerge({ "a-1": shard("src/a.ts", ["Killed"]), b: shard("src/b.ts", ["Killed"]) }, 3);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("found 2 shard report(s)");
  });

  it("is INCONCLUSIVE when the shards leave a mutate file uncovered", () => {
    const { run } = runMerge({ "a-1": shard("src/a.ts", ["Killed"]), "a-2": shard("src/a.ts", ["Killed"]) }, 2);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("no mutants from src/b.ts");
  });

  it("is INCONCLUSIVE on an unreadable shard", () => {
    const { run } = runMerge({ "a-1": "{not-json", b: shard("src/b.ts", ["Killed"]) }, 2);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("could not read or parse shard a-1.json");
  });
});
