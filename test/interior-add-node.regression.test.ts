import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  applyOps,
  mint,
  project,
  type AddNodeOp,
  type WidgetCatalog,
  type WorkflowJSON,
} from "../src/index.js";
import { appliedMap } from "../src/doc.js";

const catalog: WidgetCatalog = {
  types: {
    Primitive: { widget_order: [] },
  },
};

const workflow = {
  nodes: [{ id: 100, type: "definition-1", inputs: [], outputs: [] }],
  links: [],
  definitions: {
    subgraphs: [{ id: "definition-1", nodes: [], links: [] }],
  },
} as unknown as WorkflowJSON;

function add(overrides: Partial<AddNodeOp> = {}): AddNodeOp {
  return {
    op: "add_node",
    op_id: "interioraddnode0000000000000001",
    actor: "agent:a",
    base_version: 1,
    stamp: [1, "agent:a"],
    path: ["100"],
    node_id: 3,
    class_type: "Primitive",
    pos: [10, 20],
    node: { id: 3, type: "Primitive", pos: [10, 20], inputs: [], outputs: [] },
    ...overrides,
  } as AddNodeOp;
}

function definitionNodes(doc: Y.Doc): WorkflowJSON["nodes"] {
  const definitions = project(doc, catalog).definitions as {
    subgraphs: Array<{ nodes: WorkflowJSON["nodes"] }>;
  };
  return definitions.subgraphs[0]!.nodes;
}

describe("interior add_node regression", () => {
  it("applies and projects a node inside the definition owned by an instance path", () => {
    const doc = mint(workflow, catalog);
    const op = add();

    expect(applyOps(doc, [op], catalog).outcomes).toEqual([
      { op_id: op.op_id, outcome: "applied" },
    ]);
    expect(definitionNodes(doc)).toEqual([
      { id: 3, type: "Primitive", pos: [10, 20], inputs: [], outputs: [] },
    ]);
    expect(project(doc, catalog).nodes).toEqual(workflow.nodes);
  });

  it("rejects a missing container path without mutation or consuming op_id", () => {
    const doc = mint(workflow, catalog);
    const op = add({ path: ["missing"] });
    const before = Y.encodeStateAsUpdate(doc);

    expect(applyOps(doc, [op], catalog).outcomes).toEqual([
      {
        op_id: op.op_id,
        outcome: "rejected",
        reason: {
          code: "interior_container_not_found",
          message: "add_node: interior container missing not found",
        },
      },
    ]);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(appliedMap(doc).has(op.op_id)).toBe(false);
  });

  it("refuses an interior add when two instances share the definition", () => {
    const shared = structuredClone(workflow) as unknown as WorkflowJSON;
    shared.nodes.push({ id: 101, type: "definition-1", inputs: [], outputs: [] });
    const doc = mint(shared, catalog);
    const op = add();
    const before = Y.encodeStateAsUpdate(doc);

    expect(applyOps(doc, [op], catalog).outcomes[0]).toMatchObject({
      op_id: op.op_id,
      outcome: "rejected",
      reason: { code: "shared_definition_unforked" },
    });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(appliedMap(doc).has(op.op_id)).toBe(false);
  });

  it("uses path-scoped presence stamps and deterministically orders concurrent additions", () => {
    const first = add();
    const second = add({
      op_id: "interioraddnode0000000000000002",
      actor: "agent:b",
      base_version: 2,
      stamp: [2, "agent:b"],
      node_id: 4,
      node: { id: 4, type: "Primitive", pos: [30, 40], inputs: [], outputs: [] },
    });

    const projections = [[first, second], [second, first]].map((order) => {
      const doc = mint(workflow, catalog);
      expect(applyOps(doc, order, catalog).outcomes.map(({ outcome }) => outcome)).toEqual([
        "applied",
        "applied",
      ]);
      return definitionNodes(doc);
    });

    expect(projections[0]).toEqual(projections[1]);
    expect(projections[0]!.map(({ id }) => id)).toEqual([3, 4]);
  });

  it("does not contend with a top-level node that has the same id", () => {
    const doc = mint(workflow, catalog);
    const topLevel = add();
    delete topLevel.path;
    const interior = add({
      op_id: "interioraddnode0000000000000002",
      actor: "agent:b",
      base_version: 2,
      stamp: [2, "agent:b"],
      node: { id: 3, type: "Primitive", pos: [30, 40], inputs: [], outputs: [] },
    });

    expect(applyOps(doc, [topLevel, interior], catalog).outcomes.map(({ outcome }) => outcome)).toEqual([
      "applied",
      "applied",
    ]);
    expect(project(doc, catalog).nodes.some(({ id }) => id === 3)).toBe(true);
    expect(definitionNodes(doc)).toEqual([
      { id: 3, type: "Primitive", pos: [30, 40], inputs: [], outputs: [] },
    ]);
  });
});
