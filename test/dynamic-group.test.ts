import { readFileSync } from "node:fs";
import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import { applyOps, mint, project, type Op, type TopLevelSetWidgetOp, type WidgetCatalog, type WorkflowJSON } from "../src/index.js";
import { canonicalize } from "./helpers.js";
import { assertRejectedWithoutMutation } from "./rejection-test-helpers.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/dynamic-group.json", import.meta.url), "utf8")) as {
  catalog: WidgetCatalog;
  cases: Record<"empty" | "populated", WorkflowJSON>;
  editing: { ops: Op[]; expected: WorkflowJSON };
};
const { catalog, cases } = fixture;
const edit = (widget: string, value: unknown, counter = 1) => ({
  op: "set_widget", node_id: 1, widget, value,
  op_id: counter.toString(16).padStart(32, "0"), actor: "agent:a", base_version: counter, stamp: [counter, "agent:a"],
} satisfies TopLevelSetWidgetOp);

describe("DynamicGroup catalog layout", () => {
  it("replays CLI-authored field and trailing-widget edits exactly", () => {
    const doc = mint(cases.populated, catalog);
    expect(applyOps(doc, fixture.editing.ops, catalog).outcomes.map((o) => o.outcome)).toEqual(["applied", "applied"]);
    expect(canonicalize(project(doc, catalog))).toEqual(canonicalize(fixture.editing.expected));
    doc.destroy();
  });
  it.each(["empty", "populated"] as const)("round-trips the %s frontend workflow", (name) => {
    const doc = mint(cases[name], catalog);
    expect(canonicalize(project(doc, catalog))).toEqual(canonicalize(cases[name]));
    doc.destroy();
  });

  it.each([
    ["loras.1.strength", 0.7, ["head", 2, "A.safetensors", 1, true, "C.safetensors", 0.7, false, "tail"]],
    ["after", "edited", ["head", 2, "A.safetensors", 1, true, "C.safetensors", 0.5, false, "edited"]],
  ])("edits %s without shifting its siblings", (widget, value, expected) => {
    const doc = mint(cases.populated, catalog);
    const op = edit(widget as string, value);
    expect(applyOps(doc, [op], catalog).outcomes[0]?.outcome).toBe("applied");
    const node = project(doc, catalog).nodes[0]!;
    expect(node.widgets_values).toEqual(expected);
    expect(node["widgets_values_named"]).toMatchObject({ [widget as string]: value });
    const beforeRetry = Y.encodeStateAsUpdate(doc);
    applyOps(doc, [op], catalog);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(beforeRetry);
    doc.destroy();
  });

  it("reads defaults for newly shown rows without shifting the trailing widget", () => {
    const doc = mint(cases.empty, catalog);
    expect(applyOps(doc, [edit("loras", 1)], catalog).outcomes[0]?.outcome).toBe("applied");
    expect(project(doc, catalog).nodes[0]!.widgets_values).toEqual(["first", 1, "A.safetensors", 1, true, "last"]);
    doc.destroy();
  });

  it("keeps hidden row values when the count changes", () => {
    const doc = mint(cases.populated, catalog);
    applyOps(doc, [edit("loras", 0)], catalog);
    expect(project(doc, catalog).nodes[0]!.widgets_values).toEqual(["head", 0, "tail"]);
    applyOps(doc, [edit("loras", 2, 2)], catalog);
    expect(project(doc, catalog).nodes[0]!.widgets_values).toEqual(cases.populated.nodes[0]!.widgets_values);
    doc.destroy();
  });

  it("converges when the row count and a row value arrive in either order", () => {
    const seed = mint(cases.empty, catalog);
    const snapshot = Y.encodeStateAsUpdate(seed);
    const ops = [edit("loras", 1), edit("loras.0.strength", 0.7, 2)];
    for (const ordered of [ops, [...ops].reverse()]) {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, snapshot);
      expect(applyOps(doc, ordered, catalog).outcomes.map((o) => o.outcome)).toEqual(["applied", "applied"]);
      expect(project(doc, catalog).nodes[0]!.widgets_values).toEqual(["first", 1, "A.safetensors", 0.7, true, "last"]);
      doc.destroy();
    }
    seed.destroy();
  });

  it("keeps named values coherent when a row edit races with hiding that row", () => {
    const seed = mint(cases.populated, catalog);
    const snapshot = Y.encodeStateAsUpdate(seed);
    const ops = [edit("loras", 0), edit("loras.1.strength", 0.7, 2)];
    for (const ordered of [ops, [...ops].reverse()]) {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, snapshot);
      expect(applyOps(doc, ordered, catalog).outcomes.map((o) => o.outcome)).toEqual(["applied", "applied"]);
      applyOps(doc, [edit("loras", 2, 3)], catalog);
      const node = project(doc, catalog).nodes[0]!;
      expect(node.widgets_values).toEqual(["head", 2, "A.safetensors", 1, true, "C.safetensors", 0.7, false, "tail"]);
      expect(node["widgets_values_named"]).toMatchObject({ "loras.1.strength": 0.7 });
      doc.destroy();
    }
    seed.destroy();
  });

  it.each([-1, 1.5, "2", 1_000_000])("refuses unsafe row count %s before writing", (count) => {
    assertRejectedWithoutMutation(cases.populated, edit("loras", count), "malformed_op", catalog,
      edit("after", "must not run", 2));
  });

  it("refuses a malformed saved count before minting a misaligned document", () => {
    const workflow = structuredClone(cases.populated);
    (workflow.nodes[0]!.widgets_values as unknown[])[1] = -1;
    expect(() => mint(workflow, catalog)).toThrow(/row count/);
  });

  it("preserves rows above a newer catalog's advertised maximum", () => {
    const smaller = structuredClone(catalog);
    smaller.types["DevToolsNodeWithDynamicGroup"]!.dynamic_groups!["loras"]!.max = 1;
    const doc = mint(cases.populated, smaller);
    expect(project(doc, smaller).nodes[0]!.widgets_values).toEqual(cases.populated.nodes[0]!.widgets_values);
    applyOps(doc, [edit("loras", 0)], smaller);
    expect(project(doc, smaller).nodes[0]!.widgets_values).toEqual(["head", 0, "tail"]);
    doc.destroy();
  });

  it("does not duplicate the default minimum rows in the catalog order", () => {
    const minimum = structuredClone(catalog);
    const entry = minimum.types["DevToolsNodeWithDynamicGroup"]!;
    entry.dynamic_groups!["loras"]!.min = 1;
    entry.widget_order = ["before", "loras", "loras.0.lora_name", "loras.0.strength", "loras.0.enabled", "after"];
    const doc = mint(cases.populated, minimum);
    expect(project(doc, minimum).nodes[0]!.widgets_values).toEqual(cases.populated.nodes[0]!.widgets_values);
    doc.destroy();
  });

  it("respects an explicit widget form and refuses to silently invalidate its order", () => {
    const workflow = structuredClone(cases.populated);
    workflow.nodes[0]!["widgets_values_form"] = { order: [
      "before", "loras", "loras.0.lora_name", "loras.0.strength", "loras.0.enabled",
      "loras.1.lora_name", "loras.1.strength", "loras.1.enabled", "after",
    ] };
    const doc = mint(workflow, catalog);
    expect(applyOps(doc, [edit("loras.1.strength", 0.7)], catalog).outcomes[0]?.outcome).toBe("applied");
    expect(project(doc, catalog).nodes[0]!.widgets_values).toEqual([
      "head", 2, "A.safetensors", 1, true, "C.safetensors", 0.7, false, "tail",
    ]);
    assertRejectedWithoutMutation(workflow, edit("loras", 0), "malformed_op", catalog,
      edit("after", "must not run", 2));
    doc.destroy();
  });

  it("edits interior rows and rejects invalid interior counts without mutation", () => {
    const workflow: WorkflowJSON = {
      nodes: [{ id: 9, type: "group-definition" }], links: [],
      definitions: { subgraphs: [{ id: "group-definition", nodes: cases.populated.nodes, links: [] }] },
    };
    const op: Op = { ...edit("loras.1.strength", 0.7), path: ["9", "1"], inner_widget: "loras.1.strength" };
    const doc = mint(workflow, catalog);
    expect(applyOps(doc, [op], catalog).outcomes[0]?.outcome).toBe("applied");
    const definitions = project(doc, catalog)["definitions"] as { subgraphs: WorkflowJSON[] };
    expect(definitions.subgraphs[0]!.nodes[0]!.widgets_values).toEqual([
      "head", 2, "A.safetensors", 1, true, "C.safetensors", 0.7, false, "tail",
    ]);
    const invalid: Op = { ...edit("loras", -1), path: ["9", "1"], inner_widget: "loras" };
    assertRejectedWithoutMutation(workflow, invalid, "malformed_op", catalog, { ...op, op_id: "b".repeat(32) });
    doc.destroy();
  });
});
