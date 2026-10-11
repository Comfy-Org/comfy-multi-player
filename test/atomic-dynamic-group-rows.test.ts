import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { admitDynamicGroupRowOp, applyOps, compact, mint, project, readGraph, stampKey, compareStampKeys, type DynamicGroupRowOp, type Op, type WidgetCatalog, type WorkflowJSON } from "../src/index.js";
import { canonicalize } from "./helpers.js";
import { assertRejectedWithoutMutation } from "./rejection-test-helpers.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/dynamic-group-composite.json", import.meta.url), "utf8")) as { catalog: WidgetCatalog; workflow: WorkflowJSON };
const catalog: WidgetCatalog = { types: { ...fixture.catalog.types, FloatLiteral: { widget_order: ["value"] } } };
const env = (id: number) => ({ op_id: id.toString(16).padStart(32, "0"), actor: "agent:a", base_version: id, stamp: [id, "agent:a"] as [number, string] });
const rowId = (id: number, ordinal = 0) => `row:${env(id).op_id}:${String(ordinal)}`;
const values = (name: string, strength: number, enabled = true) => ({ lora_name: `${name}.safetensors`, strength, enabled });

function workflow(linked = false): WorkflowJSON {
  const result = structuredClone(fixture.workflow);
  const node = result.nodes[0]!;
  node.widgets_values = {
    ...(node["widgets_values_named"] as Record<string, unknown>), loras: 3,
    ...Object.fromEntries([values("A", 0.1), values("B", 0.2), values("C", 0.3, false)].flatMap((row, index) =>
      Object.entries(row).map(([field, value]) => [`loras.${String(index)}.${field}`, value]))),
  };
  node["widgets_values_named"] = structuredClone(node.widgets_values);
  node["properties"] = { dynamicGroupRows: { loras: ["A", "B", "C"], weights: ["W"] } };
  node.inputs = [
    { name: "model", type: "MODEL", link: null },
    ...[0, 1, 2].map((index) => ({ name: `loras.${String(index)}.strength`, type: "FLOAT", widget: { name: `loras.${String(index)}.strength` }, link: linked ? 21 + index : null })),
    { name: "after", type: "STRING", widget: { name: "after" }, link: null },
  ];
  if (linked) {
    for (const [index, strength] of [0.1, 0.2, 0.3].entries()) {
      result.nodes.push({ id: 101 + index, type: "FloatLiteral", inputs: [], outputs: [{ name: "FLOAT", type: "FLOAT", links: [21 + index] }], widgets_values: [strength] });
      result.links.push([21 + index, 101 + index, 0, 1, 1 + index, "FLOAT"]);
    }
  }
  return result;
}

const address = { node_id: 1, node_incarnation: "0", group: "loras" };
const remove = (ids: string[], id = 1): Extract<DynamicGroupRowOp, { op: "dynamic_group_delete_rows" }> => ({ ...env(id), ...address, op: "dynamic_group_delete_rows", row_ids: ids });
const edit = (row: string, fields: Record<string, unknown>, id = 2): Extract<DynamicGroupRowOp, { op: "dynamic_group_set_row" }> => ({ ...env(id), ...address, op: "dynamic_group_set_row", row_id: row, values: fields });
const insert = (after: string | null, rows: Record<string, unknown>[], id = 3): Extract<DynamicGroupRowOp, { op: "dynamic_group_insert_rows" }> => ({ ...env(id), ...address, op: "dynamic_group_insert_rows", after_row_id: after, rows });
const connect = (row: string, id = 7): Extract<DynamicGroupRowOp, { op: "dynamic_group_connect" }> => ({ ...env(id), ...address, op: "dynamic_group_connect", row_id: row, field: "strength", from_node: 103, from_slot: 0, link_id: 31, link_type: "FLOAT", input_type: "FLOAT" });

function promotedWorkflow(nested: boolean): WorkflowJSON {
  const source = workflow();
  const leaf = source.nodes[0]!;
  leaf.inputs = [0, 1, 2].map((index) => ({ name: `loras.${String(index)}.strength`, type: "FLOAT", widget: { name: `loras.${String(index)}.strength` }, link: 11 + index }));
  const def = {
    id: "inner-definition", inputNode: { id: -10 }, outputNode: { id: -20 },
    inputs: [0, 1, 2].map((index) => ({ id: `port-${String(index)}`, name: `loras.${String(index)}.strength`, type: "FLOAT", linkIds: [11 + index] })),
    outputs: [], nodes: [leaf], widgets: [0, 1, 2].map((index) => ({ id: 1, name: `loras.${String(index)}.strength` })),
    links: [0, 1, 2].map((index) => ({ id: 11 + index, origin_id: -10, origin_slot: index, target_id: 1, target_slot: index, type: "FLOAT" })),
  };
  const host = (id: number, type: string) => ({ id, type,
    inputs: [0, 1, 2].map((index) => ({ id: `port-${String(index)}`, name: `loras.${String(index)}.strength`, type: "FLOAT", widget: { name: `loras.${String(index)}.strength` }, link: null as number | null })), outputs: [],
    widgets_values: [0.4, 0.5, 0.6], properties: { proxyWidgets: [0, 1, 2].map((index) => [nested && id === 9 ? "2" : "1", `loras.${String(index)}.strength`]) },
  });
  const rootHost = host(9, nested ? "outer-definition" : "inner-definition");
  rootHost.inputs.forEach((slot, index) => { slot.link = 21 + index; });
  const outerHost = host(2, "inner-definition");
  outerHost.inputs.forEach((slot, index) => { slot.link = 31 + index; });
  const outer = {
    id: "outer-definition", inputNode: { id: -10 }, outputNode: { id: -20 }, inputs: structuredClone(def.inputs).map((slot, index) => ({ ...slot, linkIds: [31 + index] })), outputs: [], nodes: [outerHost],
    widgets: [0, 1, 2].map((index) => ({ id: 2, name: `loras.${String(index)}.strength` })),
    links: [0, 1, 2].map((index) => ({ id: 31 + index, origin_id: -10, origin_slot: index, target_id: 2, target_slot: index, type: "FLOAT" })),
  };
  return {
    nodes: [rootHost, ...[0, 1, 2].map((index) => ({ id: 101 + index, type: "FloatLiteral", inputs: [], outputs: [{ name: "FLOAT", type: "FLOAT", links: [21 + index] }], widgets_values: [0.4 + index / 10] }))],
    links: [0, 1, 2].map((index) => [21 + index, 101 + index, 0, 9, index, "FLOAT"]),
    definitions: { subgraphs: nested ? [def, outer] : [def] },
  };
}

function target(doc: Y.Doc) {
  return project(doc, catalog).nodes.find((node) => node.id === 1)!;
}

describe("atomic DynamicGroup row operations", () => {
  it("deletes a middle row while preserving surviving values and siblings", () => {
    const doc = mint(workflow(), catalog);
    expect(applyOps(doc, [remove(["B"])], catalog).outcomes[0]?.outcome).toBe("applied");
    const node = target(doc);
    expect(node["properties"]).toEqual({ dynamicGroupRows: { loras: ["A", "C"], weights: ["W"] } });
    expect(node["widgets_values_named"]).toMatchObject({ loras: 2, "loras.0.lora_name": "A.safetensors", "loras.1.lora_name": "C.safetensors", "loras.1.strength": 0.3, "loras.1.enabled": false, "weights.0.seed": 5, "weights.0.seed.0": "fixed", "mode.steps": 7, after: "tail" });
    expect(node["widgets_values_named"]).not.toHaveProperty("loras.2.strength");
    expect(readGraph(doc).nodes["1"]!.widgets).toMatchObject({ loras: 2, "loras.1.strength": 0.3, "loras.1.enabled": false });
    doc.destroy();
  });

  it("converges a middle deletion and a surviving-row edit in both orders", () => {
    const seed = mint(workflow(), catalog);
    const snapshot = Y.encodeStateAsUpdate(seed);
    const ops = [remove(["B"]), edit("C", { strength: 0.7 })];
    for (const order of [ops, [...ops].reverse()]) {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, snapshot);
      expect(applyOps(doc, order, catalog).outcomes.map((outcome) => outcome.outcome)).toEqual(["applied", "applied"]);
      expect(target(doc)["widgets_values_named"]).toMatchObject({ loras: 2, "loras.1.lora_name": "C.safetensors", "loras.1.strength": 0.7 });
      const before = Y.encodeStateAsUpdate(doc);
      applyOps(doc, order, catalog);
      expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
      doc.destroy();
    }
    seed.destroy();
  });

  it("does not apply a deleted-row edit to a newly inserted row at its old position", () => {
    const seed = mint(workflow(), catalog);
    const snapshot = Y.encodeStateAsUpdate(seed);
    const ops = [remove(["B"]), edit("B", { strength: 999 }), insert("A", [values("D", 0.4)])];
    const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    let expected: unknown;
    for (const indices of orders) {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, snapshot);
      expect(applyOps(doc, indices.map((index) => ops[index]!), catalog).outcomes.every((outcome) => outcome.outcome !== "rejected"), indices.join(",")).toBe(true);
      expect(target(doc)["properties"]).toMatchObject({ dynamicGroupRows: { loras: ["A", rowId(3), "C"] } });
      expect(target(doc)["widgets_values_named"]).toMatchObject({ "loras.1.lora_name": "D.safetensors", "loras.1.strength": 0.4, "loras.2.strength": 0.3 });
      const actual = canonicalize(project(doc, catalog));
      if (expected === undefined) expected = actual;
      else expect(actual, indices.join(",")).toEqual(expected);
      doc.destroy();
    }
    expect(orders).toHaveLength(6);
    seed.destroy();
  });

  it("orders concurrent insertions at the same anchor by their creator stamps", () => {
    const wide = structuredClone(catalog);
    wide.types["CompositeDynamicGroup"]!.dynamic_groups!["loras"]!.max = 6;
    const seed = mint(workflow(), wide);
    const snapshot = Y.encodeStateAsUpdate(seed);
    const ops = [insert("A", [values("D", 0.4), values("E", 0.5)], 3), insert("A", [values("F", 0.6)], 4)];
    for (const order of [ops, [...ops].reverse()]) {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, snapshot);
      for (const op of order) {
        admitDynamicGroupRowOp(doc, op as DynamicGroupRowOp, wide);
        expect(applyOps(doc, [op], wide).outcomes[0]?.outcome).toBe("applied");
      }
      expect(target(doc)["properties"]).toMatchObject({ dynamicGroupRows: { loras: ["A", rowId(4), rowId(3), rowId(3, 1), "B", "C"] } });
      doc.destroy();
    }
    seed.destroy();
  });

  it("retains deletion and field registers when they arrive before their insertion", () => {
    const seed = mint(workflow(), catalog);
    const snapshot = Y.encodeStateAsUpdate(seed);
    const ops = [insert("A", [values("D", 0.4)], 3), edit(rowId(3), { strength: 0.8 }, 4), remove([rowId(3)], 5)];
    for (const order of [ops, [...ops].reverse()]) {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, snapshot);
      expect(applyOps(doc, order, catalog).outcomes.every((outcome) => outcome.outcome !== "rejected")).toBe(true);
      expect(target(doc)["properties"]).toMatchObject({ dynamicGroupRows: { loras: ["A", "B", "C"] } });
      expect(target(doc)["widgets_values_named"]).toMatchObject({ "loras.1.lora_name": "B.safetensors", "loras.2.strength": 0.3 });
      doc.destroy();
    }
    seed.destroy();
  });

  it("merges independent fields and resolves the overlapping field by LWW", () => {
    const seed = mint(workflow(), catalog);
    const snapshot = Y.encodeStateAsUpdate(seed);
    const ops = [edit("C", { strength: 0.7, enabled: true }, 2), edit("C", { lora_name: "new.safetensors", strength: 0.9 }, 3)];
    for (const order of [ops, [...ops].reverse()]) {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, snapshot);
      expect(applyOps(doc, order, catalog).outcomes.every((outcome) => outcome.outcome !== "rejected")).toBe(true);
      expect(target(doc)["widgets_values_named"]).toMatchObject({ "loras.2.lora_name": "new.safetensors", "loras.2.strength": 0.9, "loras.2.enabled": true });
      doc.destroy();
    }
    seed.destroy();
  });

  it("validates all fields before any part of a row edit is written", () => {
    const source = workflow();
    assertRejectedWithoutMutation(source, edit("C", { strength: 0.9, unknown: "must not land" }), "malformed_op", catalog);
    expect(source.nodes[0]!.widgets_values).toMatchObject({ "loras.2.strength": 0.3 });
  });

  it("reindexes surviving connections and removes only the deleted row's links", () => {
    const doc = mint(workflow(true), catalog);
    expect(applyOps(doc, [remove(["B"])], catalog).outcomes[0]?.outcome).toBe("applied");
    const result = project(doc, catalog);
    expect(result.links).toEqual([[21, 101, 0, 1, 1, "FLOAT"], [23, 103, 0, 1, 2, "FLOAT"]]);
    expect(target(doc).inputs).toEqual([
      { name: "model", type: "MODEL", link: null },
      { name: "loras.0.strength", type: "FLOAT", widget: { name: "loras.0.strength" }, link: 21 },
      { name: "loras.1.strength", type: "FLOAT", widget: { name: "loras.1.strength" }, link: 23 },
      { name: "after", type: "STRING", widget: { name: "after" }, link: null },
    ]);
    expect(result.nodes.find((node) => node.id === 102)!.outputs).toEqual([{ name: "FLOAT", type: "FLOAT", links: [] }]);
    expect(readGraph(doc).links).toEqual({ "21": result.links[0], "23": result.links[1] });
    doc.destroy();
  });

  it("carries row anchors and tombstones through compaction and encoded reconnect", () => {
    const doc = mint(workflow(true), catalog);
    const ops = [insert("B", [values("D", 0.4)], 3), remove(["B"], 4)];
    expect(applyOps(doc, ops, catalog).outcomes.every((outcome) => outcome.outcome !== "rejected")).toBe(true);
    const checkpoint = compact(doc, catalog);
    expect(canonicalize(project(checkpoint, catalog))).toEqual(canonicalize(project(doc, catalog)));
    const fork = new Y.Doc();
    Y.applyUpdate(fork, Y.encodeStateAsUpdate(checkpoint));
    expect(applyOps(fork, [edit("C", { strength: 0.8 }, 5)], catalog).outcomes[0]?.outcome).toBe("applied");
    expect(target(fork)["properties"]).toMatchObject({ dynamicGroupRows: { loras: ["A", rowId(3), "C"] } });
    expect(target(fork)["widgets_values_named"]).toMatchObject({ "loras.1.lora_name": "D.safetensors", "loras.2.strength": 0.8 });
    expect(applyOps(fork, [insert("B", [values("E", 0.5)], 6)], catalog).outcomes[0]?.outcome).toBe("applied");
    expect(target(fork)["properties"]).toMatchObject({ dynamicGroupRows: { loras: ["A", rowId(6), rowId(3), "C"] } });
    checkpoint.destroy();
    fork.destroy();
    doc.destroy();
  });

  it("connects a surviving row by ID in either order with a middle deletion", () => {
    const seed = mint(workflow(true), catalog);
    const bytes = Y.encodeStateAsUpdate(seed);
    const ops = [remove(["B"]), connect("C")];
    for (const order of [ops, [...ops].reverse()]) {
      const doc = new Y.Doc(); Y.applyUpdate(doc, bytes);
      expect(applyOps(doc, order, catalog).outcomes.every((result) => result.outcome !== "rejected")).toBe(true);
      expect(project(doc, catalog).links).toEqual([[21, 101, 0, 1, 1, "FLOAT"], [31, 103, 0, 1, 2, "FLOAT"]]);
      expect(target(doc).inputs![2]).toMatchObject({ name: "loras.1.strength", link: 31 });
      doc.destroy();
    }
    seed.destroy();
  });

  it("does not attach a deleted-row connect to its successor", () => {
    const seed = mint(workflow(true), catalog);
    const bytes = Y.encodeStateAsUpdate(seed);
    const ops = [remove(["B"]), connect("B")];
    for (const order of [ops, [...ops].reverse()]) {
      const doc = new Y.Doc(); Y.applyUpdate(doc, bytes);
      expect(applyOps(doc, order, catalog).outcomes.every((result) => result.outcome !== "rejected")).toBe(true);
      expect(project(doc, catalog).links).toEqual([[21, 101, 0, 1, 1, "FLOAT"], [23, 103, 0, 1, 2, "FLOAT"]]);
      doc.destroy();
    }
    seed.destroy();
  });

  it.each([false, true])("removes promotions and external links through nested=%s while preserving surviving host values", (nested) => {
    const doc = mint(promotedWorkflow(nested), catalog);
    const op = { ...remove(["B"]), path: nested ? ["9", "2"] : ["9"] } as Op;
    expect(applyOps(doc, [op], catalog).outcomes[0]?.outcome).toBe("applied");
    const result = project(doc, catalog);
    expect(result.links).toEqual([[21, 101, 0, 9, 0, "FLOAT"], [23, 103, 0, 9, 1, "FLOAT"]]);
    expect(result.nodes.find((node) => node.id === 9)).toMatchObject({ widgets_values: [0.4, 0.6], inputs: [{ name: "loras.0.strength", link: 21 }, { name: "loras.1.strength", link: 23 }] });
    const definitions = result.definitions!.subgraphs as Record<string, unknown>[];
    for (const definition of definitions) {
      expect(definition["inputs"]).toEqual([
        { id: "port-0", name: "loras.0.strength", type: "FLOAT", linkIds: [definition["id"] === "inner-definition" ? 11 : 31] },
        { id: "port-2", name: "loras.1.strength", type: "FLOAT", linkIds: [definition["id"] === "inner-definition" ? 13 : 33] },
      ]);
      expect(definition["widgets"]).toEqual([{ id: definition["id"] === "inner-definition" ? 1 : 2, name: "loras.0.strength" }, { id: definition["id"] === "inner-definition" ? 1 : 2, name: "loras.1.strength" }]);
    }
    expect(readGraph(doc).nodes["9"]!["__widgets_opaque"]).toEqual([0.4, 0.6]);
    doc.destroy();
  });

  it.each([false, true])("edits a surviving promoted value by row ID through nested=%s in either order", (nested) => {
    const seed = mint(promotedWorkflow(nested), catalog);
    const bytes = Y.encodeStateAsUpdate(seed);
    const path = nested ? ["9", "2"] : ["9"];
    const ops = [{ ...remove(["B"]), path }, { ...edit("C", { strength: 0.9 }, 8), path, host_path: ["9"], host_incarnation: "0" }] as Op[];
    for (const order of [ops, [...ops].reverse()]) {
      const doc = new Y.Doc(); Y.applyUpdate(doc, bytes);
      expect(applyOps(doc, order, catalog).outcomes.every((result) => result.outcome !== "rejected")).toBe(true);
      expect(project(doc, catalog).nodes.find((node) => node.id === 9)!.widgets_values).toEqual([0.4, 0.9]);
      doc.destroy();
    }
    seed.destroy();
  });

  it("checks current min/max during admission without changing the document", () => {
    const bounded = structuredClone(catalog);
    bounded.types["CompositeDynamicGroup"]!.dynamic_groups!["loras"]!.min = 2;
    const doc = mint(workflow(), bounded);
    const before = Y.encodeStateAsUpdate(doc);
    const roots = [...doc.share.keys()];
    expect(() => admitDynamicGroupRowOp(doc, insert("A", [values("D", 0.4)]) as DynamicGroupRowOp, bounded)).toThrow(/max rows/);
    expect(() => admitDynamicGroupRowOp(doc, remove(["A", "B"]) as DynamicGroupRowOp, bounded)).toThrow(/min rows/);
    expect(() => admitDynamicGroupRowOp(doc, remove(["B"]) as DynamicGroupRowOp, bounded)).not.toThrow();
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect([...doc.share.keys()]).toEqual(roots);
    doc.destroy();
  });

  it("replays admitted growth and shrink without rechecking transient receiver counts", () => {
    const seed = mint(workflow(), catalog);
    const removed = remove(["B"]);
    const added = insert("A", [values("D", 0.4)]);
    const original = Y.encodeStateAsUpdate(seed);
    admitDynamicGroupRowOp(seed, removed as DynamicGroupRowOp, catalog);
    applyOps(seed, [removed], catalog);
    admitDynamicGroupRowOp(seed, added as DynamicGroupRowOp, catalog);
    applyOps(seed, [added], catalog);
    const fork = new Y.Doc(); Y.applyUpdate(fork, original);
    expect(applyOps(fork, [added, removed], catalog).outcomes.every((value) => value.outcome !== "rejected")).toBe(true);
    expect(canonicalize(project(fork, catalog))).toEqual(canonicalize(project(seed, catalog)));
    fork.destroy(); seed.destroy();
  });

  it("does not use a definition's socket ordinal as a promoted widget-value ordinal", () => {
    const source = promotedWorkflow(false);
    const definition = source.definitions!.subgraphs![0] as Record<string, unknown>;
    (definition["inputs"] as unknown[]).unshift({ id: "model-port", name: "model", type: "MODEL", linkIds: [] });
    (definition["links"] as Record<string, unknown>[]).forEach((link) => { link["origin_slot"] = Number(link["origin_slot"]) + 1; });
    const host = source.nodes[0]!;
    host.inputs!.unshift({ id: "model-port", name: "model", type: "MODEL", link: null });
    (source.links as unknown[][]).forEach((link) => { link[4] = Number(link[4]) + 1; });
    const doc = mint(source, catalog);
    const op = { ...edit("C", { strength: 0.9 }, 8), path: ["9"], host_path: ["9"], host_incarnation: "0" } as Op;
    expect(applyOps(doc, [op], catalog).outcomes[0]?.outcome).toBe("applied");
    expect(project(doc, catalog).nodes.find((node) => node.id === 9)!.widgets_values).toEqual([0.4, 0.5, 0.9]);
    doc.destroy();
  });

  it("refuses a numeric address that can move with row deletion but retains the fixed socket prefix", () => {
    const source = workflow(true);
    const numeric: Op = { ...env(8), op: "connect", from_node: 101, from_slot: 0, to_node: 1, to_slot: 2, link_id: 31, link_type: "FLOAT" };
    assertRejectedWithoutMutation(source, numeric, "malformed_op", catalog);
    const doc = mint(source, catalog);
    expect(applyOps(doc, [{ ...numeric, to_slot: 0 }], catalog).outcomes[0]?.outcome).toBe("applied");
    doc.destroy();
  });

  it.each([false, true])("refuses positional promoted writes on row-controlled hosts through nested=%s", (nested) => {
    const source = promotedWorkflow(nested);
    const op: Op = { ...env(8), op: "set_widget", node_id: 9, widget: "loras.1.strength", value: 9,
      promoted: { value_index: 1, host_widgets_values: [0.4, 0.5, 0.6] } };
    assertRejectedWithoutMutation(source, op, "malformed_op", catalog);
  });

  it("does not materialize a converted socket when disconnecting an unconverted widget", () => {
    const doc = mint(workflow(), catalog);
    const op = { ...env(8), ...address, op: "dynamic_group_disconnect", row_id: "C", field: "enabled" } as Op;
    expect(applyOps(doc, [op], catalog).outcomes[0]?.outcome).not.toBe("rejected");
    expect(target(doc).inputs).toHaveLength(5);
    expect(target(doc).inputs!.some((slot) => (slot as Record<string, unknown>)["name"] === "loras.2.enabled")).toBe(false);
    doc.destroy();
  });

  it("restores a row connection after its source is removed and re-added, in both causal orders", () => {
    const seed = mint(workflow(true), catalog);
    const bytes = Y.encodeStateAsUpdate(seed);
    const deletion: Op = { ...env(8), op: "delete_node", node_id: 103, removed_links: [] };
    const source = workflow(true).nodes.find((node) => node.id === 103)!;
    const addition: Op = { ...env(9), op: "add_node", node_id: 103, class_type: "FloatLiteral", pos: [0, 0], node: source };
    for (const ops of [[connect("C"), deletion, addition], [deletion, connect("C"), addition]]) {
      const doc = new Y.Doc(); Y.applyUpdate(doc, bytes);
      expect(applyOps(doc, ops, catalog).outcomes.every((result) => result.outcome !== "rejected")).toBe(true);
      expect(project(doc, catalog).links).toContainEqual([31, 103, 0, 1, 3, "FLOAT"]);
      expect(target(doc).inputs![3]).toMatchObject({ name: "loras.2.strength", link: 31 });
      const slot = (doc.getMap("nodes").get("1") as Y.Map<unknown>).get("inputs") as Y.Array<Y.Map<unknown>>;
      expect(slot.get(3).has("link")).toBe(false);
      doc.destroy();
    }
    seed.destroy();
  });

  it("does not restore a deleted row when its source is re-added", () => {
    const doc = mint(workflow(true), catalog);
    const source = workflow(true).nodes.find((node) => node.id === 103)!;
    const ops: Op[] = [connect("C"), remove(["C"], 8), { ...env(9), op: "delete_node", node_id: 103, removed_links: [] }, { ...env(10), op: "add_node", node_id: 103, class_type: "FloatLiteral", pos: [0, 0], node: source }];
    expect(applyOps(doc, ops, catalog).outcomes.every((result) => result.outcome !== "rejected")).toBe(true);
    expect(project(doc, catalog).links.some((link) => (link as unknown[])[0] === 31)).toBe(false);
    expect(target(doc).inputs).toHaveLength(4);
    doc.destroy();
  });

  it("moves a normalized link ID between rows without resurrecting a stale slot pointer", () => {
    const seed = mint(workflow(true), catalog);
    const bytes = Y.encodeStateAsUpdate(seed);
    const ops = [{ ...connect("A", 7), link_id: "31" }, connect("C", 8)] as Op[];
    for (const order of [ops, [...ops].reverse()]) {
      const doc = new Y.Doc(); Y.applyUpdate(doc, bytes);
      expect(applyOps(doc, order, catalog).outcomes.every((result) => result.outcome !== "rejected")).toBe(true);
      expect(project(doc, catalog).links).toEqual([[22, 102, 0, 1, 2, "FLOAT"], [31, 103, 0, 1, 3, "FLOAT"]]);
      expect(target(doc).inputs![1]).toMatchObject({ link: null });
      expect(target(doc).inputs![3]).toMatchObject({ link: 31 });
      doc.destroy();
    }
    seed.destroy();
  });

  it("takes the row-field winner from the creator stamp rather than the transport envelope", () => {
    const seed = mint(workflow(), catalog);
    const bytes = Y.encodeStateAsUpdate(seed);
    const low = { ...edit("C", { strength: 0.8 }, 2), base_version: 100, stamp: [1, "agent:a"] } as Op;
    const high = { ...edit("C", { strength: 0.9 }, 3), base_version: 1, stamp: [2, "agent:a"] } as Op;
    expect(low.base_version).toBeGreaterThan(high.base_version);
    expect(compareStampKeys(stampKey(low), stampKey(high))).toBe(-1);
    for (const ops of [[low, high], [high, low]]) {
      const doc = new Y.Doc(); Y.applyUpdate(doc, bytes);
      expect(applyOps(doc, ops, catalog).outcomes.every((result) => result.outcome !== "rejected")).toBe(true);
      expect(target(doc)["widgets_values_named"]).toMatchObject({ "loras.2.strength": 0.9 });
      doc.destroy();
    }
    seed.destroy();
  });

  it.each([
    { ...connect("C"), from_node: undefined },
    { ...connect("C"), link_id: Infinity },
    { ...insert("A", [values("D", 0.4)]), rows: new Array(1) },
    { ...remove(["B"]), row_ids: new Array(1) },
    { ...edit("C", { strength: 0.9 }), stamp: [] },
    { ...edit("C", { strength: 0.9 }), stamp: undefined },
  ])("refuses malformed row payloads before writes: $op", (op) => {
    assertRejectedWithoutMutation(workflow(true), op as Op, "malformed_op", catalog);
  });

  it("preflights missing source slots and incomplete host bindings during readonly admission", () => {
    const doc = mint(workflow(true), catalog);
    const before = Y.encodeStateAsUpdate(doc);
    expect(() => admitDynamicGroupRowOp(doc, { ...connect("C"), from_slot: 9 } as DynamicGroupRowOp, catalog)).toThrow(/output slot/);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    doc.destroy();
    const promoted = mint(promotedWorkflow(false), catalog);
    const bytes = Y.encodeStateAsUpdate(promoted);
    const op = { ...edit("C", { strength: 0.9, enabled: false }, 8), path: ["9"], host_path: ["9"], host_incarnation: "0" } as DynamicGroupRowOp;
    expect(() => admitDynamicGroupRowOp(promoted, op, catalog)).toThrow(/not materialized/);
    expect(Y.encodeStateAsUpdate(promoted)).toEqual(bytes);
    promoted.destroy();
  });

  it("keeps the declared widget form and ordered sidecar aligned across middle-row deletion", () => {
    const source = workflow();
    const values = source.nodes[0]!.widgets_values as Record<string, unknown>;
    source.nodes[0]!["widgets_values_form"] = { order: Object.keys(values) };
    source.nodes[0]!["widgets_values_ordered"] = Object.entries(values).map(([name, value]) => ({ name, occurrence: 0, value, extension_entry: name }));
    const doc = mint(source, catalog);
    expect(applyOps(doc, [remove(["B"])], catalog).outcomes[0]?.outcome).toBe("applied");
    const result = target(doc);
    expect(result["widgets_values_ordered"]).toEqual(expect.arrayContaining([
      { name: "loras", occurrence: 0, value: 2, extension_entry: "loras" },
      { name: "loras.1.strength", occurrence: 0, value: 0.3, extension_entry: "loras.2.strength" },
      { name: "after", occurrence: 0, value: "tail", extension_entry: "after" },
    ]));
    expect((result["widgets_values_ordered"] as Record<string, unknown>[]).some((entry) => entry["name"] === "loras.2.strength")).toBe(false);
    expect(canonicalize(project(mint(project(doc, catalog), catalog), catalog))).toEqual(canonicalize(project(doc, catalog)));
    doc.destroy();
  });

  it("retains an independent second group's row edits when the first group is structurally changed", () => {
    const doc = mint(workflow(), catalog);
    const other = { ...edit("W", { seed: 99, "seed.0": "randomize" }, 8), group: "weights" } as Op;
    expect(applyOps(doc, [remove(["B"]), other], catalog).outcomes.map((result) => result.outcome)).toEqual(["applied", "applied"]);
    expect(target(doc)["widgets_values_named"]).toMatchObject({ loras: 2, weights: 1, "weights.0.seed": 99, "weights.0.seed.0": "randomize", "weights.0.weight": 0.25, "mode.steps": 7 });
    doc.destroy();
  });

  it("retires a pending row connection when its source is absent during disconnect", () => {
    const doc = mint(workflow(true), catalog);
    const disconnect = { ...env(9), ...address, op: "dynamic_group_disconnect", row_id: "C", field: "strength" } as Op;
    const source = workflow(true).nodes.find((node) => node.id === 103)!;
    const ops: Op[] = [connect("C"), { ...env(8), op: "delete_node", node_id: 103, removed_links: [] }, disconnect, { ...env(10), op: "add_node", node_id: 103, class_type: "FloatLiteral", pos: [0, 0], node: source }];
    expect(applyOps(doc, ops, catalog).outcomes.every((result) => result.outcome !== "rejected")).toBe(true);
    expect(project(doc, catalog).links.some((link) => (link as unknown[])[0] === 31)).toBe(false);
    expect(target(doc).inputs![3]).toMatchObject({ link: null });
    doc.destroy();
  });

  it("lets a higher complete-link identity retire an input claim that already lost its ID", () => {
    const source = workflow(true);
    delete source.nodes[0]!["properties"];
    source.nodes.push({ id: 200, type: "FloatLiteral", widgets_values: [0], inputs: [{ name: "value", type: "FLOAT", link: null }] });
    const seed = mint(source, catalog);
    const bytes = Y.encodeStateAsUpdate(seed);
    const low: Op = { ...env(7), op: "connect", from_node: 103, from_slot: 0, to_node: 1, to_slot: 2, link_id: 31, link_type: "FLOAT" };
    const high: Op = { ...low, ...env(8), to_node: 200, to_slot: 0 };
    for (const order of [[low, high], [high, low]]) {
      const doc = new Y.Doc(); Y.applyUpdate(doc, bytes);
      expect(applyOps(doc, order, catalog).outcomes.every((result) => result.outcome !== "rejected")).toBe(true);
      const result = project(doc, catalog);
      expect(result.links).toEqual([[21, 101, 0, 1, 1, "FLOAT"], [23, 103, 0, 1, 3, "FLOAT"], [31, 103, 0, 200, 0, "FLOAT"]]);
      expect(result.nodes.find((node) => node.id === 1)!.inputs![2]).toMatchObject({ link: null });
      doc.destroy();
    }
    seed.destroy();
  });

  it("rejects producer-forged private row storage and slot markers", () => {
    const state = workflow();
    state.nodes[0]!["__dynamic_group_state"] = {};
    expect(() => mint(state, catalog)).toThrow(/reserved key/);
    const marker = workflow();
    (marker.nodes[0]!.inputs![1] as Record<string, unknown>)["__dynamic_group_slot"] = { group: "loras", row_id: "B", field: "strength" };
    expect(() => mint(marker, catalog)).toThrow(/reserved DynamicGroup slot/);
  });

  it("preserves non-default subgraph boundary IDs in catalog-free reconnect snapshots", () => {
    const source = promotedWorkflow(false);
    const definition = source.definitions!.subgraphs![0] as Record<string, unknown>;
    definition["inputNode"] = { id: -30 };
    (definition["links"] as Record<string, unknown>[]).forEach((link) => { link["origin_id"] = -30; });
    const doc = mint(source, catalog);
    const op = { ...remove(["B"]), path: ["9"] } as Op;
    expect(applyOps(doc, [op], catalog).outcomes[0]?.outcome).toBe("applied");
    const result = project(doc, catalog);
    expect(readGraph(doc).links).toEqual(Object.fromEntries((result.links as unknown[][]).map((link) => [String(link[0]), link])));
    expect(readGraph(doc).nodes["9"]!["__widgets_opaque"]).toEqual([0.4, 0.6]);
    doc.destroy();
  });

  it("spells the private row wire keys in the encoded snapshot and recovers them by their published names", () => {
    const layout = JSON.parse(readFileSync(new URL("../fixtures/golden-vectors/wire-layout.json", import.meta.url), "utf8")) as { reserved_node_keys: { dynamic_group_state: string }; reserved_input_keys: { dynamic_group_slot: string } };
    const doc = mint(workflow(), catalog);
    applyOps(doc, [remove(["B"])], catalog);
    const bytes = Y.encodeStateAsUpdate(doc);
    for (const name of [layout.reserved_node_keys.dynamic_group_state, layout.reserved_input_keys.dynamic_group_slot]) {
      const token = Buffer.concat([Buffer.from([Buffer.byteLength(name)]), Buffer.from(name)]);
      expect(Buffer.from(bytes).includes(token), name).toBe(true);
    }
    const fork = new Y.Doc(); Y.applyUpdate(fork, bytes);
    const node = fork.getMap("nodes").get("1") as Y.Map<unknown>;
    expect(node.get(layout.reserved_node_keys.dynamic_group_state)).toBeInstanceOf(Y.Map);
    const input = (node.get("inputs") as Y.Array<Y.Map<unknown>>).get(2);
    expect(input.get(layout.reserved_input_keys.dynamic_group_slot)).toEqual({ group: "loras", row_id: "B", field: "strength" });
    expect(readGraph(fork).nodes["1"]!.dynamicGroupRows).toMatchObject({ loras: ["A", "C"] });
    fork.destroy(); doc.destroy();
  });

  it("treats prototype-looking template fields as literal row identities", () => {
    const source = workflow(true);
    const literal = structuredClone(catalog);
    literal.types["CompositeDynamicGroup"]!.dynamic_groups!["loras"]!.widgets = ["constructor", "__proto__", "enabled"];
    const rename = (name: string) => name.replace(/\.lora_name$/, ".constructor").replace(/\.strength$/, ".__proto__");
    const node = source.nodes[0]!;
    node.widgets_values = Object.fromEntries(Object.entries(node.widgets_values as Record<string, unknown>).map(([name, value]) => [rename(name), value]));
    node["widgets_values_named"] = structuredClone(node.widgets_values);
    node.inputs!.forEach((slot) => {
      const value = slot as Record<string, unknown>;
      value["name"] = rename(String(value["name"]));
      if (value["widget"]) value["widget"] = { name: value["name"] };
    });
    const doc = mint(source, literal);
    const op = edit("C", { ["__proto__"]: 0.8, constructor: "new.safetensors" });
    expect(applyOps(doc, [remove(["B"]), op], literal).outcomes.map((result) => result.outcome)).toEqual(["applied", "applied"]);
    const result = project(doc, literal);
    expect(result.nodes[0]!["widgets_values_named"]).toMatchObject({ "loras.1.__proto__": 0.8, "loras.1.constructor": "new.safetensors" });
    expect(result.nodes[0]!.inputs![2]).toMatchObject({ name: "loras.1.__proto__", link: 23 });
    const fork = new Y.Doc(); Y.applyUpdate(fork, Y.encodeStateAsUpdate(doc));
    expect(canonicalize(project(fork, literal))).toEqual(canonicalize(result));
    fork.destroy();
    doc.destroy();
  });

  it("resolves promoted values by proxy order when it differs from input-port order", () => {
    const source = promotedWorkflow(false);
    source.nodes[0]!.widgets_values = [0.6, 0.4, 0.5];
    source.nodes[0]!["properties"] = { proxyWidgets: [["1", "loras.2.strength"], ["1", "loras.0.strength"], ["1", "loras.1.strength"]] };
    const doc = mint(source, catalog);
    const ops = [{ ...edit("C", { strength: 0.9 }, 8), path: ["9"], host_path: ["9"], host_incarnation: "0" }, { ...remove(["B"]), path: ["9"] }] as Op[];
    expect(applyOps(doc, ops, catalog).outcomes.map((result) => result.outcome)).toEqual(["applied", "applied"]);
    expect(project(doc, catalog).nodes.find((node) => node.id === 9)).toMatchObject({ widgets_values: [0.9, 0.4], properties: { proxyWidgets: [["1", "loras.1.strength"], ["1", "loras.0.strength"]] } });
    doc.destroy();
  });

  it("refuses encoded anchor cycles even when they have no reachable root", () => {
    const doc = mint(workflow(), catalog);
    applyOps(doc, [edit("C", { strength: 0.9 })], catalog);
    const node = doc.getMap("nodes").get("1") as Y.Map<unknown>;
    const group = (node.get("__dynamic_group_state") as Y.Map<Y.Map<unknown>>).get("loras")!;
    const records = group.get("records") as Y.Map<Record<string, unknown>>;
    records.set("A", { ...records.get("A"), after: "C" });
    const fork = new Y.Doc(); Y.applyUpdate(fork, Y.encodeStateAsUpdate(doc));
    expect(() => readGraph(fork)).toThrow(/cyclic row anchors/);
    fork.destroy(); doc.destroy();
  });

  it("refuses unsupported self-described promoted-host layouts before structural writes", () => {
    const source = promotedWorkflow(false);
    source.nodes[0]!["widgets_values_form"] = { order: ["loras.0.strength", "loras.1.strength", "loras.2.strength"] };
    const initial = mint(source, catalog);
    expect(project(initial, catalog).nodes[0]!.widgets_values).toEqual([0.4, 0.5, 0.6]);
    initial.destroy();
    assertRejectedWithoutMutation(source, { ...remove(["B"]), path: ["9"] } as Op, "malformed_op", catalog);
  });

  it.each([false, true])("materializes a losing Autogrow request without moving the winning row=%s link", (row) => {
    const source = workflow(true);
    if (!row) delete source.nodes[0]!["properties"];
    source.nodes.push({ id: 200, type: "FloatLiteral", widgets_values: [0], inputs: [{ name: "value", type: "FLOAT", link: null }] });
    const seed = mint(source, catalog);
    const bytes = Y.encodeStateAsUpdate(seed);
    const grown: Op = { ...env(9), op: "connect", from_node: 103, from_slot: 0, to_node: 200, link_id: 41, link_type: "FLOAT", grow: { name: "values.value0", type: "FLOAT" } };
    const low: Op = { ...grown, ...env(7), link_id: 31, grow: { name: "values.value1", type: "FLOAT" } };
    const high: Op = row ? connect("C", 8) : { ...env(8), op: "connect", from_node: 103, from_slot: 0, to_node: 1, to_slot: 3, link_id: 31, link_type: "FLOAT" };
    for (const order of [[grown, low, high], [grown, high, low]]) {
      const doc = new Y.Doc(); Y.applyUpdate(doc, bytes);
      expect(applyOps(doc, order, catalog).outcomes.every((result) => result.outcome !== "rejected")).toBe(true);
      const result = project(doc, catalog);
      expect(result.nodes.find((node) => node.id === 200)!.inputs).toEqual([
        { name: "value", type: "FLOAT", link: null },
        { name: "values.value1", type: "FLOAT", link: null, grow_id: 31 },
        { name: "values.value0", type: "FLOAT", link: 41, grow_id: 41 },
      ]);
      expect(result.links).toContainEqual([31, 103, 0, 1, 3, "FLOAT"]);
      expect(result.links).toContainEqual([41, 103, 0, 200, 2, "FLOAT"]);
      doc.destroy();
    }
    seed.destroy();
  });

  it("uses the existing widget-key escaping for reserved-looking controller names", () => {
    const name = "\u0000widget-occurrence:loras";
    const source = workflow();
    const escaped = structuredClone(catalog);
    const entry = escaped.types["CompositeDynamicGroup"]!;
    entry.widget_order = entry.widget_order.map((field) => field === "loras" ? name : field);
    entry.dynamic_groups![name] = entry.dynamic_groups!["loras"]!;
    delete entry.dynamic_groups!["loras"];
    const node = source.nodes[0]!;
    node.widgets_values = Object.fromEntries(Object.entries(node.widgets_values as Record<string, unknown>).map(([field, value]) => [field.replace(/^loras/, name), value]));
    node["widgets_values_named"] = structuredClone(node.widgets_values);
    node["properties"] = { dynamicGroupRows: { [name]: ["A", "B", "C"], weights: ["W"] } };
    node.inputs = [];
    const doc = mint(source, escaped);
    const ops = [{ ...remove(["B"]), group: name }, { ...edit("C", { strength: 0.9 }), group: name }] as Op[];
    expect(applyOps(doc, ops, escaped).outcomes.map((result) => result.outcome)).toEqual(["applied", "applied"]);
    expect(project(doc, escaped).nodes[0]!["widgets_values_named"]).toMatchObject({ [name]: 2, [`${name}.1.strength`]: 0.9 });
    const fork = new Y.Doc(); Y.applyUpdate(fork, Y.encodeStateAsUpdate(doc));
    expect(canonicalize(project(fork, escaped))).toEqual(canonicalize(project(doc, escaped)));
    fork.destroy(); doc.destroy();
  });

  it("owns interior link identity by canonical definition rather than its instance-route spelling", () => {
    const source = promotedWorkflow(false);
    const definition = source.definitions!.subgraphs![0] as Record<string, unknown>;
    (definition["nodes"] as unknown[]).push({ id: 103, type: "FloatLiteral", inputs: [], outputs: [{ name: "FLOAT", type: "FLOAT", links: [] }], widgets_values: [0.3] });
    const seed = mint(source, catalog);
    const bytes = Y.encodeStateAsUpdate(seed);
    const low = { ...connect("A", 7), path: ["9"] } as Op;
    const high = { ...connect("C", 8), path: ["inner-definition"] } as Op;
    for (const order of [[low, high], [high, low]]) {
      const doc = new Y.Doc(); Y.applyUpdate(doc, bytes);
      expect(applyOps(doc, order, catalog).outcomes.every((result) => result.outcome !== "rejected")).toBe(true);
      const inner = project(doc, catalog).definitions!.subgraphs![0] as Record<string, unknown>;
      expect(inner["links"]).toEqual(expect.arrayContaining([{ id: 31, origin_id: 103, origin_slot: 0, target_id: 1, target_slot: 2, type: "FLOAT" }]));
      doc.destroy();
    }
    seed.destroy();
  });

  it("does not restore an old row link into an activated new target lifetime", () => {
    const source = workflow(true);
    const doc = mint(source, catalog);
    const node = structuredClone(source.nodes[0]!);
    node.inputs!.forEach((slot) => { (slot as Record<string, unknown>)["link"] = null; });
    const producer = source.nodes.find((candidate) => candidate.id === 103)!;
    const added = env(10);
    const ops: Op[] = [connect("C"),
      { ...env(9), op: "delete_node", node_id: 1, removed_links: [] },
      { ...added, op: "add_node", node_id: 1, node_incarnation: added.op_id, class_type: "CompositeDynamicGroup", pos: [0, 0], node },
      { ...edit("C", { enabled: true }, 11), node_incarnation: added.op_id } as Op,
      { ...env(12), op: "delete_node", node_id: 103, removed_links: [] },
      { ...env(13), op: "add_node", node_id: 103, class_type: "FloatLiteral", pos: [0, 0], node: producer },
    ];
    const result = applyOps(doc, ops, catalog);
    expect(result.outcomes.every((outcome) => outcome.outcome !== "rejected")).toBe(true);
    expect(result.outcomes[3]?.outcome).toBe("applied");
    expect(doc.getMap("links").has("31")).toBe(false);
    expect(project(doc, catalog).links.some((link) => (link as unknown[])[0] === 31)).toBe(false);
    expect(target(doc).inputs![3]).toMatchObject({ link: null });
    doc.destroy();
  });
});
