import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyOps, mint, project } from "../src/index.js";
import { canonicalize, fixturesDir, loadCatalog, loadSession } from "./helpers.js";

interface ConformanceManifest {
  format_version: number;
  cases: { name: string; session: string }[];
}

const manifest = JSON.parse(
  readFileSync(join(fixturesDir, "golden-vectors", "conformance.json"), "utf8"),
) as ConformanceManifest;

describe("cross-language golden-vector parity contract", () => {
  it("uses the supported conformance format", () => {
    expect(manifest.format_version).toBe(1);
    expect(manifest.cases.length).toBeGreaterThan(0);
  });

  for (const vector of manifest.cases) {
    it(`${vector.name}: TS reference produces the recorded canonical output`, () => {
      const { header, ops } = loadSession(vector.session.replace("../", ""));
      const catalog = loadCatalog();
      const doc = mint(header.base_workflow, catalog);
      const result = applyOps(doc, ops, catalog);

      expect(result.failed).toBeNull();
      expect(result.skipped).toEqual([]);
      expect(result.applied_count).toBe(ops.length);
      expect(canonicalize(project(doc, catalog))).toEqual(canonicalize(header.workflow_final));
    });
  }
});
