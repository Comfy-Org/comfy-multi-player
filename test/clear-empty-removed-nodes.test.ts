import { describe, expect, it } from "vitest";
import { applyOps, mint, project, type ClearOp, type WorkflowJSON } from "../src/index.js";
import { loadCatalog } from "./helpers.js";

const catalog = loadCatalog();

function threeNodeWorkflow(withGroups: boolean): WorkflowJSON {
  const workflow: WorkflowJSON = {
    nodes: [
      {
        id: 1, type: "LoadImage", inputs: [],
        outputs: [{ name: "IMAGE", type: "IMAGE", links: [10] }], widgets_values: [],
      },
      {
        id: 2, type: "PreviewImage",
        inputs: [{ name: "images", type: "IMAGE", link: 10 }],
        outputs: [{ name: "IMAGE", type: "IMAGE", links: [11] }], widgets_values: [],
      },
      {
        id: 3, type: "PreviewImage",
        inputs: [{ name: "images", type: "IMAGE", link: 11 }], outputs: [], widgets_values: [],
      },
    ],
    links: [[10, 1, 0, 2, 0, "IMAGE"], [11, 2, 0, 3, 0, "IMAGE"]],
    last_node_id: 3,
    last_link_id: 11,
    extra: {},
  };
  if (withGroups) {
    workflow.groups = [
      {
        id: 1,
        title: "nodes 1-2",
        bounding: [0, 0, 640, 320],
        color: "#3f789e",
        font_size: 24,
        flags: {},
      },
    ];
  } else {
    delete workflow.groups;
  }
  return workflow;
}

function clearEmpty(baseVersion: number): ClearOp {
  return {
    op: "clear",
    op_id: String(baseVersion).padStart(32, "0"),
    actor: "alice",
    base_version: baseVersion,
    stamp: [baseVersion, "alice"],
    removed_nodes: [],
  };
}

describe("clear([]) current-behavior characterization", () => {
  it("keeps nodes and links when the document has no groups key", () => {
    const workflow = threeNodeWorkflow(false);
    expect(workflow.nodes).toHaveLength(3);
    expect(workflow.links).toHaveLength(2);
    const doc = mint(workflow, catalog);
    const before = project(doc, catalog);
    const beforeBytes = JSON.stringify(before);

    const result = applyOps(doc, [clearEmpty(1)], catalog);

    expect(result.outcomes).toEqual([{ op_id: "00000000000000000000000000000001", outcome: "no-op" }]);
    expect(JSON.stringify(project(doc, catalog))).toBe(beforeBytes);
  });

  it("resets an existing groups array even though removed_nodes is empty", () => {
    const workflow = threeNodeWorkflow(true);
    const doc = mint(workflow, catalog);
    const before = project(doc, catalog);

    const result = applyOps(doc, [clearEmpty(2)], catalog);
    const projected = project(doc, catalog);

    expect(result.outcomes).toEqual([{ op_id: "00000000000000000000000000000002", outcome: "applied" }]);
    expect(projected.nodes).toEqual(before.nodes);
    expect(projected.links).toEqual(before.links);
    expect(projected.groups).toEqual([]);
  });

  it("does not invent a missing groups key", () => {
    const workflow = threeNodeWorkflow(false);
    const doc = mint(workflow, catalog);

    const result = applyOps(doc, [clearEmpty(3)], catalog);
    const projected = project(doc, catalog);

    expect(result.outcomes).toEqual([{ op_id: "00000000000000000000000000000003", outcome: "no-op" }]);
    expect(projected.groups).toBeUndefined();
    expect("groups" in projected).toBe(false);
  });
});
