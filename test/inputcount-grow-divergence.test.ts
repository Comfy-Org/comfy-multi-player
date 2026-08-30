import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import {
  applyOps,
  mint,
  project,
  type ConnectOp,
  type Op,
  type WidgetCatalog,
  type WorkflowJSON,
  type WorkflowNode,
} from "../src/index.js";

const catalog: WidgetCatalog = {
  types: {
    Source: { widget_order: [] },
    TestMulti: { widget_order: ["inputcount"] },
  },
};

const opId = (tag: string): string => (tag + "0".repeat(32)).slice(0, 32);

const source: WorkflowNode = {
  id: 1,
  type: "Source",
  inputs: [],
  outputs: [{ name: "OUT", type: "IMAGE", links: [] }],
  widgets_values: [],
};

const destination: WorkflowNode = {
  id: 2,
  type: "TestMulti",
  inputs: [
    { name: "image_1", type: "IMAGE", link: null },
    { name: "image_2", type: "IMAGE", link: null },
  ],
  outputs: [],
  widgets_values: [2],
};

const workflow: WorkflowJSON = {
  nodes: [source, destination],
  links: [],
  last_node_id: 2,
  last_link_id: 0,
};

function grow(tag: string, actor: string, version: number, linkId: number, requestedName: string): ConnectOp {
  return {
    op: "connect",
    op_id: opId(tag),
    actor,
    base_version: version,
    stamp: [version, actor],
    link_id: linkId,
    from_node: 1,
    from_slot: 0,
    to_node: 2,
    to_slot: null,
    link_type: "IMAGE",
    grow: {
      name: requestedName,
      type: "IMAGE",
      inputcount: { widget: "inputcount", value: 4 },
    },
  };
}

function run(ops: Op[]): WorkflowJSON {
  // Every run forks from the same seeded snapshot (KA-10); only arrival order differs.
  const seeded = mint(workflow, catalog);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(seeded));
  expect(applyOps(doc, ops, catalog).outcomes.some((outcome) => outcome.outcome === "rejected")).toBe(false);
  return project(doc, catalog);
}

function sourceLinks(result: WorkflowJSON): unknown[] {
  const node = result.nodes.find(({ id }) => id === 1)!;
  return (node.outputs as Array<{ links: unknown[] }>)[0]!.links;
}

function targetSlots(result: WorkflowJSON): Map<number, number> {
  return new Map((result.links as Array<[number, number, number, number, number, string]>).map((link) => [link[0], link[4]]));
}

describe("R-69 current-risk characterization: inputcount grow arrival ordering", () => {
  it("retains same-source output link references in arrival order", () => {
    // Exact perm-3 fast-check reproducer: seed 1837591, path
    // 0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0.
    // This pins the current risk; it does not declare arrival ordering desirable.
    const first = grow("r69-first", "agent:a", 5, 921, "image_3");
    const second = grow("r69-second", "human:z", 9, 922, "image_3");

    expect(sourceLinks(run([first, second]))).toEqual([921, 922]);
    expect(sourceLinks(run([second, first]))).toEqual([922, 921]);
  });

  it("assigns target indexes by arrival for distinct requested bare-name families", () => {
    // Different bare requests are normalized in separate grow families, so neither
    // family reorders the other after both have appended to the destination.
    const image = grow("r69-image", "agent:a", 5, 921, "image_3");
    const mask = grow("r69-mask", "human:z", 9, 922, "mask_1");

    expect(targetSlots(run([image, mask]))).toEqual(new Map([[921, 2], [922, 3]]));
    expect(targetSlots(run([mask, image]))).toEqual(new Map([[921, 3], [922, 2]]));
  });
});
