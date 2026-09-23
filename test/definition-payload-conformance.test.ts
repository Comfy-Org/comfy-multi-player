import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { applyOps, mint, project, type Op, type WorkflowJSON } from "../src/index.js";
import { canonicalize, fixturesDir, loadCatalog } from "./helpers.js";

interface DefinitionPayloadCase {
  id: `N${number}`;
  name: string;
  ops: Record<string, unknown>[];
  expected_reason: string;
  expected_projection: "base_workflow";
}

interface DefinitionPayloadVectors {
  format_version: number;
  base_workflow: WorkflowJSON;
  cases: DefinitionPayloadCase[];
}

const manifestPath = resolve(fixturesDir, "golden-vectors", "conformance.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
  definition_payload_cases: string;
};
const vectors = JSON.parse(
  readFileSync(resolve(dirname(manifestPath), manifest.definition_payload_cases), "utf8"),
) as DefinitionPayloadVectors;

describe("definition-payload golden-vector conformance", () => {
  it("provides exactly the N1-N8 contract vectors", () => {
    expect(vectors.format_version).toBe(1);
    expect(vectors.cases.map(({ id }) => id)).toEqual([
      "N1",
      "N2",
      "N3",
      "N4",
      "N5",
      "N6",
      "N7",
      "N8",
    ]);
  });

  for (const vector of vectors.cases) {
    it(`${vector.id} ${vector.name}: rejects without changing the document or projection`, () => {
      expect(vector.ops.length).toBeGreaterThan(0);
      expect(vector.expected_projection).toBe("base_workflow");
      for (const op of vector.ops) {
        const catalog = loadCatalog();
        const doc = mint(vectors.base_workflow, catalog);
        const beforeBytes = Y.encodeStateAsUpdate(doc);
        const beforeProjection = canonicalize(project(doc, catalog));

        const result = applyOps(doc, [op as unknown as Op], catalog);

        expect(result.outcomes).toEqual([
          expect.objectContaining({
            op_id: op.op_id,
            outcome: "rejected",
            reason: expect.objectContaining({ code: vector.expected_reason }),
          }),
        ]);
        expect(Y.encodeStateAsUpdate(doc)).toEqual(beforeBytes);
        expect(canonicalize(project(doc, catalog))).toEqual(beforeProjection);
        expect(canonicalize(project(doc, catalog))).toEqual(canonicalize(vectors.base_workflow));
      }
    });
  }
});
