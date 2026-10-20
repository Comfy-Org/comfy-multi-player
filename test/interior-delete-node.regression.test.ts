import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  applyOps,
  mint,
  project,
  type AddNodeOp,
  type DeleteNodeOp,
  type WidgetCatalog,
  type WorkflowJSON,
} from "../src/index.js";

const catalog: WidgetCatalog = { types: { Primitive: { widget_order: [] } } };

function workflow(instances = 1): WorkflowJSON {
  return {
    nodes: Array.from({ length: instances }, (_, index) => ({
      id: 70 + index,
      type: "definition-delete",
      inputs: [],
      outputs: [],
    })),
    links: [],
    definitions: {
      subgraphs: [{
        id: "definition-delete",
        nodes: [
          { id: 21, type: "Primitive", inputs: [], outputs: [{ name: "OUT", type: "*", links: [91] }] },
          { id: 22, type: "Primitive", inputs: [{ name: "IN", type: "*", link: 91 }], outputs: [] },
        ],
        links: [{ id: 91, origin_id: 21, origin_slot: 0, target_id: 22, target_slot: 0, type: "*" }],
      }],
    },
  } as unknown as WorkflowJSON;
}

function remove(overrides: Partial<DeleteNodeOp> = {}): DeleteNodeOp {
  return {
    op: "delete_node",
    op_id: "interiordeletenode00000000000001",
    actor: "agent:a",
    base_version: 2,
    stamp: [2, "agent:a"],
    path: ["70"],
    node_id: 22,
    removed_links: [91],
    ...overrides,
  };
}

function definition(doc: Y.Doc) {
  return (project(doc, catalog).definitions as {
    subgraphs: Array<{ nodes: WorkflowJSON["nodes"]; links: Array<Record<string, unknown>> }>;
  }).subgraphs[0]!;
}

describe("interior delete_node regression", () => {
  it("deletes the addressed interior node and its links without touching a same-id root node", () => {
    const seeded = workflow();
    seeded.nodes.push({ id: 22, type: "Primitive", inputs: [], outputs: [] });
    const doc = mint(seeded, catalog);
    const op = remove();

    expect(applyOps(doc, [op], catalog).outcomes).toEqual([{ op_id: op.op_id, outcome: "applied" }]);
    expect(project(doc, catalog).nodes.some(({ id }) => id === 22)).toBe(true);
    expect(definition(doc).nodes.map(({ id }) => id)).toEqual([21]);
    expect(definition(doc).links).toEqual([]);
    expect((definition(doc).nodes[0]!.outputs![0] as { links: unknown[] }).links).toEqual([]);
  });

  it("refuses to mutate a shared definition", () => {
    const doc = mint(workflow(2), catalog);
    const before = Y.encodeStateAsUpdate(doc);
    const op = remove();

    expect(applyOps(doc, [op], catalog).outcomes[0]).toMatchObject({
      op_id: op.op_id,
      outcome: "rejected",
      reason: { code: "shared_definition_unforked" },
    });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it("shares a path-scoped presence register with an interior re-add", () => {
    const deletion = remove();
    const replacement: AddNodeOp = {
      op: "add_node",
      op_id: "interiorreplacement0000000000002",
      actor: "agent:b",
      base_version: 3,
      stamp: [3, "agent:b"],
      path: ["70"],
      node_id: 22,
      class_type: "Primitive",
      pos: [4, 5],
      node: { id: 22, type: "Primitive", pos: [4, 5], inputs: [], outputs: [] },
    };

    const projections = [[deletion, replacement], [replacement, deletion]].map((ops) => {
      const doc = mint(workflow(), catalog);
      applyOps(doc, ops, catalog);
      return project(doc, catalog);
    });
    expect(projections[0]).toEqual(projections[1]);
    expect((projections[0]!.definitions as { subgraphs: Array<{ nodes: unknown[] }> }).subgraphs[0]!.nodes).toHaveLength(2);
  });
});
