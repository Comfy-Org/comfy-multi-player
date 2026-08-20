/**
 * Rejection/error-branch coverage for the applier. The existing suite pins the
 * happy paths, idempotency, LWW, and a couple of rejections; this file targets
 * the `OpRejectedError` arms that v8 coverage showed uncovered, asserting the
 * `failed.code` returned by `applyOps` (abort-remainder; the doc is left
 * untouched by a rejected op — KA-4 / the "rejected op leaves doc untouched"
 * property).
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  OPAQUE_WIDGETS_KEY,
  type AddNodeOp,
  type ConnectOp,
  type Op,
  type SetWidgetOp,
  type WidgetCatalog,
  type WorkflowJSON,
  applyOps,
  mint,
} from "../src/index.js";

const catalog: WidgetCatalog = {
  types: {
    KSampler: { widget_order: ["seed", "steps", "cfg", "sampler_name", "scheduler", "denoise"] },
    Note: { widget_order: ["text"] },
    CheckpointLoaderSimple: { widget_order: ["ckpt_name"] },
  },
};

let seq = 0;
const opId = () => ("z" + String(seq++).padStart(4, "0")).padEnd(32, "0");
const env = (actor: string, baseVersion: number) => ({
  op_id: opId(),
  actor,
  base_version: baseVersion,
  stamp: [baseVersion, actor] as [number, string],
});

/** Base doc: a KSampler with one input + one output slot, and a source node. */
function baseDoc(): Y.Doc {
  const wf: WorkflowJSON = {
    nodes: [
      {
        id: 1,
        type: "KSampler",
        inputs: [{ name: "model", type: "MODEL", link: null }],
        outputs: [{ name: "LATENT", type: "LATENT", links: [] }],
      },
      {
        id: 2,
        type: "CheckpointLoaderSimple",
        inputs: [],
        outputs: [{ name: "MODEL", type: "MODEL", links: [] }],
      },
    ],
    links: [],
    last_node_id: 2,
    last_link_id: 0,
  } as unknown as WorkflowJSON;
  return mint(wf, catalog);
}

const codeOf = (r: ReturnType<typeof applyOps>) => r.failed?.code;

describe("applier rejections — add_node", () => {
  it("malformed_op when node_id/node payload is missing", () => {
    const doc = baseDoc();
    const op = { op: "add_node", ...env("a", 1) } as unknown as Op; // no node_id/node
    expect(codeOf(applyOps(doc, [op], catalog))).toBe("malformed_op");
  });

  it("invalid_node_payload when the node carries the reserved opaque-widgets key", () => {
    const doc = baseDoc();
    const op: AddNodeOp = {
      op: "add_node",
      ...env("a", 1),
      node_id: 9,
      node: { id: 9, type: "Note", [OPAQUE_WIDGETS_KEY]: [1, 2] } as never,
    };
    expect(codeOf(applyOps(doc, [op], catalog))).toBe("invalid_node_payload");
  });

  it("is a structural no-op (not a failure) when the id already exists", () => {
    const doc = baseDoc();
    const op: AddNodeOp = { op: "add_node", ...env("a", 1), node_id: 1, node: { id: 1, type: "KSampler" } as never };
    const r = applyOps(doc, [op], catalog);
    expect(r.failed).toBeNull();
  });
});

describe("applier rejections — set_widget", () => {
  it("malformed_op for an interior write without inner_widget", () => {
    const doc = baseDoc();
    const op = { op: "set_widget", ...env("a", 1), node_id: 1, widget: "steps", value: 5, path: ["1", "2"] } as unknown as SetWidgetOp;
    expect(codeOf(applyOps(doc, [op], catalog))).toBe("malformed_op");
  });

  it("malformed_op for a top-level write with no widget name", () => {
    const doc = baseDoc();
    const op = { op: "set_widget", ...env("a", 1), node_id: 1, value: 5 } as unknown as SetWidgetOp;
    expect(codeOf(applyOps(doc, [op], catalog))).toBe("malformed_op");
  });

  it("not_a_subgraph when an interior path descends through a plain node", () => {
    const doc = baseDoc();
    const op: SetWidgetOp = {
      op: "set_widget",
      ...env("a", 1),
      node_id: 1,
      widget: "steps",
      value: 5,
      path: ["1", "27"], // node 1 is a KSampler, not a subgraph
      inner_widget: "steps",
    };
    expect(codeOf(applyOps(doc, [op], catalog))).toBe("not_a_subgraph");
  });
});

describe("applier rejections — connect", () => {
  const connect = (over: Partial<ConnectOp>): ConnectOp => ({
    op: "connect",
    ...env("a", 1),
    link_id: 1000 + seq,
    from_node: 2,
    from_slot: 0,
    to_node: 1,
    to_slot: 0,
    link_type: "MODEL",
    ...over,
  });

  it("output_slot_missing when from_slot is out of range", () => {
    const doc = baseDoc();
    expect(codeOf(applyOps(doc, [connect({ from_slot: 99 })], catalog))).toBe("output_slot_missing");
  });

  it("input_slot_missing when to_slot is out of range", () => {
    const doc = baseDoc();
    expect(codeOf(applyOps(doc, [connect({ to_slot: 99 })], catalog))).toBe("input_slot_missing");
  });

  it("malformed_op when to_slot is null and there is no grow", () => {
    const doc = baseDoc();
    expect(codeOf(applyOps(doc, [connect({ to_slot: null })], catalog))).toBe("malformed_op");
  });

  it("delete-wins no-op (not a failure) when the destination node is gone", () => {
    const doc = baseDoc();
    const r = applyOps(doc, [connect({ to_node: 987654321 })], catalog);
    expect(r.failed).toBeNull();
  });
});
