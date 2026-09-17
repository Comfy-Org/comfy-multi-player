import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  applyOps,
  mint,
  project,
  type ConnectOp,
  type WidgetCatalog,
  type WorkflowJSON,
} from "../src/index.js";
import { appliedMap } from "../src/doc.js";

const catalog: WidgetCatalog = {
  types: {
    Source: { widget_order: [] },
    Sink: { widget_order: [] },
  },
};

const workflow = {
  nodes: [{ id: 100, type: "definition-1", inputs: [], outputs: [] }],
  links: [],
  definitions: {
    subgraphs: [
      {
        id: "definition-1",
        nodes: [
          {
            id: 1,
            type: "Source",
            inputs: [],
            outputs: [{ name: "text", type: "STRING", links: null }],
          },
          {
            id: 2,
            type: "Sink",
            inputs: [{ name: "text", type: "STRING", link: null }],
            outputs: [],
          },
        ],
        links: [],
      },
    ],
  },
} as unknown as WorkflowJSON;

function connect(overrides: Partial<ConnectOp> = {}): ConnectOp {
  return {
    op: "connect",
    op_id: "interiorconnect0000000000000001",
    actor: "human:a",
    base_version: 1,
    stamp: [1, "human:a"],
    path: ["100"],
    link_id: 41,
    from_node: 1,
    from_slot: 0,
    to_node: 2,
    to_slot: 0,
    link_type: "STRING",
    ...overrides,
  } as ConnectOp;
}

function definitionOf(doc: Y.Doc) {
  return (project(doc, catalog).definitions as {
    subgraphs: Array<{
      nodes: Array<{
        id: number;
        inputs?: Array<{ link: number | null }>;
        outputs?: Array<{ links: number[] | null }>;
      }>;
      links: Array<{ id: number }>;
    }>;
  }).subgraphs[0]!;
}

describe("interior connect regression", () => {
  it("applies and projects a concrete link inside one subgraph definition", () => {
    const doc = mint(workflow, catalog);
    const op = connect();

    expect(applyOps(doc, [op], catalog).outcomes).toEqual([
      { op_id: op.op_id, outcome: "applied" },
    ]);

    const definitions = project(doc, catalog).definitions as {
      subgraphs: Array<{
        nodes: Array<{
          id: number;
          inputs?: Array<{ link: number | null }>;
          outputs?: Array<{ links: number[] | null }>;
        }>;
        links: unknown[];
      }>;
    };
    const definition = definitions.subgraphs[0]!;

    expect(definition.links).toEqual([
      {
        id: 41,
        origin_id: 1,
        origin_slot: 0,
        target_id: 2,
        target_slot: 0,
        type: "STRING",
      },
    ]);
    expect(definition.nodes.find(({ id }) => id === 1)?.outputs?.[0]?.links).toEqual([41]);
    expect(definition.nodes.find(({ id }) => id === 2)?.inputs?.[0]?.link).toBe(41);
  });

  it.each([
    ["empty path", { path: [] }],
    [
      "interior autogrow",
      {
        grow: { name: "text", type: "STRING", grow_id: "grow-1" },
        to_slot: undefined,
      },
    ],
  ])("rejects %s before changing document bytes or consuming op_id", (_name, invalid) => {
    const doc = mint(workflow, catalog);
    const op = connect(invalid as unknown as Partial<ConnectOp>);
    const before = Y.encodeStateAsUpdate(doc);

    const result = applyOps(doc, [op], catalog);

    expect(result.outcomes).toEqual([
      {
        op_id: op.op_id,
        outcome: "rejected",
        reason: { code: "malformed_op", message: expect.any(String) },
      },
    ]);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(appliedMap(doc).has(op.op_id)).toBe(false);
  });

  it("refuses an interior write when two instances share the definition", () => {
    const shared = structuredClone(workflow) as unknown as WorkflowJSON;
    shared.nodes.push({ id: 101, type: "definition-1", inputs: [], outputs: [] });
    const doc = mint(shared, catalog);
    const op = connect();
    const before = Y.encodeStateAsUpdate(doc);

    const result = applyOps(doc, [op], catalog);

    expect(result.outcomes).toEqual([
      {
        op_id: op.op_id,
        outcome: "rejected",
        reason: { code: "shared_definition_unforked", message: expect.any(String) },
      },
    ]);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(appliedMap(doc).has(op.op_id)).toBe(false);
  });

  it("uses path-scoped input stamps and converges on the higher-stamped link", () => {
    const low = connect();
    const high = connect({
      op_id: "interiorconnect0000000000000002",
      stamp: [2, "human:b"],
      actor: "human:b",
      base_version: 2,
      link_id: 42,
    });

    for (const order of [[low, high], [high, low]]) {
      const doc = mint(workflow, catalog);
      applyOps(doc, order, catalog);
      const definition = definitionOf(doc);
      expect(definition.links.map(({ id }) => id)).toEqual([42]);
      expect(definition.nodes.find(({ id }) => id === 1)?.outputs?.[0]?.links).toEqual([42]);
      expect(definition.nodes.find(({ id }) => id === 2)?.inputs?.[0]?.link).toBe(42);
    }
  });

  it("treats an identical interior-connect retry as a byte-identical no-op", () => {
    const doc = mint(workflow, catalog);
    const op = connect();
    expect(applyOps(doc, [op], catalog).outcomes[0]?.outcome).toBe("applied");
    const afterFirstApply = Y.encodeStateAsUpdate(doc);

    expect(applyOps(doc, [op], catalog).outcomes).toEqual([
      { op_id: op.op_id, outcome: "no-op" },
    ]);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(afterFirstApply);
  });

  // Recovery PR 198 must preserve KA-4 for independent links, not just one contested input.
  it("regression: independent interior connects project identically in both arrival orders", () => {
    const independent = structuredClone(workflow);
    const definitions = independent.definitions as {
      subgraphs: Array<{ nodes: WorkflowJSON["nodes"] }>;
    };
    definitions.subgraphs[0]!.nodes.push({
      id: 3,
      type: "Sink",
      inputs: [{ name: "text", type: "STRING", link: null }],
      outputs: [],
    });
    const seed = mint(independent, catalog);
    const snapshot = Y.encodeStateAsUpdate(seed);
    const first = connect();
    const second = connect({
      op_id: "independentconnect0000000000002",
      stamp: [2, "human:b"],
      actor: "human:b",
      link_id: 42,
      to_node: 3,
    });
    const projections = [[first, second], [second, first]].map((order) => {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, snapshot);
      expect(applyOps(doc, order, catalog).outcomes.map(({ outcome }) => outcome)).toEqual([
        "applied",
        "applied",
      ]);
      const projection = definitionOf(doc);
      expect(projection.links.map(({ id }) => id).sort()).toEqual([41, 42]);
      expect(projection.nodes.find(({ id }) => id === 2)?.inputs?.[0]?.link).toBe(41);
      expect(projection.nodes.find(({ id }) => id === 3)?.inputs?.[0]?.link).toBe(42);
      return project(doc, catalog);
    });
    expect(projections[0]).toEqual(projections[1]);
  });

  it("preserves asymmetric imported order ahead of deterministically ordered additions", () => {
    const imported = structuredClone(workflow) as unknown as WorkflowJSON & {
      definitions: { subgraphs: Array<{ nodes: WorkflowJSON["nodes"]; links: Array<Record<string, unknown>> }> };
    };
    const definition = imported.definitions.subgraphs[0]!;
    (definition.nodes[0]!.outputs as Array<{ links: number[] | null }>)[0]!.links = [90, 7];
    (definition.nodes[1]!.inputs as Array<{ link: number | null }>)[0]!.link = 90;
    definition.nodes.push(
      {
        id: 3,
        type: "Sink",
        inputs: [{ name: "text", type: "STRING", link: 7 }],
        outputs: [],
      },
      {
        id: 4,
        type: "Sink",
        inputs: [{ name: "text", type: "STRING", link: null }],
        outputs: [],
      },
      {
        id: 5,
        type: "Sink",
        inputs: [{ name: "text", type: "STRING", link: null }],
        outputs: [],
      },
    );
    definition.links = [
      { id: 90, origin_id: 1, origin_slot: 0, target_id: 2, target_slot: 0, type: "STRING" },
      { id: 7, origin_id: 1, origin_slot: 0, target_id: 3, target_slot: 0, type: "STRING" },
    ];
    const snapshot = Y.encodeStateAsUpdate(mint(imported, catalog));
    const first = connect({ to_node: 4, link_id: 41 });
    const second = connect({
      op_id: "independentconnect0000000000002",
      stamp: [2, "human:b"],
      actor: "human:b",
      base_version: 2,
      to_node: 5,
      link_id: 42,
    });

    for (const order of [[first, second], [second, first]]) {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, snapshot);
      applyOps(doc, order, catalog);
      expect(definitionOf(doc).links.map(({ id }) => id)).toEqual([90, 7, 41, 42]);
    }
  });

  it("removes a replaced imported link without disturbing surviving imported order", () => {
    const imported = structuredClone(workflow) as unknown as WorkflowJSON & {
      definitions: { subgraphs: Array<{ nodes: WorkflowJSON["nodes"]; links: Array<Record<string, unknown>> }> };
    };
    const definition = imported.definitions.subgraphs[0]!;
    (definition.nodes[0]!.outputs as Array<{ links: number[] | null }>)[0]!.links = [90, 7];
    (definition.nodes[1]!.inputs as Array<{ link: number | null }>)[0]!.link = 90;
    definition.nodes.push({
      id: 3,
      type: "Sink",
      inputs: [{ name: "text", type: "STRING", link: 7 }],
      outputs: [],
    });
    definition.links = [
      { id: 90, origin_id: 1, origin_slot: 0, target_id: 2, target_slot: 0, type: "STRING" },
      { id: 7, origin_id: 1, origin_slot: 0, target_id: 3, target_slot: 0, type: "STRING" },
    ];
    const doc = mint(imported, catalog);

    expect(applyOps(doc, [connect()], catalog).outcomes[0]?.outcome).toBe("applied");

    expect(definitionOf(doc).links.map(({ id }) => id)).toEqual([7, 41]);
    expect(definitionOf(doc).nodes.find(({ id }) => id === 1)?.outputs?.[0]?.links).toEqual([7, 41]);
  });

  it("keeps top-level and interior bookkeeping distinct when link ids collide", () => {
    const withRootGraph = structuredClone(workflow) as unknown as WorkflowJSON;
    withRootGraph.nodes.push(
      {
        id: 1,
        type: "Source",
        inputs: [],
        outputs: [{ name: "text", type: "STRING", links: null }],
      },
      {
        id: 2,
        type: "Sink",
        inputs: [{ name: "text", type: "STRING", link: null }],
        outputs: [],
      },
    );
    const doc = mint(withRootGraph, catalog);
    const root = connect({ op_id: "rootconnect000000000000000001" });
    delete root.path;
    const interior = connect({ op_id: "interiorconnect0000000000000003", stamp: [2, "human:a"] });

    expect(applyOps(doc, [root, interior], catalog).outcomes.map(({ outcome }) => outcome)).toEqual([
      "applied",
      "applied",
    ]);

    const projected = project(doc, catalog);
    expect(projected.links).toEqual([[41, 1, 0, 2, 0, "STRING"]]);
    expect(definitionOf(doc).links.map(({ id }) => id)).toEqual([41]);
  });
});
