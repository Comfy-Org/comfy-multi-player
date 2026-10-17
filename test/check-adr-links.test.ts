import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const fixtures: string[] = [];
const script = join(process.cwd(), "scripts", "check-adr-links.mjs");
const adrPath = (filename: string) => ["docs", "adr", filename].join("/");

function fixture() {
  const root = join(tmpdir(), `cmp-adr-links-${process.pid}-${fixtures.length}`);
  mkdirSync(join(root, "docs", "adr"), { recursive: true });
  execFileSync("/usr/bin/git", ["init", "-q"], { cwd: root });
  fixtures.push(root);
  return root;
}

function write(root: string, filename: string, contents: string) {
  const absolute = join(root, filename);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, contents);
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

describe("ADR link validation", () => {
  test("accepts references to existing ADRs", () => {
    const root = fixture();
    const target = adrPath("CRDT-0001-real.md");
    write(root, target, "# real\n");
    write(root, "README.md", `See ${target}.\n`);
    expect(run(root)).toContain("ADR link validation passed");
  });

  test("rejects dangling ADR references with their source line", () => {
    const root = fixture();
    write(root, "README.md", `first\nSee ${adrPath("CRDT-0001-missing.md")}.\n`);
    expect(() => run(root)).toThrow(/README\.md:2/);
  });

  test("ignores references outside the ADR directory", () => {
    const root = fixture();
    write(root, "README.md", "See docs/architecture/overview.md.\n");
    expect(run(root)).toContain("ADR link validation passed");
  });
});
