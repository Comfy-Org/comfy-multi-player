import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { applyOps, mint, project, readGraph, SCHEMA_VERSION, SchemaVersionError, type Op, type TopLevelSetWidgetOp, type WidgetCatalog, type WorkflowJSON } from "../src/index.js";
import { canonicalize } from "./helpers.js";
import { assertRejectedWithoutMutation } from "./rejection-test-helpers.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/dynamic-group-composite.json", import.meta.url), "utf8")) as {
  catalog: WidgetCatalog;
  workflow: WorkflowJSON;
  explicit_form_workflow: WorkflowJSON;
  op: TopLevelSetWidgetOp;
};
const { catalog } = fixture;
const ids = { loras: ["row-a", "row-c"], weights: ["row-a"] };

function workflow(shape: "array" | "object" | "declared" = "array"): WorkflowJSON {
  const result = structuredClone(shape === "declared" ? fixture.explicit_form_workflow : fixture.workflow);
  const node = result.nodes[0]!;
  node["properties"] = { ...node["properties"] as object, dynamicGroupRows: structuredClone(ids) };
  if (shape === "object") node.widgets_values = structuredClone(node["widgets_values_named"]) as Record<string, unknown>;
  return result;
}

function importOp(kind: "add_node" | "insert_workflow", value: WorkflowJSON): Op {
  const envelope = { op_id: "a".repeat(32), actor: "agent:a", base_version: 1, stamp: [1, "agent:a"] as [number, string] };
  return kind === "add_node"
    ? { ...envelope, op: kind, node_id: 1, class_type: value.nodes[0]!.type, pos: [0, 0], node: value.nodes[0]! }
    : { ...envelope, op: kind, workflow: value };
}

describe("DynamicGroup row identity reader", () => {
  it.each(["array", "object", "declared"] as const)("preserves %s row identities through projection, snapshots and re-mint", (shape) => {
    const source = workflow(shape);
    const doc = mint(source, catalog);
    const projected = project(doc, catalog);
    expect(projected.nodes[0]!["properties"]).toEqual(source.nodes[0]!["properties"]);
    const snapshot = readGraph(doc);
    expect(snapshot.nodes["1"]!.dynamicGroupRows).toEqual(ids);
    expect(Object.isFrozen(snapshot.nodes["1"]!.dynamicGroupRows!["loras"])).toBe(true);
    const reminted = mint(projected, catalog);
    expect(canonicalize(project(reminted, catalog))).toEqual(canonicalize(projected));
    reminted.destroy();
    doc.destroy();
  });

  it.each(["add_node", "insert_workflow"] as const)("preserves IDs on %s and duplicate replay", (kind) => {
    const source = workflow();
    const doc = mint({ nodes: [], links: [] }, catalog);
    const op = importOp(kind, source);
    expect(applyOps(doc, [op], catalog).outcomes[0]?.outcome).toBe("applied");
    expect(project(doc, catalog).nodes[0]!["properties"]).toEqual(source.nodes[0]!["properties"]);
    const before = Y.encodeStateAsUpdate(doc);
    applyOps(doc, [op], catalog);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    doc.destroy();
  });

  it("preserves interior IDs through definition import and field editing", () => {
    const source: WorkflowJSON = {
      nodes: [{ id: 9, type: "group-definition" }], links: [],
      definitions: { subgraphs: [{ id: "group-definition", nodes: workflow().nodes, links: [] }] },
    };
    const doc = mint(source, catalog);
    const op: Op = { ...fixture.op, path: ["9", "1"], inner_widget: "weights.0.weight", promoted: null };
    expect(applyOps(doc, [op], catalog).outcomes[0]?.outcome).toBe("applied");
    expect(project(doc, catalog)).toMatchObject({ definitions: { subgraphs: [{ nodes: [{
      properties: { dynamicGroupRows: ids }, widgets_values_named: { "weights.0.weight": 0.9 },
    }] }] } });
    doc.destroy();
  });

  it.each([
    ["null", null], ["array", []], ["not an ID list", { loras: "row-a" }],
    ["duplicate ID", { ...ids, loras: ["row-a", "row-a"] }],
    ["empty ID", { ...ids, loras: ["row-a", ""] }],
    ["nonstring ID", { ...ids, loras: ["row-a", 2] }],
    ["count mismatch", { ...ids, loras: ["row-a"] }],
    ["unknown group", { ...ids, other: [] }],
  ])("refuses %s metadata at every node ingress", (_label, raw) => {
    const source = workflow();
    (source.nodes[0]!["properties"] as Record<string, unknown>)["dynamicGroupRows"] = raw;
    expect(() => mint(source, catalog)).toThrow(/dynamicGroupRows/);
    const interior: WorkflowJSON = { nodes: [], links: [], definitions: { subgraphs: [{ id: "def", nodes: source.nodes, links: [] }] } };
    expect(() => mint(interior, catalog)).toThrow(/dynamicGroupRows/);
    for (const kind of ["add_node", "insert_workflow"] as const) {
      assertRejectedWithoutMutation({ nodes: [], links: [] }, importOp(kind, source), "invalid_node_payload", catalog);
    }
  });

  it("requires group metadata even when the producer declares the widget form", () => {
    const missing = structuredClone(catalog);
    delete missing.types["CompositeDynamicGroup"]!.dynamic_groups;
    const source = workflow("declared");
    expect(() => mint(source, missing)).toThrow(/dynamicGroupRows.*catalog/);
    assertRejectedWithoutMutation({ nodes: [], links: [] }, importOp("add_node", source), "invalid_node_payload", missing);
  });

  it("does not invent IDs or reject ordinary properties on untagged nodes", () => {
    const source = structuredClone(fixture.workflow);
    source.nodes[0]!["properties"] = { ...source.nodes[0]!["properties"] as object, unrelated: ["keep"] };
    const doc = mint(source, catalog);
    expect(canonicalize(project(doc, catalog))).toEqual(canonicalize(source));
    doc.destroy();
  });

  it("validates every inserted node before attaching any of them", () => {
    const source = workflow();
    (source.nodes[0]!["properties"] as Record<string, unknown>)["dynamicGroupRows"] = { loras: ["row-a"], weights: ids.weights };
    source.nodes.unshift({ id: 2, type: "LoadImage", widgets_values: [] });
    const before = structuredClone(source);
    assertRejectedWithoutMutation({ nodes: [], links: [] }, importOp("insert_workflow", source), "invalid_node_payload", catalog);
    expect(source).toEqual(before);
  });

  it.each(["define_subgraph", "insert_workflow"] as const)("validates interior IDs before %s attaches a definition", (kind) => {
    const source = workflow();
    const id = "12345678-1234-4123-8123-123456789abc";
    const definition = { id, name: "Rows", nodes: source.nodes, links: [] };
    const op: Op = kind === "define_subgraph"
      ? { ...fixture.op, op: kind, subgraph_id: id, subgraph_definition: definition }
      : importOp(kind, { nodes: [], links: [], definitions: { subgraphs: [definition] } });
    const doc = mint({ nodes: [], links: [] }, catalog);
    expect(applyOps(doc, [op], catalog).outcomes[0]?.outcome).toBe("applied");
    expect(project(doc, catalog)).toMatchObject({ definitions: { subgraphs: [{ nodes: [{ properties: { dynamicGroupRows: ids } }] }] } });
    doc.destroy();
    (source.nodes[0]!["properties"] as Record<string, unknown>)["dynamicGroupRows"] = { loras: ["row-a"], weights: ids.weights };
    assertRejectedWithoutMutation({ nodes: [], links: [] }, op, "apply_failed", catalog);
  });

  it("refuses a tagged count change even when a declared-form apply caller has no catalog", () => {
    const doc = mint(workflow("declared"), catalog);
    const op: Op = { ...fixture.op, widget: "loras", value: 1 };
    const trailing: Op = { ...fixture.op, op_id: "c".repeat(32), widget: "after", value: "must not land" };
    const before = Y.encodeStateAsUpdate(doc);
    expect(applyOps(doc, [op, trailing]).outcomes).toMatchObject([
      { outcome: "rejected", reason: { code: "malformed_op" } },
      { outcome: "rejected", reason: { code: "batch_aborted" } },
    ]);
    expect(applyOps(doc, [op]).outcomes[0]?.outcome).toBe("rejected");
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(doc.getMap("__applied").has(op.op_id)).toBe(false);
    expect(doc.getMap("__applied").has(trailing.op_id)).toBe(false);
    expect(applyOps(doc, [trailing]).outcomes[0]?.outcome).toBe("applied");
    doc.destroy();
  });

  it("does not treat a serializer's non-widget count residue as a row controller", () => {
    const source = workflow("declared");
    const node = source.nodes[0]!;
    node.widgets_values = structuredClone(node["widgets_values_named"]) as Record<string, unknown>;
    const form = node.widgets_values_form as { order: string[] };
    form.order = form.order.filter((name) => name !== "loras");
    expect(() => mint(source, catalog)).toThrow(/dynamicGroupRows/);
    assertRejectedWithoutMutation({ nodes: [], links: [] }, importOp("add_node", source), "invalid_node_payload", catalog);
  });

  it("preserves group names through workflow insertion without weakening other private-key scrubbing", () => {
    const source = workflow("declared");
    const entry = structuredClone(catalog.types["CompositeDynamicGroup"]!);
    entry.dynamic_groups!["__loras"] = entry.dynamic_groups!["loras"]!;
    delete entry.dynamic_groups!["loras"];
    const renamedCatalog = { types: { CompositeDynamicGroup: entry } };
    const node = source.nodes[0]!;
    const form = node.widgets_values_form as { order: string[] };
    form.order = form.order.map((name) => name.replace(/^loras(?=\.|$)/, "__loras"));
    node["properties"] = { dynamicGroupRows: { __loras: ids.loras, weights: ids.weights }, __private: "drop" };
    const doc = mint({ nodes: [], links: [] }, renamedCatalog);
    expect(applyOps(doc, [importOp("insert_workflow", source)], renamedCatalog).outcomes[0]?.outcome).toBe("applied");
    expect(project(doc, renamedCatalog).nodes[0]!["properties"]).toEqual({ dynamicGroupRows: { __loras: ids.loras, weights: ids.weights } });
    doc.destroy();
  });

  it("rejects a sparse ID array before it can acquire an undefined row identity", () => {
    const source = workflow();
    const sparse = ["row-a", "row-c"];
    delete sparse[1];
    (source.nodes[0]!["properties"] as Record<string, unknown>)["dynamicGroupRows"] = { loras: sparse, weights: ids.weights };
    expect(() => mint(source, catalog)).toThrow(/dynamicGroupRows/);
  });

  it("fails closed on a snapshot whose stored count no longer matches its IDs", () => {
    const doc = mint(workflow(), catalog);
    const node = doc.getMap<Y.Map<unknown>>("nodes").get("1")!;
    (node.get("widgets") as Y.Map<unknown>).set("loras", 1);
    const before = Y.encodeStateAsUpdate(doc);
    expect(() => readGraph(doc)).toThrow(/dynamicGroupRows/);
    expect(() => project(doc, catalog)).toThrow(/dynamicGroupRows/);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    doc.destroy();
  });

  it("preserves empty groups and saved rows above a newer maximum", () => {
    const source = workflow("object");
    const values = source.nodes[0]!.widgets_values as Record<string, unknown>;
    values["weights"] = 0;
    delete values["weights.0.seed"];
    delete values["weights.0.seed.0"];
    delete values["weights.0.weight"];
    (source.nodes[0]!["properties"] as Record<string, unknown>)["dynamicGroupRows"] = { loras: ids.loras, weights: [] };
    const smaller = structuredClone(catalog);
    smaller.types["CompositeDynamicGroup"]!.dynamic_groups!["loras"]!.max = 1;
    const doc = mint(source, smaller);
    expect(project(doc, smaller).nodes[0]!["properties"]).toEqual(source.nodes[0]!["properties"]);
    expect((project(doc, smaller).nodes[0]!.widgets_values as unknown[])[1]).toBe(2);
    doc.destroy();
  });

  it.each(["top-level", "interior", "promoted"] as const)("refuses scalar resize of an ID-bearing group on the %s path", (route) => {
    let source = workflow();
    let op: Op = { ...fixture.op, widget: "loras", value: 1 };
    if (route === "interior") {
      source = { nodes: [{ id: 9, type: "def" }], links: [], definitions: { subgraphs: [{ id: "def", nodes: source.nodes, links: [] }] } };
      op = { ...op, path: ["9", "1"], inner_widget: "loras", promoted: null };
    } else if (route === "promoted") {
      op = { ...op, promoted: { value_index: 1, instance_path: ["1"], host_widgets_values: ["head", 1] } };
    }
    assertRejectedWithoutMutation(source, op, "malformed_op", catalog);
  });

  it("keeps IDs stable for field edits and unchanged count writes in both arrival orders", () => {
    const seed = mint(workflow(), catalog);
    const bytes = Y.encodeStateAsUpdate(seed);
    const count: Op = { ...fixture.op, op_id: "b".repeat(32), widget: "loras", value: 2 };
    for (const ops of [[fixture.op, count], [count, fixture.op]]) {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, bytes);
      expect(applyOps(doc, ops, catalog).outcomes.map((outcome) => outcome.outcome)).toEqual(["applied", "applied"]);
      expect(project(doc, catalog).nodes[0]).toMatchObject({ properties: { dynamicGroupRows: ids }, widgets_values_named: { "weights.0.weight": 0.9 } });
      doc.destroy();
    }
    seed.destroy();
  });

  it("uses schema v6 and refuses an old document without relabelling", () => {
    expect(SCHEMA_VERSION).toBe(6);
    const doc = mint(workflow(), catalog);
    doc.getMap("meta").set("schema_version", 5);
    const before = Y.encodeStateAsUpdate(doc);
    expect(() => project(doc, catalog)).toThrow(SchemaVersionError);
    expect(() => readGraph(doc)).toThrow(SchemaVersionError);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    doc.destroy();
  });
});
