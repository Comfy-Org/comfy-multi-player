/** R-93: the wire `node_id` is authoritative at the add-node identity boundary. */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { appliedMap } from "../src/doc.js";
import { applyOps, mint, project, type Op, type WidgetCatalog, type WorkflowJSON } from "../src/index.js";

const catalog: WidgetCatalog = {
  types: {
    LoadImage: { widget_order: [] },
  },
};

const base = (): WorkflowJSON => ({
  nodes: [],
  links: [],
  groups: [],
  extra: {},
  last_node_id: 0,
  last_link_id: 0,
});

const bytes = (doc: Y.Doc) => Buffer.from(Y.encodeStateAsUpdate(doc));
const id = (tag: string) => (tag + "0".repeat(32)).slice(0, 32);

function addNode(nodeId: number, payloadId: number | string | null | undefined, tag: string): Op {
  const node = {
    // `undefined` omits the key; `null` keeps it — the two JSON spellings of
    // "no id" (A19 treats them alike at the identity gate; the payload itself
    // is still stored verbatim, so a `null` projects as `id: null`).
    ...(payloadId === undefined ? {} : { id: payloadId }),
    type: "LoadImage",
    inputs: [{ name: "images", type: "IMAGE", link: null }],
    outputs: [{ name: "IMAGE", type: "IMAGE", links: [] }],
    widgets_values: [],
  };
  // Envelope stays fully validated; the only intentional wire defect is the
  // payload id (absent, or `null` — not a `NodeId`), narrowed at this line.
  const payload = node as unknown as Omit<typeof node, "id"> & { id: number | string };
  return {
    op: "add_node",
    op_id: id(tag),
    actor: "human:a",
    base_version: 1,
    stamp: [1, "human:a"],
    node_id: nodeId,
    class_type: "LoadImage",
    pos: [],
    node: payload,
  } satisfies Op;
}

const connect = (linkId: number, from: number, to: number, seq: number): Op => ({
  op: "connect",
  op_id: id(`connect-${linkId}`),
  actor: "human:a",
  base_version: 2 + seq,
  stamp: [2 + seq, "human:a"],
  link_id: linkId,
  from_node: from,
  from_slot: 0,
  to_node: to,
  to_slot: 0,
  link_type: "IMAGE",
} as Op);

// Projection coherence for an accepted add/connect stream: every link tuple's
// destination id names a projected node (the no-dangling-target criterion
// from PR #165's acceptance criteria, exercised where it CAN fail).
const linkDestination = (wf: { links: unknown[] }) =>
  (wf.links[0] as unknown[])[3];

describe("R-93 add_node identity boundary", () => {
  it("rejects contradictory wire and payload identities without mutation or a dangling target", () => {
    const doc = mint(base(), catalog);
    const before = bytes(doc);

    // applyOps converts OpRejectedError into the public rejected outcome.
    const rejected = addNode(9, 77, "contradictory");
    const trailing = addNode(10, 10, "trailing");
    const result = applyOps(doc, [rejected, trailing], catalog);

    expect(result.outcomes[0]).toMatchObject({
      outcome: "rejected",
      reason: { code: "malformed_op" },
    });
    expect(result.outcomes[1]).toMatchObject({ outcome: "rejected", reason: { code: "batch_aborted" } });
    expect(bytes(doc)).toEqual(before);
    expect(appliedMap(doc).has(rejected.op_id)).toBe(false);
    expect(appliedMap(doc).has(trailing.op_id)).toBe(false);
    expect(doc.getMap("nodes").has("9")).toBe(false);
    expect(project(doc, catalog).nodes.some((node) => node.id === 77)).toBe(false);

    const connect = {
      op: "connect",
      op_id: id("connect-missing"),
      actor: "human:a",
      base_version: 2,
      stamp: [2, "human:a"],
      link_id: 90,
      from_node: 9,
      from_slot: 0,
      to_node: 9,
      to_slot: 0,
      link_type: "IMAGE",
    } as Op;
    expect(applyOps(doc, [connect], catalog).outcomes[0]).toMatchObject({ outcome: "no-op" });
  });

  it.each([
    { label: "matching numeric", nodeId: 10, payloadId: 10, projectedId: 10 },
    { label: "numeric/string normalized", nodeId: 11, payloadId: "11" },
    { label: "absent payload id", nodeId: 12, payloadId: undefined },
    { label: "null payload id", nodeId: 14, payloadId: null },
  ])("accepts $label identity", ({ nodeId, payloadId, projectedId }) => {
    const doc = mint(base(), catalog);

    const result = applyOps(doc, [addNode(nodeId, payloadId, `accepted-${nodeId}`)], catalog);

    expect(result.outcomes[0]).toMatchObject({ outcome: "applied" });
    const projected = project(doc, catalog).nodes[0];
    if (projectedId !== undefined) expect(projected?.id).toBe(projectedId);
    if (payloadId === "11") expect(projected?.id).toBe("11");
    if (payloadId === undefined) expect(projected).not.toHaveProperty("id");
    // FC-8: the payload is stored verbatim, so a spelled `null` id projects as
    // `id: null` even though the A19 identity gate reads it as absent.
    if (payloadId === null) expect(projected?.id).toBe(null);
  });

  // PR #165 review item 7: the accepted path was only asserted where the
  // assertions could not fail. These exercise the no-dangling-target criterion
  // on a stream where a real node/link projection could diverge.
  it("projects an accepted matching-identity stream with every link destination present", () => {
    const doc = mint(base(), catalog);

    const result = applyOps(
      doc,
      [addNode(10, 10, "coherent-a"), addNode(11, 11, "coherent-b"), connect(90, 10, 11, 0)],
      catalog,
    );

    expect(result.outcomes.map((o) => o.outcome)).toEqual(["applied", "applied", "applied"]);
    const wf = project(doc, catalog);
    expect(wf.links).toHaveLength(1);
    expect(wf.nodes.some((n) => n.id === linkDestination(wf))).toBe(true);
  });

  // PR #165 review items 1 and 2 (A19 "The residual"): FC-8 keeps valid
  // payloads verbatim, so these accepted-path shapes still project a link
  // whose destination names an id absent from the projected nodes (omitted /
  // null payload id) or diverges from it in type (String()-normalized).
  // Pinned so a future change to either is deliberate rather than accidental.
  it.each([
    { label: "omitted payload id", nodeId: 20, payloadId: undefined as number | string | null | undefined },
    { label: "null payload id", nodeId: 21, payloadId: null as number | string | null | undefined },
    { label: "type-divergent payload id", nodeId: 22, payloadId: "22" as number | string | null | undefined },
  ])("characterizes the residual dangling-target shape for $label", ({ nodeId, payloadId }) => {
    const doc = mint(base(), catalog);

    const result = applyOps(
      doc,
      [addNode(nodeId, payloadId, `residual-${nodeId}`), addNode(23, 23, "residual-b"), connect(91, 23, nodeId, 0)],
      catalog,
    );

    expect(result.outcomes.map((o) => o.outcome)).toEqual(["applied", "applied", "applied"]);
    const wf = project(doc, catalog);
    expect(wf.links).toHaveLength(1);
    const destination = linkDestination(wf);
    // The wire node_id names no projected node id exactly (absent, null, or
    // stored verbatim as the string `"22"`): the residual A19 shape.
    expect(wf.nodes.some((n) => n.id === destination)).toBe(false);
  });
});
