/**
 * `insert_workflow` — merge a template workflow (nodes, links,
 * `definitions.subgraphs`) into an existing doc in ONE transaction.
 *
 * TDD V1.5 (in-app-agent program, ADR-T8): today a template with subgraphs can
 * only reach a live doc through a whole-doc reseed, because every other op
 * schema rejects definition-bearing fields (KA-11). This op carries the
 * template as an opaque payload the applier merges under the same guards the
 * six existing kinds obey: collision-free ids (validated BEFORE any mutation,
 * KA-4), definition dedupe/fork by content hash, exact-replay no-op through
 * the op_id gate, and byte-identical doc on rejection.
 *
 * ID allocation is the MINTER's job (cloud / cli remap before emitting —
 * precedent: `add_node.node_id`); the applier only VALIDATES. Rejected
 * alternative: applier-side remap from `last_node_id`, which collides under
 * concurrent forks of the same base version.
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { appliedMap } from "../src/doc.js";
import {
  OPAQUE_WIDGETS_KEY,
  applyOps,
  mint,
  project,
  remapWorkflowIds,
  type Op,
  type WidgetCatalog,
  type WorkflowJSON,
} from "../src/index.js";
import { appliedOpIds, noOpIds, rejectedOutcomeWithIndex } from "./apply-result-helpers.js";

const catalog: WidgetCatalog = {
  types: {
    Src: { widget_order: [] },
    Sink: { widget_order: ["inputcount"] },
    KSampler: { widget_order: ["seed", "steps"] },
    Inner: { widget_order: ["text"] },
  },
};

function baseWorkflow(): WorkflowJSON {
  return {
    last_node_id: 7,
    last_link_id: 7,
    nodes: [
      { id: 1, type: "Src" },
      { id: 2, type: "Src" },
      { id: 3, type: "Sink", inputs: [{ name: "in", link: 7 }], widgets_values: [1] },
      { id: 4, type: "KSampler", widgets_values: [1, 2] },
      { id: 6, type: "def-1" },
    ],
    links: [[7, 2, 0, 3, 0, "X"]],
    definitions: {
      subgraphs: [{ id: "def-1", name: "D", nodes: [{ id: 27, type: "Inner", widgets_values: ["t"] }], links: [] }],
    },
  } as unknown as WorkflowJSON;
}

/** A template with its OWN definition `def-2` and ids already disjoint from the base. */
function template(): WorkflowJSON {
  return {
    nodes: [
      { id: 100, type: "Src", pos: [0, 0] },
      { id: 101, type: "def-2", inputs: [{ name: "a", link: 200 }] },
    ],
    links: [[200, 100, 0, 101, 0, "X"]],
    definitions: {
      subgraphs: [{ id: "def-2", name: "E", nodes: [{ id: 5, type: "Inner", widgets_values: ["u"] }], links: [] }],
    },
  } as unknown as WorkflowJSON;
}

let seq = 0;
function env(): Pick<Op, "op_id" | "actor" | "base_version" | "stamp"> {
  return {
    op_id: ("i" + String(seq++).padStart(4, "0")).padEnd(32, "0"),
    actor: "a",
    base_version: 1,
    stamp: [1, "a"] as [number, string],
  };
}

function insertOp(workflow: unknown, overrides: Partial<Op> = {}): Op {
  return { ...env(), op: "insert_workflow", workflow, ...overrides } as unknown as Op;
}

const bytes = (doc: Y.Doc): Buffer => Buffer.from(Y.encodeStateAsUpdate(doc));

function ids(wf: WorkflowJSON): unknown[] {
  return (wf.nodes ?? []).map((n) => n.id);
}
function linkIds(wf: WorkflowJSON): unknown[] {
  return (wf.links ?? []).map((l) => (l as unknown[])[0]);
}
function defIds(wf: WorkflowJSON): string[] {
  const defs = (wf as { definitions?: { subgraphs?: { id: unknown }[] } }).definitions;
  return (defs?.subgraphs ?? []).map((s) => String(s.id));
}

describe("insert_workflow: happy path", () => {
  it("merges template nodes, links and definitions into the doc in one op", () => {
    const doc = mint(baseWorkflow(), catalog);
    const op = insertOp(template());
    const result = applyOps(doc, [op], catalog);

    expect(appliedOpIds(result)).toEqual([op.op_id]);
    const wf = project(doc, catalog);
    expect(ids(wf)).toEqual([1, 2, 3, 4, 6, 100, 101]);
    expect(linkIds(wf)).toEqual([7, 200]);
    expect(defIds(wf)).toEqual(["def-1", "def-2"]);
    // Inserted nodes project with their widgets resolved through the catalog.
    const n100 = wf.nodes!.find((n) => n.id === 100)!;
    expect(n100.type).toBe("Src");
    expect(n100.pos).toEqual([0, 0]);
    const n101 = wf.nodes!.find((n) => n.id === 101)!;
    expect(n101.inputs).toEqual([{ name: "a", link: 200 }]);
    // Registers advance to the max id seen.
    expect(wf.last_node_id).toBe(101);
    expect(wf.last_link_id).toBe(200);
  });

  it("is an exact-replay no-op through the op_id gate (no second copy)", () => {
    const doc = mint(baseWorkflow(), catalog);
    const op = insertOp(template());
    applyOps(doc, [op], catalog);
    const before = bytes(doc);
    const again = applyOps(doc, [op], catalog);
    expect(noOpIds(again)).toEqual([op.op_id]);
    expect(bytes(doc).equals(before)).toBe(true);
    expect(ids(project(doc, catalog))).toEqual([1, 2, 3, 4, 6, 100, 101]);
  });

  it("skips a template definition whose id AND projected content match the live one", () => {
    const doc = mint(baseWorkflow(), catalog);
    const tpl = template();
    (tpl as { definitions: { subgraphs: unknown[] } }).definitions.subgraphs = [
      { id: "def-1", name: "D", nodes: [{ id: 27, type: "Inner", widgets_values: ["t"] }], links: [] },
    ];
    tpl.nodes![1] = { id: 101, type: "def-1", inputs: [{ name: "a", link: 200 }] };
    const op = insertOp(tpl);
    const result = applyOps(doc, [op], catalog);
    expect(appliedOpIds(result)).toEqual([op.op_id]);
    const wf = project(doc, catalog);
    expect(defIds(wf)).toEqual(["def-1"]);
    expect(wf.nodes!.find((n) => n.id === 101)!.type).toBe("def-1");
  });

  it("preserves opaque widgets_values for uncatalogued inserted nodes", () => {
    const doc = mint(baseWorkflow(), catalog);
    const tpl = { nodes: [{ id: 300, type: "Note", widgets_values: ["hello"] }], links: [] } as unknown as WorkflowJSON;
    applyOps(doc, [insertOp(tpl)], catalog);
    const wf = project(doc, catalog);
    expect(wf.nodes!.find((n) => n.id === 300)!.widgets_values).toEqual(["hello"]);
    expect(OPAQUE_WIDGETS_KEY).toBeTruthy();
  });

  it("merges groups deterministically without dropping existing groups", () => {
    const seeded = { ...baseWorkflow(), groups: [{ title: "Base" }] } as WorkflowJSON;
    const doc = mint(seeded, catalog);
    applyOps(doc, [insertOp({ nodes: [], links: [], groups: [{ title: "Inserted" }] })], catalog);

    expect(project(doc, catalog).groups).toEqual([{ title: "Base" }, { title: "Inserted" }]);
  });

  it("scrubs private __ keys recursively from every inserted payload branch", () => {
    const doc = mint(baseWorkflow(), catalog);
    applyOps(doc, [insertOp({
      nodes: [{ id: 100, type: "Src", properties: { visible: true, __definition_digest: "node-secret" } }],
      links: [],
      groups: [{ title: "G", nested: { __private: "group-secret", visible: true } }],
      definitions: {
        subgraphs: [{ id: "def-2", nodes: [], links: [], metadata: { __definition_digest: "def-secret", visible: true } }],
      },
    })], catalog);

    const json = JSON.stringify(project(doc, catalog));
    expect(json).not.toContain("__definition_digest");
    expect(json).not.toContain("__private");
    expect(json).toContain('"visible":true');
  });
});

describe("insert_workflow: rejection (KA-4 byte identity, op_id absent from applied)", () => {
  const cases: { name: string; workflow: unknown; code: string; withCatalog: boolean }[] = [
    {
      name: "node id collides with a live node",
      workflow: { nodes: [{ id: 1, type: "Src" }], links: [] },
      code: "node_id_collision",
      withCatalog: true,
    },
    {
      name: "link id collides with a live link",
      workflow: { nodes: [{ id: 100, type: "Src" }], links: [[7, 100, 0, 3, 0, "X"]] },
      code: "link_id_collision",
      withCatalog: true,
    },
    {
      name: "duplicate node id inside the template itself",
      workflow: { nodes: [{ id: 100, type: "Src" }, { id: 100, type: "Src" }], links: [] },
      code: "node_id_collision",
      withCatalog: true,
    },
    { name: "missing workflow", workflow: undefined, code: "malformed_op", withCatalog: true },
    { name: "non-object workflow", workflow: "nope", code: "malformed_op", withCatalog: true },
    { name: "nodes is not an array", workflow: { nodes: {}, links: [] }, code: "malformed_op", withCatalog: true },
    {
      name: "node without id/type",
      workflow: { nodes: [{ pos: [0, 0] }], links: [] },
      code: "invalid_node_payload",
      withCatalog: true,
    },
    {
      name: "positional widgets with no catalog",
      workflow: { nodes: [{ id: 100, type: "KSampler", widgets_values: [1, 2] }], links: [] },
      code: "catalog_required",
      withCatalog: false,
    },
  ];

  for (const c of cases) {
    it(`rejects: ${c.name} → ${c.code}`, () => {
      const doc = mint(baseWorkflow(), catalog);
      const before = bytes(doc);
      const op = insertOp(c.workflow);
      const result = applyOps(doc, [op], c.withCatalog ? catalog : undefined);
      expect(rejectedOutcomeWithIndex(result)!.code).toBe(c.code);
      expect(bytes(doc).equals(before)).toBe(true);
      expect(appliedMap(doc).has(op.op_id)).toBe(false);
    });
  }

  it("validates ALL ids before mutating: a late collision leaves nothing behind", () => {
    const doc = mint(baseWorkflow(), catalog);
    const before = bytes(doc);
    const wf = { nodes: [{ id: 100, type: "Src" }, { id: 101, type: "Src" }, { id: 4, type: "Src" }], links: [] };
    const result = applyOps(doc, [insertOp(wf)], catalog);
    expect(rejectedOutcomeWithIndex(result)!.code).toBe("node_id_collision");
    expect(bytes(doc).equals(before)).toBe(true);
    expect(ids(project(doc, catalog))).toEqual([1, 2, 3, 4, 6]);
  });

  it("rejects dangling link endpoints atomically", () => {
    const doc = mint(baseWorkflow(), catalog);
    const before = bytes(doc);
    const op = insertOp({ nodes: [{ id: 100, type: "Src" }], links: [[200, 100, 0, 999, 0, "X"]] });
    const result = applyOps(doc, [op], catalog);

    expect(rejectedOutcomeWithIndex(result)!.code).toBe("malformed_op");
    expect(bytes(doc).equals(before)).toBe(true);
    expect(appliedMap(doc).has(op.op_id)).toBe(false);
  });

  it("rejects an id-less nested subgraph atomically", () => {
    const doc = mint(baseWorkflow(), catalog);
    const before = bytes(doc);
    const op = insertOp({
      nodes: [{ id: 100, type: "Src" }],
      links: [],
      definitions: {
        subgraphs: [{ id: "outer", nodes: [], links: [], definitions: { subgraphs: [{ nodes: [], links: [] }] } }],
      },
    });

    expect(rejectedOutcomeWithIndex(applyOps(doc, [op], catalog))!.code).toBe("malformed_op");
    expect(bytes(doc).equals(before)).toBe(true);
    expect(appliedMap(doc).has(op.op_id)).toBe(false);
  });

  it("rejects conflicting definitions identically in either arrival order", () => {
    const seed = Y.encodeStateAsUpdate(mint(baseWorkflow(), catalog));
    const makeDoc = (): Y.Doc => {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, seed);
      return doc;
    };
    const makeConflict = (name: string, nodeId: number, opId: string): Op =>
      insertOp(
        {
          nodes: [{ id: nodeId, type: "def-1" }],
          links: [],
          definitions: { subgraphs: [{ id: "def-1", name, nodes: [], links: [] }] },
        },
        { op_id: opId },
      );
    const first = makeConflict("A", 100, "a".repeat(32));
    const second = makeConflict("B", 101, "b".repeat(32));
    const docA = makeDoc();
    const docB = makeDoc();

    expect(applyOps(docA, [first], catalog).outcomes[0]).toMatchObject({ outcome: "rejected", reason: { code: "definition_conflict" } });
    expect(applyOps(docA, [second], catalog).outcomes[0]).toMatchObject({ outcome: "rejected", reason: { code: "definition_conflict" } });
    expect(applyOps(docB, [second], catalog).outcomes[0]).toMatchObject({ outcome: "rejected", reason: { code: "definition_conflict" } });
    expect(applyOps(docB, [first], catalog).outcomes[0]).toMatchObject({ outcome: "rejected", reason: { code: "definition_conflict" } });
    expect(project(docA, catalog)).toEqual(project(docB, catalog));
    expect(project(docA, catalog)).toEqual(project(makeDoc(), catalog));
  });

  it("never overwrites an occupied deterministic fork id", () => {
    const wf = baseWorkflow() as WorkflowJSON & { definitions: { subgraphs: Record<string, unknown>[] } };
    wf.definitions.subgraphs.push({ id: "def-1-deadbeef", name: "Occupied", nodes: [], links: [] });
    const doc = mint(wf, catalog);
    const before = bytes(doc);
    const op = insertOp({
      nodes: [{ id: 100, type: "def-1" }],
      links: [],
      definitions: { subgraphs: [{ id: "def-1", name: "Different", nodes: [], links: [] }] },
    });

    expect(rejectedOutcomeWithIndex(applyOps(doc, [op], catalog))!.code).toBe("definition_conflict");
    expect(bytes(doc).equals(before)).toBe(true);
    const definitions = (project(doc, catalog) as { definitions: { subgraphs: { id: string; name: string }[] } }).definitions.subgraphs;
    expect(definitions.find((definition) => definition.id === "def-1-deadbeef")!.name).toBe("Occupied");
  });
});

describe("remapWorkflowIds (minter-side helper)", () => {
  it("shifts node and link ids and rewrites every reference, leaving definitions untouched", () => {
    const out = remapWorkflowIds(template(), { nodeIdStart: 8, linkIdStart: 8 });
    expect(ids(out)).toEqual([8, 9]);
    expect(linkIds(out)).toEqual([8]);
    const link = out.links![0] as unknown[];
    expect(link.slice(0, 5)).toEqual([8, 8, 0, 9, 0]);
    expect(out.nodes![1]!.inputs).toEqual([{ name: "a", link: 8 }]);
    expect(defIds(out)).toEqual(["def-2"]);
    // Interior definition ids are a separate namespace: unchanged.
    const inner = (out as { definitions: { subgraphs: { nodes: { id: unknown }[] }[] } }).definitions.subgraphs[0]!;
    expect(inner.nodes[0]!.id).toBe(5);
  });

  it("rewrites output links arrays and does not mutate its input", () => {
    const tpl = {
      nodes: [
        { id: 1, type: "Src", outputs: [{ name: "o", links: [1, 2] }] },
        { id: 2, type: "Sink", inputs: [{ name: "in", link: 1 }] },
        { id: 3, type: "Sink", inputs: [{ name: "in", link: 2 }] },
      ],
      links: [
        [1, 1, 0, 2, 0, "X"],
        [2, 1, 0, 3, 0, "X"],
      ],
    } as unknown as WorkflowJSON;
    const snapshot = structuredClone(tpl);
    const out = remapWorkflowIds(tpl, { nodeIdStart: 10, linkIdStart: 20 });
    expect(tpl).toEqual(snapshot);
    expect(ids(out)).toEqual([10, 11, 12]);
    expect(out.nodes![0]!.outputs).toEqual([{ name: "o", links: [20, 21] }]);
    expect(out.nodes![2]!.inputs).toEqual([{ name: "in", link: 21 }]);
    expect(out.links).toEqual([
      [20, 10, 0, 11, 0, "X"],
      [21, 10, 0, 12, 0, "X"],
    ]);
  });
});
