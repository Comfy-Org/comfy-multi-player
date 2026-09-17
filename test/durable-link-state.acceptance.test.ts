import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import {
  applyOps,
  mint,
  project,
  type AddNodeOp,
  type ConnectOp,
  type DeleteNodeOp,
  type DisconnectOp,
  type Op,
  type WorkflowJSON,
  type WorkflowNode,
} from "../src/index.js";
import { loadCatalog } from "./helpers.js";

const catalog = loadCatalog();
const definitionId = "f2fdebf6-dfaf-43b6-9eb2-7f70613cfdc1";

const source: WorkflowNode = {
  id: 10,
  type: "LoadImage",
  inputs: [],
  outputs: [{ name: "IMAGE", type: "IMAGE", links: [] }],
  widgets_values: [],
};
const concreteTarget: WorkflowNode = {
  id: 20,
  type: "PreviewImage",
  inputs: [{ name: "images", type: "IMAGE", link: null }],
  outputs: [],
  widgets_values: [],
};
const promotedInstance: WorkflowNode = {
  id: 57,
  type: definitionId,
  inputs: [],
  outputs: [{ name: "IMAGE", type: "IMAGE", links: [] }],
  widgets_values: [],
};
const workflow: WorkflowJSON = {
  nodes: [source, concreteTarget, promotedInstance],
  links: [],
  groups: [],
  extra: {},
  last_node_id: 57,
  last_link_id: 0,
  definitions: {
    subgraphs: [{
      id: definitionId,
      name: "Stored image subgraph",
      inputs: [{ name: "nested.dynamic.image", type: "IMAGE" }],
      outputs: [{ name: "IMAGE", type: "IMAGE" }],
      nodes: [{ id: 1, type: "PreviewImage", inputs: [{ name: "images", type: "IMAGE", link: null }], outputs: [], widgets_values: [] }],
      links: [],
    }],
  },
};

const seededSnapshot = Y.encodeStateAsUpdate(mint(workflow, catalog));
const opId = (serial: number) => serial.toString(16).padStart(32, "0");
const envelope = (serial: number, version: number, actor = "agent:reviewer") => ({
  op_id: opId(serial),
  actor,
  base_version: version,
  stamp: [version, actor] as [number, string],
});

function fork() {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, seededSnapshot);
  return doc;
}

function applyAccepted(ops: Op[]) {
  const doc = fork();
  const result = applyOps(doc, ops, catalog);
  expect(result.outcomes).toHaveLength(ops.length);
  expect(result.outcomes, "valid acceptance operations must reach semantic assertions").not.toContainEqual(
    expect.objectContaining({ outcome: "rejected" }),
  );
  for (const op of ops) {
    const before = Y.encodeStateAsUpdate(doc);
    expect(applyOps(doc, [op], catalog).outcomes).toEqual([{ op_id: op.op_id, outcome: "no-op" }]);
    expect(Y.encodeStateAsUpdate(doc), `duplicate ${op.op_id} must be byte-identical`).toEqual(before);
  }
  return project(doc, catalog);
}

const promotedConnect = (linkId: 911 | 912, serial: number, version: number): ConnectOp => ({
  op: "connect",
  ...envelope(serial, version),
  link_id: linkId,
  from_node: 10,
  from_slot: 0,
  to_node: 57,
  link_type: "IMAGE",
  grow: { name: "nested.dynamic.image", type: "IMAGE", promoted: true },
});
const deletePromoted: DeleteNodeOp = {
  op: "delete_node",
  ...envelope(0xd1, 3),
  node_id: 57,
  removed_links: [],
};
const readdPromoted: AddNodeOp = {
  op: "add_node",
  ...envelope(0xa1, 4),
  node_id: 57,
  class_type: definitionId,
  pos: [],
  node: promotedInstance,
};

describe("ADR-022 bounded durable-link acceptance", () => {
  it("restores concrete intent and the exact endpoint references after delete/re-add", () => {
    const connect: ConnectOp = {
      op: "connect", ...envelope(0xc1, 1), link_id: 100, from_node: 10, from_slot: 0,
      to_node: 20, to_slot: 0, link_type: "IMAGE",
    };
    const remove: DeleteNodeOp = { op: "delete_node", ...envelope(0xd2, 2), node_id: 20, removed_links: [] };
    const readd: AddNodeOp = { op: "add_node", ...envelope(0xa2, 3), node_id: 20, class_type: concreteTarget.type, pos: [], node: concreteTarget };
    const out = applyAccepted([connect, remove, readd]);
    expect(out.links).toEqual([[100, 10, 0, 20, 0, "IMAGE"]]);
    expect(out.nodes.find(node => node.id === 10)).toMatchObject({ outputs: [{ links: [100] }] });
    expect(out.nodes.find(node => node.id === 20)).toMatchObject({ inputs: [{ link: 100 }] });
  });

  it("reproduces reviewer 911/912: only the winning promoted generation returns with its full-name slot", () => {
    const out = applyAccepted([
      promotedConnect(911, 0x911, 1),
      promotedConnect(912, 0x912, 2),
      deletePromoted,
      readdPromoted,
    ]);
    expect(out.links).toEqual([[912, 10, 0, 57, 0, "IMAGE"]]);
    expect(out.nodes.find(node => node.id === 57)).toMatchObject({
      inputs: [{ name: "nested.dynamic.image", type: "IMAGE", link: 912, grow_id: 912 }],
    });
  });

  it("orders a promoted replacement against a same-stamp disconnect", () => {
    const first = promotedConnect(911, 0x911, 1);
    const disconnect: DisconnectOp = {
      op: "disconnect", ...envelope(0x910, 2), link_id: 911, to_node: 57, to_slot: 0,
    };
    const replacement = promotedConnect(912, 0x912, 2);
    const orderA = applyAccepted([first, disconnect, replacement]);
    const orderB = applyAccepted([first, replacement, disconnect]);
    expect(orderA).toEqual(orderB);
    expect(orderA.links).toEqual([[912, 10, 0, 57, 0, "IMAGE"]]);
  });

  it("preserves the pass-7 scalar reuse and mismatched-disconnect counterexample", () => {
    const first: ConnectOp = {
      op: "connect", ...envelope(0xa, 0), link_id: 100, from_node: 10,
      from_slot: 0, to_node: 20, to_slot: 0, link_type: "IMAGE",
    };
    const sever: DisconnectOp = {
      op: "disconnect", ...envelope(0xb, 0), link_id: 101, to_node: 20, to_slot: 0,
    };
    const winner: ConnectOp = { ...first, ...envelope(0xc, 0) };
    const left = applyAccepted([first, sever, winner]);
    const right = applyAccepted([winner, first, sever]);
    expect(left).toEqual(right);
    expect(left.links).toEqual([[100, 10, 0, 20, 0, "IMAGE"]]);
  });
});
