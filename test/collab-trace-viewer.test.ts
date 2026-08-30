import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { filterOptions, filterSteps, loadTrace, targetLabel } from "../devtools/collab-replay-viewer/loader.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = resolve(root, "devtools/collab-replay-viewer/fixtures/lww-evidence.json");

describe("read-only collaboration trace loader", () => {
  it("loads and freezes the checked fixture with renderable projections", () => {
    const trace = loadTrace(readFileSync(fixturePath, "utf8"));
    expect(trace.steps).toHaveLength(2);
    const first = trace.steps[0]!;
    expect(first.kind).toBe("semantic-op");
    if (first.kind !== "semantic-op" || !first.before_projection) throw new Error("fixture semantic projection missing");
    expect(Object.isFrozen(first.before_projection.nodes[0])).toBe(true);
    expect(trace.steps[1]).toMatchObject({ actor: "agent:fixture", outcome: "lww-dropped" });
  });

  it("filters by actor, target, and outcome without changing the trace", () => {
    const trace = loadTrace(readFileSync(fixturePath, "utf8"));
    const first = trace.steps[0]!;
    if (first.kind !== "semantic-op") throw new Error("fixture semantic step missing");
    const target = targetLabel(first.targets[0]!);
    expect(filterOptions(trace)).toEqual({ actors: ["agent:fixture", "human:fixture"], outcomes: ["applied", "lww-dropped"], targets: [target] });
    expect(filterSteps(trace, { actors: ["agent:fixture"], targets: [target], outcomes: ["lww-dropped"] }).map((step) => step.step_id)).toEqual(["s-1"]);
  });

  it("fails closed on malformed JSON, schema, op identity, and missing projections", () => {
    const valid = JSON.parse(readFileSync(fixturePath, "utf8"));
    expect(() => loadTrace("{" )).toThrow(/could not be parsed/);
    expect(() => loadTrace({ ...valid, schema: "comfy.collab-replay/v2" })).toThrow(/unsupported schema/);
    expect(() => loadTrace({ ...valid, steps: [{ ...valid.steps[0], op_id: "changed" }] })).toThrow(/not immutable/);
    expect(() => loadTrace({ ...valid, steps: [{ ...valid.steps[0], before_projection: undefined }] })).toThrow(/before_projection/);
  });

  it("has no imports from mutation, comparator, Yjs, LiteGraph, or frontend code", () => {
    const files = ["loader.mjs", "app.mjs"].map((name) => readFileSync(resolve(root, "devtools/collab-replay-viewer", name), "utf8"));
    expect(files.join("\n")).not.toMatch(/from\s+["'][^"']*(?:applier|stamps|yjs|litegraph|ComfyUI_frontend)/i);
    expect(files.join("\n")).not.toMatch(/\b(?:applyOps|compareStampKeys|mint|Y\.Doc)\b/);
  });
});
