/**
 * The nightly mutation run is sharded (issue #303). Shard edges must fall
 * between top-level statements, because Stryker only emits a mutant whose node
 * lies wholly inside a `mutate` range. The merge must never score part of the
 * mutate glob as the whole: a missing shard, ranges that do not tile a file, an
 * uncovered mutate file or a mutant counted twice is INCONCLUSIVE (exit 2), and
 * a result that incremental mode carried out of its shard's range is dropped.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error -- untyped .mjs Stryker config; only the exported splitter is used.
import { topLevelParts } from "../stryker.shard.config.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtures: string[] = [];

const config = `export default { mutate: ["src/a.ts", "src/b.ts"], thresholds: { break: 84, low: 84, high: 90 } };\n`;

type Mutant = { status: string; line: number; endLine?: number; name?: string };

function shard(path: string, mutants: Mutant[]) {
  return JSON.stringify({
    schemaVersion: "1",
    thresholds: { high: 90, low: 84, break: null },
    files: {
      [path]: {
        language: "typescript",
        source: "",
        mutants: mutants.map((m, i) => ({
          id: String(i),
          status: m.status,
          mutatorName: m.name ?? "BooleanLiteral",
          replacement: "x",
          location: { start: { line: m.line, column: 1 }, end: { line: m.endLine ?? m.line, column: 2 } },
        })),
      },
    },
  });
}

function range(file: string, startLine: number, endLine: number, part = "1/1", lastLine = endLine) {
  return JSON.stringify({ file, part, startLine, endLine, lastLine });
}

function runMerge(files: Record<string, string>, expected: number) {
  const fixture = mkdtempSync(join(tmpdir(), "mutation-merge-"));
  fixtures.push(fixture);
  mkdirSync(join(fixture, "scripts"));
  mkdirSync(join(fixture, "reports", "mutation", "shards"), { recursive: true });
  copyFileSync(join(root, "scripts", "merge-mutation-reports.mjs"), join(fixture, "scripts", "merge-mutation-reports.mjs"));
  writeFileSync(join(fixture, "stryker.config.mjs"), config);
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(fixture, "reports", "mutation", "shards", name), body);
  }
  const run = spawnSync(process.execPath, [join(fixture, "scripts", "merge-mutation-reports.mjs"), String(expected)], {
    encoding: "utf8",
  });
  const outPath = join(fixture, "reports", "mutation", "mutation.json");
  return { run, read: () => JSON.parse(readFileSync(outPath, "utf8")) };
}

const complete = (): Record<string, string> => ({
  "a-1.json": shard("src/a.ts", [{ status: "Killed", line: 2 }, { status: "Survived", line: 9 }]),
  "a-1.range.json": range("src/a.ts", 1, 10, "1/2", 20),
  "a-2.json": shard("src/a.ts", [{ status: "Killed", line: 15 }]),
  "a-2.range.json": range("src/a.ts", 11, 20, "2/2", 20),
  "b.json": shard("src/b.ts", [{ status: "Timeout", line: 1 }]),
  "b.range.json": range("src/b.ts", 1, 5),
});

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

describe("merge-mutation-reports", () => {
  it("concatenates every shard's mutants per file with unique ids and the configured thresholds", () => {
    const { run, read } = runMerge(complete(), 3);
    expect(run.status).toBe(0);
    const report = read();
    expect(report.thresholds).toEqual({ break: 84, low: 84, high: 90 });
    expect(report.files["src/a.ts"].mutants.map((m: { id: string }) => m.id)).toEqual(["a-1-0", "a-1-1", "a-2-0"]);
    expect(report.files["src/b.ts"].mutants.map((m: { status: string }) => m.status)).toEqual(["Timeout"]);
  });

  it("drops a cached result that moved out of its shard's range instead of counting it twice", () => {
    const files = complete();
    // a-1 still carries a relocated cached copy of the mutant a-2 now owns at line 15.
    files["a-1.json"] = shard("src/a.ts", [{ status: "Killed", line: 2 }, { status: "Survived", line: 15 }]);
    const { run, read } = runMerge(files, 3);
    expect(run.status).toBe(0);
    expect(read().files["src/a.ts"].mutants.map((m: { id: string }) => m.id)).toEqual(["a-1-0", "a-2-0"]);
    expect(run.stdout).toContain("dropped 1 result");
  });

  it("drops a mutant whose node straddles its shard's range", () => {
    const files = complete();
    files["a-1.json"] = shard("src/a.ts", [{ status: "Killed", line: 2 }, { status: "Killed", line: 9, endLine: 12 }]);
    const { run, read } = runMerge(files, 3);
    expect(run.status).toBe(0);
    expect(read().files["src/a.ts"].mutants).toHaveLength(2);
  });

  it("is INCONCLUSIVE when the same mutant is reported by two shards", () => {
    const files = complete();
    files["a-2.json"] = shard("src/a.ts", [{ status: "Killed", line: 15 }, { status: "Killed", line: 15 }]);
    const { run } = runMerge(files, 3);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("reported by more than one shard");
  });

  it("is INCONCLUSIVE when a shard report is missing", () => {
    const files = complete();
    delete files["a-2.json"];
    const { run } = runMerge(files, 3);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("found 2 shard report(s)");
  });

  it("is INCONCLUSIVE when a shard has no range", () => {
    const files = complete();
    delete files["b.range.json"];
    const { run } = runMerge(files, 3);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("has no b.range.json");
  });

  it("is INCONCLUSIVE when the ranges leave a gap in a file", () => {
    const files = complete();
    files["a-2.range.json"] = range("src/a.ts", 12, 20, "2/2", 20);
    const { run } = runMerge(files, 3);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("do not tile it: a-2 starts at line 12, expected 11");
  });

  it("is INCONCLUSIVE when the parts stop before the end of the file", () => {
    const files = complete();
    files["a-1.range.json"] = range("src/a.ts", 1, 10, "1/3", 30);
    files["a-2.range.json"] = range("src/a.ts", 11, 20, "2/3", 30);
    const { run } = runMerge(files, 3);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("shard parts for src/a.ts are [1/3,2/3], expected [1/3,2/3,3/3]");
  });

  it("is INCONCLUSIVE when the last part ends before the file's last line", () => {
    const files = complete();
    files["a-2.range.json"] = range("src/a.ts", 11, 20, "2/2", 25);
    const { run } = runMerge(files, 3);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("stop at line 20, but the file has 25 lines");
  });

  it("is INCONCLUSIVE when a mutate file has no mutants, even with an empty entry", () => {
    const files = complete();
    files["b.json"] = shard("src/b.ts", []);
    const { run } = runMerge(files, 3);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("no mutants from src/b.ts");
  });

  it("is INCONCLUSIVE on an unreadable shard", () => {
    const files = complete();
    files["a-1.json"] = "{not-json";
    const { run } = runMerge(files, 3);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("could not read or parse shard a-1.json");
  });
});

describe("topLevelParts", () => {
  const source = [
    "const a = 1;", // 1
    "function f() {", // 2
    "  if (a) {", // 3
    "    return 1;", // 4
    "  }", // 5
    "  return 2;", // 6
    "}", // 7
    "const b = 2;", // 8
    "function g() {", // 9
    "  return b;", // 10
    "}", // 11
    "", // 12
  ].join("\n");

  it("tiles the file from line 1 to its last line with edges only between top-level statements", () => {
    const parts = topLevelParts(source, 3);
    expect(parts[0]![0]).toBe(1);
    expect(parts.at(-1)![1]).toBe(12);
    for (let i = 1; i < parts.length; i++) expect(parts[i]![0]).toBe(parts[i - 1]![1] + 1);
    const edges = parts.slice(0, -1).map((p: number[]) => p[1]);
    for (const edge of edges) expect([1, 7, 8, 11]).toContain(edge);
  });

  it("never splits inside a function on every real mutate file", () => {
    for (const file of ["src/applier.ts", "src/doc.ts"]) {
      const text = readFileSync(join(root, file), "utf8");
      const parts = topLevelParts(text, file === "src/applier.ts" ? 7 : 2);
      expect(parts[0]![0]).toBe(1);
      expect(parts.at(-1)![1]).toBe(text.split("\n").length);
      for (const [, end] of parts.slice(0, -1)) {
        const next = text.split("\n")[end] ?? "";
        expect(next.startsWith(" ") || next.startsWith("\t"), `${file}:${end + 1} starts indented`).toBe(false);
      }
    }
  });

  it("never separates two top-level statements that share a line", () => {
    const shared = "const a = 1; function f() {\n  return true;\n}\nconst b = 2;\n";
    expect(topLevelParts(shared, 2)).toEqual([[1, 3], [4, 5]]);
    expect(() => topLevelParts("const a = 1; function f() {\n  return true;\n}\n", 2)).toThrow(/cannot split 1 top-level line groups into 2 parts/);
  });

  it("refuses more parts than top-level line groups", () => {
    expect(() => topLevelParts("const a = 1;\n", 2)).toThrow(/cannot split 1 top-level line groups into 2 parts/);
  });
});
