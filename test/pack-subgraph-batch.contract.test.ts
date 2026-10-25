/**
 * Packing selected nodes into a subgraph replicates as ONE ordered batch of
 * already-implemented kinds (Linear BE-10796, agent `pack_subgraph`):
 *
 *   define_subgraph, delete_node × N, add_node (the instance), connect × K
 *
 * all minted with one envelope `base_version`, and with NO `disconnect` of the
 * boundary links: each `delete_node` already removes every link incident to a
 * packed node, and the boundary `connect`s re-claim the freed inputs.
 *
 * This is the shape the frontend's human "Convert to Subgraph" command already
 * replicates through (`LGraph.convertToSubgraph` → graph intents → doc op
 * minter). The fixture below mirrors what that command minted on
 * ComfyUI_frontend main@640364552cfa for a Source → 3 × Pass → 2 × Sink chain,
 * reordered into the contract order. No new op kind is involved, so this suite
 * pins the applier semantics a pack depends on (KA-1 ops are the replication
 * unit, KA-2 creator-minted stamps, KA-4 determinism, KA-5 creator-minted
 * ids) rather than adding any.
 */
import * as Y from "yjs";
import { describe, expect, it } from "vitest";

import { applyOps, mint, project, type Op, type WidgetCatalog, type WorkflowJSON } from "../src/index.js";
import { appliedMap } from "../src/doc.js";
import { checkGraphInvariants } from "./graph-invariant-oracle.js";

const catalog: WidgetCatalog = {
  types: {
    PSource: { widget_order: ["seed"] },
    PPass: { widget_order: ["scale"] },
    PSink: { widget_order: [] },
  },
};

const DEF = "42e413ef-ec2a-4cef-a488-6c4d452bb6d3";
const INSTANCE = 636095910096155;
const ACTOR = "agent:th_pack:1";
const BASE = 7;

const slot = (name: string, link: number | null) => ({ name, type: "IMAGE", link });
const out = (links: number[]) => ({ name: "image", type: "IMAGE", links });
const pass = (id: number, input: number, links: number[], scale: number) => ({
  id, type: "PPass", pos: [10, 10], size: [210, 60], flags: {}, order: id - 1, mode: 0,
  inputs: [slot("image", input)], outputs: [out(links)], properties: {}, widgets_values: [scale],
});
const sink = (id: number, input: number) => ({
  id, type: "PSink", pos: [10, 10], size: [140, 60], flags: {}, order: id - 1, mode: 0,
  inputs: [slot("image", input)], outputs: [], properties: {},
});

/** Source(1) → Pass(2) → Pass(3) → Pass(4) → {Sink(5), Sink(6)}. */
const seed = (): WorkflowJSON => ({
  id: "2e83ff9d-2e8f-4c8c-a8ac-aa2dae859d77",
  revision: 0,
  last_node_id: 6,
  last_link_id: 5,
  nodes: [
    { id: 1, type: "PSource", pos: [10, 10], size: [210, 60], flags: {}, order: 0, mode: 0,
      inputs: [], outputs: [out([1])], properties: {}, widgets_values: [7] },
    pass(2, 1, [2], 2),
    pass(3, 2, [3], 5),
    pass(4, 3, [4, 5], 2),
    sink(5, 4),
    sink(6, 5),
  ],
  links: [
    [1, 1, 0, 2, 0, "IMAGE"],
    [2, 2, 0, 3, 0, "IMAGE"],
    [3, 3, 0, 4, 0, "IMAGE"],
    [4, 4, 0, 5, 0, "IMAGE"],
    [5, 4, 0, 6, 0, "IMAGE"],
  ],
  groups: [],
  version: 0.4,
} as unknown as WorkflowJSON);

/** The definition exactly as `convertToSubgraph` serialized it. Interior ids are the packed nodes' own. */
const definition = (id = DEF) => ({
  id,
  version: 1,
  state: { lastGroupId: 0, lastNodeId: 6, lastLinkId: 8, lastRerouteId: 0 },
  revision: 0,
  config: {},
  name: "New Subgraph",
  inputNode: { id: -10, bounding: [-188, -34, 128, 68] },
  outputNode: { id: -20, bounding: [60, -34, 128, 68] },
  inputs: [{ id: "c4195af4-ae55-478b-ac05-3b03d3385d1d", name: "image", type: "IMAGE", linkIds: [1], pos: [51, 24] }],
  outputs: [{ id: "641f416d-12c6-40f5-961f-d127fc78b6b4", name: "image", type: "IMAGE", linkIds: [4], pos: [24, 24] }],
  widgets: [],
  nodes: [pass(2, 1, [2], 2), pass(3, 2, [3], 5), pass(4, 3, [4], 2)],
  groups: [],
  links: [
    { id: 2, origin_id: 2, origin_slot: 0, target_id: 3, target_slot: 0, type: "IMAGE" },
    { id: 3, origin_id: 3, origin_slot: 0, target_id: 4, target_slot: 0, type: "IMAGE" },
    { id: 1, origin_id: -10, origin_slot: 0, target_id: 2, target_slot: 0, type: "IMAGE" },
    { id: 4, origin_id: 4, origin_slot: 0, target_id: -20, target_slot: 0, type: "IMAGE" },
  ],
  extra: {},
});

const connect = (link_id: number, from_node: number, to_node: number) =>
  ({ op: "connect", link_id, from_node, from_slot: 0, to_node, to_slot: 0, link_type: "IMAGE" }) as const;

/** The contract batch, envelope-free, in contract order. */
const packBody = (defined = definition()): Array<Record<string, unknown>> => [
  { op: "define_subgraph", subgraph_id: DEF, subgraph_definition: defined },
  { op: "delete_node", node_id: 2, removed_links: [1, 2] },
  { op: "delete_node", node_id: 3, removed_links: [2, 3] },
  { op: "delete_node", node_id: 4, removed_links: [3, 4, 5] },
  {
    op: "add_node", node_id: INSTANCE, class_type: DEF, pos: [-70, 2],
    node: {
      id: INSTANCE, type: DEF, pos: [-70, 2], size: [141, 26], order: 3, mode: 0,
      inputs: [slot("image", 6)], outputs: [out([7, 8])], title: "New Subgraph", properties: {}, flags: {},
    },
  },
  connect(6, 1, INSTANCE),
  connect(7, INSTANCE, 5),
  connect(8, INSTANCE, 6),
];

const hex = (n: number) => n.toString(16).padStart(32, "0");

/** Stamp a body the way comfy-cli's `_new_op` stamps one batch: one base_version, one actor. */
function stamp(body: Array<Record<string, unknown>>, opIds: string[], base = BASE, actor = ACTOR): Op[] {
  return body.map((op, index) => ({ ...op, op_id: opIds[index], actor, base_version: base, stamp: [base, actor] }) as Op);
}

function fork(base: Y.Doc): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(base));
  return doc;
}

const seeded = mint(seed(), catalog);

/** Order-insensitive topology of one graph scope. */
function topology(nodes: Array<Record<string, unknown>>, links: unknown[]) {
  return {
    nodes: nodes.map((node) => `${String(node.id)}:${String(node.type)}`).sort(),
    links: links.map((link) => {
      const t = Array.isArray(link)
        ? link
        : [0, ...["origin_id", "origin_slot", "target_id", "target_slot"].map((k) => (link as Record<string, unknown>)[k])];
      return `${String(t[1])}.${String(t[2])}->${String(t[3])}.${String(t[4])}`;
    }).sort(),
  };
}

function packedShape(doc: Y.Doc) {
  const projected = project(doc, catalog);
  const defs = (projected.definitions?.subgraphs ?? []) as Array<Record<string, unknown>>;
  const packed = defs.find((candidate) => candidate.id === DEF);
  return {
    root: topology(projected.nodes as never, projected.links ?? []),
    interior: packed ? topology(packed.nodes as never, packed.links as never) : null,
    interiorScale: packed
      ? (packed.nodes as Array<Record<string, unknown>>).map((node) => [node.id, node.widgets_values])
      : null,
  };
}

const PACKED = {
  root: {
    nodes: ["1:PSource", `${INSTANCE}:${DEF}`, "5:PSink", "6:PSink"].sort(),
    links: [`1.0->${INSTANCE}.0`, `${INSTANCE}.0->5.0`, `${INSTANCE}.0->6.0`].sort(),
  },
  interior: {
    nodes: ["2:PPass", "3:PPass", "4:PPass"],
    links: ["-10.0->2.0", "2.0->3.0", "3.0->4.0", "4.0->-20.0"],
  },
  interiorScale: [[2, [2]], [3, [5]], [4, [2]]],
};

/** Every ordered pair of operations at the low/high op_id extremes. */
function extremeOpIdAssignments(size: number) {
  const assignments: Array<{ low: number; high: number; ids: string[] }> = [];
  for (let low = 0; low < size; low++) {
    for (let high = 0; high < size; high++) {
      if (low === high) continue;
      const ids = Array.from({ length: size }, (_, index) => hex(0x100 + index));
      ids[low] = hex(1);
      ids[high] = "f".repeat(32);
      assignments.push({ low, high, ids });
    }
  }
  return assignments;
}

describe("pack_subgraph replicates as one batch of existing kinds (BE-10796)", () => {
  it("applies the contract batch whole and projects the packed graph", () => {
    const doc = fork(seeded);
    const body = packBody();
    expect(body.map((op) => op.op)).toEqual([
      "define_subgraph",
      "delete_node", "delete_node", "delete_node",
      "add_node",
      "connect", "connect", "connect",
    ]);
    expect(body.some((op) => op.op === "disconnect")).toBe(false);

    const ops = stamp(body, body.map((_, i) => hex(i + 1)));
    expect(new Set(ops.map((op) => op.base_version))).toEqual(new Set([BASE]));
    expect(new Set(ops.map((op) => op.actor))).toEqual(new Set([ACTOR]));
    const result = applyOps(doc, ops, catalog);

    expect(result.outcomes.map((outcome) => outcome.outcome)).toEqual(Array(ops.length).fill("applied"));
    expect(packedShape(doc)).toEqual(PACKED);
    expect(checkGraphInvariants(doc)).toEqual([]);

    const beforeReplay = Y.encodeStateAsUpdate(doc);
    const replay = applyOps(doc, ops, catalog);
    expect(replay.outcomes.map((outcome) => outcome.outcome)).toEqual(Array(ops.length).fill("no-op"));
    expect(Y.encodeStateAsUpdate(doc)).toEqual(beforeReplay);
    expect(packedShape(doc)).toEqual(PACKED);
  });

  // Bounded domain: all 8 * 7 = 56 ordered pairs of operations assigned the
  // lowest and highest distinct op_ids. Every pair is exercised in both
  // relative orders. Within one batch base_version and actor are shared, so
  // this exhausts the pairwise op_id-tiebreak equivalence classes.
  it("does not depend on op_id tiebreaks inside the batch", () => {
    const body = packBody();
    const assignments = extremeOpIdAssignments(body.length);
    expect(assignments).toHaveLength(body.length * (body.length - 1));
    const shapes = new Set<string>();
    for (const { low, high, ids } of assignments) {
      const doc = fork(seeded);
      const outcomes = applyOps(doc, stamp(body, ids), catalog).outcomes;
      expect(outcomes.every((outcome) => outcome.outcome === "applied"), `low=${low}, high=${high}`).toBe(true);
      shapes.add(JSON.stringify(packedShape(doc)));
    }
    expect([...shapes]).toEqual([JSON.stringify(PACKED)]);
  });

  it("loses a re-claimed input to the batch's own disconnect, which is why the contract has none", () => {
    // The human command currently disconnects the boundary links before
    // deleting; its sender gives each op its own base_version, so the later
    // connect wins. comfy-cli stamps a whole batch with one base_version, and
    // there the op_id tiebreak decides between a disconnect and the connect
    // re-claiming the same input.
    const body = [
      { op: "disconnect", link_id: 4, to_node: 5, to_slot: 0 },
      ...packBody(),
    ];
    const ids = body.map((_, i) => hex(i + 1));
    ids[0] = "f".repeat(32); // the disconnect sorts after every connect
    const doc = fork(seeded);
    const outcomes = applyOps(doc, stamp(body, ids), catalog).outcomes;

    expect(outcomes.find((outcome) => outcome.op_id === ids[body.length - 2])?.outcome).toBe("lww-dropped");
    expect(packedShape(doc).root.links).not.toContain(`${INSTANCE}.0->5.0`);
  });

  it("aborts the whole pack when the definition is rejected, because it is minted first", () => {
    const malformed = { ...definition(), id: "00000000-0000-4000-8000-000000000000" };
    const doc = fork(seeded);
    const before = Y.encodeStateAsUpdate(doc);
    const ids = packBody().map((_, i) => hex(i + 1));
    const outcomes = applyOps(doc, stamp(packBody(malformed), ids), catalog).outcomes;

    expect(outcomes[0]).toMatchObject({ outcome: "rejected", reason: { code: "malformed_op" } });
    expect(outcomes.slice(1).every((outcome) => outcome.outcome === "rejected" && outcome.reason.code === "batch_aborted")).toBe(true);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(appliedMap(doc).has(ids[0]!)).toBe(false);

    // Minted last instead, the same rejection lands after the packed nodes
    // are already gone and the instance points at no definition.
    const late = fork(seeded);
    const reordered = packBody(malformed).slice(1).concat(packBody(malformed).slice(0, 1));
    const lateOps = stamp(reordered, ids);
    const lateOutcomes = applyOps(late, lateOps, catalog).outcomes;
    expect(lateOutcomes.slice(0, -1).every((outcome) => outcome.outcome === "applied")).toBe(true);
    expect(lateOutcomes.at(-1)).toMatchObject({ outcome: "rejected", reason: { code: "malformed_op" } });
    expect(appliedMap(late).has(ids.at(-1)!)).toBe(false);
    expect(packedShape(late).root.nodes).toEqual(PACKED.root.nodes);
    expect(packedShape(late).interior).toBeNull();

    // Isolate the final document-boundary rejection on the same document so
    // its byte identity is compared after, not before, the accepted prefix.
    const boundary = fork(seeded);
    const prefix = applyOps(boundary, lateOps.slice(0, -1), catalog).outcomes;
    expect(prefix.every((outcome) => outcome.outcome === "applied")).toBe(true);
    const beforeLateRejection = Y.encodeStateAsUpdate(boundary);
    const rejected = applyOps(boundary, lateOps.slice(-1), catalog).outcomes;
    expect(rejected[0]).toMatchObject({ outcome: "rejected", reason: { code: "malformed_op" } });
    expect(Y.encodeStateAsUpdate(boundary)).toEqual(beforeLateRejection);
    expect(appliedMap(boundary).has(ids.at(-1)!)).toBe(false);
  });

  it("converges with a concurrent edit to a packed node in both arrival orders; delete wins", () => {
    const edit = stamp(
      [{ op: "set_widget", node_id: 3, widget: "scale", value: 9 }],
      ["e".repeat(32)],
      BASE + 1,
      "human:u_1:tab_1",
    );
    const pack = stamp(packBody(), packBody().map((_, i) => hex(i + 1)));

    const editFirst = fork(seeded);
    expect(applyOps(editFirst, edit, catalog).outcomes[0]?.outcome).toBe("applied");
    expect(applyOps(editFirst, pack, catalog).outcomes.every((outcome) => outcome.outcome === "applied")).toBe(true);

    const packFirst = fork(seeded);
    expect(applyOps(packFirst, pack, catalog).outcomes.every((outcome) => outcome.outcome === "applied")).toBe(true);
    expect(applyOps(packFirst, edit, catalog).outcomes[0]?.outcome).toBe("no-op");

    expect(project(editFirst, catalog)).toEqual(project(packFirst, catalog));
    expect(packedShape(editFirst)).toEqual(PACKED);
    expect(packedShape(packFirst)).toEqual(PACKED);
    // The v1 cost, stated so it is not mistaken for a guarantee: the edit to
    // the top-level node does not follow it into the definition.
    expect(packedShape(packFirst).interiorScale).toEqual(PACKED.interiorScale);
  });
});
