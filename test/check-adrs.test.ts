import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const fixtures: string[] = [];
const script = join(process.cwd(), "scripts", "check-adrs.mjs");

function fixture(filename = "CRDT-0001-test-decision.md") {
  const root = join(tmpdir(), `cmp-adr-check-${process.pid}-${fixtures.length}`);
  const directory = join(root, "docs", "adr");
  mkdirSync(directory, { recursive: true });
  fixtures.push(root);
  writeFileSync(
    join(directory, filename),
    "# ADR-CRDT-0001: Test decision\n\nDate: 2026-10-17\n\n## Status\n\nProposed\n",
  );
  return root;
}

function run(root: string) {
  return execFileSync(process.execPath, [script], {
    cwd: root,
    encoding: "utf8",
    stdio: "pipe",
  });
}

afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true });
});

describe("ADR validation", () => {
  test("accepts canonical ADR metadata", () => {
    expect(run(fixture())).toContain("ADR validation passed");
  });

  test("accepts a status immediately below its heading", () => {
    const root = fixture();
    writeFileSync(
      join(root, "docs", "adr", "CRDT-0001-test-decision.md"),
      "# ADR-CRDT-0001: Test decision\n\nDate: 2026-10-17\n\n## Status\nProposed\n",
    );
    expect(run(root)).toContain("ADR validation passed");
  });

  test("rejects a status value with an unrecognized suffix", () => {
    const root = fixture();
    writeFileSync(
      join(root, "docs", "adr", "CRDT-0001-test-decision.md"),
      "# ADR-CRDT-0001: Test decision\n\nDate: 2026-10-17\n\n## Status\n\nProposed-extra\n",
    );
    expect(() => run(root)).toThrow(/missing a valid Status value/);
  });

  test("rejects numeric-only legacy filenames", () => {
    expect(() => run(fixture("0001-test-decision.md"))).toThrow(
      /Invalid ADR filenames/,
    );
  });

  test("rejects a heading that disagrees with its filename", () => {
    const root = fixture();
    writeFileSync(
      join(root, "docs", "adr", "CRDT-0001-test-decision.md"),
      "# ADR-CRDT-0002: Test decision\n\nDate: 2026-10-17\n\n## Status\n\nProposed\n",
    );
    expect(() => run(root)).toThrow(/expected heading/);
  });

  test("rejects companion directories without a matching ADR", () => {
    const root = fixture();
    mkdirSync(join(root, "docs", "adr", "CRDT-0002-evidence"));
    expect(() => run(root)).toThrow(/companion directory has no matching ADR/);
  });
});
