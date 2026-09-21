/**
 * `set_title` (ADR-032): a node's `title` is a passthrough field on the
 * `add_node` snapshot (schema §1.1), but nothing updates it afterward — a
 * canvas rename never produced an op, so it never replicated to other
 * clients. This file pins the gap and, once implemented, the op that closes
 * it: LWW-gated like a top-level `set_widget`, on its own
 * `("title", node_id, node_incarnation)` register
 * (docs/multiplayer-schema.md §3).
 */
import { describe, expect, it } from "vitest";
import { applyOps, mint, project, type Op, type WorkflowJSON, type WorkflowNode } from "../src/index.js";
import { loadCatalog } from "./helpers.js";

const catalog = loadCatalog();
const NODE = 1;

function envelope(actor: string, baseVersion: number, opId: string) {
  return { op_id: opId, actor, base_version: baseVersion, stamp: [baseVersion, actor] as [number, string] };
}

function opId(tag: string): string {
  return (tag + "0".repeat(32)).slice(0, 32);
}

function node(title?: string): WorkflowNode {
  return {
    id: NODE,
    type: "KSampler",
    pos: [0, 0],
    inputs: [],
    outputs: [],
    widgets_values: [0, "fixed", 20, 8, "euler", "simple", 1],
    ...(title !== undefined ? { title } : {}),
  };
}

function workflow(title?: string): WorkflowJSON {
  return { nodes: [node(title)], links: [] };
}

describe("the gap set_title closes: a canvas rename never produces a syncable op", () => {
  it("renaming a node after add_node has no way to reach the document", () => {
    const doc = mint(workflow("Original title"), catalog);

    // A `set_title` op, exactly as a client would mint it for a rename.
    const rename = {
      op: "set_title",
      ...envelope("human:u1:tab1", 1, opId("a")),
      node_id: NODE,
      title: "Renamed by user",
    } as unknown as Op;

    const result = applyOps(doc, [rename], catalog);

    // Today this is rejected as an unknown op kind — there is no vocabulary
    // entry for "rename this node's title" — so the rename is silently lost
    // rather than replicated. Once `set_title` exists, this must apply and
    // the new title must be visible to every replica that projects the doc.
    expect(result.outcomes[0]).toMatchObject({ op_id: rename.op_id, outcome: "applied" });
    const projected = project(doc, catalog).nodes.find((n) => n.id === NODE);
    expect(projected?.title).toBe("Renamed by user");
  });
});
