/**
 * `set_title` (ADR-032): a node's `title` is a passthrough field on the
 * `add_node` snapshot (schema §1.1), but nothing updates it afterward — a
 * canvas rename never produced an op, so it never replicated to other
 * clients. This file pins the gap and, once implemented, the op that closes
 * it: LWW-gated like a top-level `set_widget`, on its own
 * `("title", node_id, node_incarnation)` register
 * (docs/multiplayer-schema.md §3).
 */
import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import {
  applyOps,
  mint,
  project,
  type DeleteNodeOp,
  type Op,
  type SetTitleOp,
  type WorkflowJSON,
  type WorkflowNode,
} from "../src/index.js";
import { appliedMap } from "../src/doc.js";
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

function rename(actor: string, baseVersion: number, tag: string, title: string | null): SetTitleOp {
  return { op: "set_title", ...envelope(actor, baseVersion, opId(tag)), node_id: NODE, title };
}

describe("set_title — LWW convergence (schema §3, mirrors top-level set_widget)", () => {
  it("a higher base_version wins regardless of arrival order", () => {
    const loser = rename("alice", 1, "lo", "From Alice");
    const winner = rename("bob", 2, "hi", "From Bob");

    const forward = mint(workflow("Original"), catalog);
    applyOps(forward, [loser, winner], catalog);
    const backward = mint(workflow("Original"), catalog);
    applyOps(backward, [winner, loser], catalog);

    for (const doc of [forward, backward]) {
      expect(project(doc, catalog).nodes.find((n) => n.id === NODE)?.title).toBe("From Bob");
    }
  });

  it("ties on base_version break by actor (code-point order), then by op_id", () => {
    const zed = rename("zed", 5, "z", "From Zed");
    const alice = rename("alice", 5, "a", "From Alice");

    const doc = mint(workflow("Original"), catalog);
    const result = applyOps(doc, [zed, alice], catalog);

    // "alice" < "zed" by code point, so alice's stamp is LOWER — zed's write
    // (the higher actor) wins and alice's op is dropped, not rejected: it
    // still consumes its op_id (vocabulary §3 rule 4).
    expect(result.outcomes[1]).toMatchObject({ op_id: alice.op_id, outcome: "lww-dropped" });
    expect(project(doc, catalog).nodes.find((n) => n.id === NODE)?.title).toBe("From Zed");
    expect(appliedMap(doc).has(alice.op_id)).toBe(true);
  });

  it("a lower-or-equal stamp is dropped even for a byte-identical replay of the incumbent", () => {
    const first = rename("alice", 3, "f", "First");
    const doc = mint(workflow("Original"), catalog);
    applyOps(doc, [first], catalog);
    const before = Buffer.from(Y.encodeStateAsUpdate(doc));

    const stale = rename("alice", 1, "s", "Stale");
    const result = applyOps(doc, [stale], catalog);

    expect(result.outcomes[0]?.outcome).toBe("lww-dropped");
    expect(project(doc, catalog).nodes.find((n) => n.id === NODE)?.title).toBe("First");
    expect(Buffer.from(Y.encodeStateAsUpdate(doc)).equals(before)).toBe(false); // op_id bookkeeping still records
  });

  it("clears a custom title back to the class default with title: null", () => {
    const doc = mint(workflow("Custom title"), catalog);
    const result = applyOps(doc, [rename("alice", 1, "clr", null)], catalog);

    expect(result.outcomes[0]?.outcome).toBe("applied");
    const projected = project(doc, catalog).nodes.find((n) => n.id === NODE);
    expect(projected).not.toHaveProperty("title");
  });
});

describe("set_title racing delete_node (delete-wins, vocabulary §3 rule 4)", () => {
  function deleteNode(actor: string, baseVersion: number, tag: string): DeleteNodeOp {
    return { op: "delete_node", ...envelope(actor, baseVersion, opId(tag)), node_id: NODE, removed_links: [] };
  }

  it("converges to 'no node' in either arrival order", () => {
    const del = deleteNode("alice", 1, "d");
    const ren = rename("bob", 2, "r", "Too late");

    const forward = mint(workflow("Original"), catalog);
    applyOps(forward, [del, ren], catalog);
    const backward = mint(workflow("Original"), catalog);
    applyOps(backward, [ren, del], catalog);

    for (const doc of [forward, backward]) {
      expect(project(doc, catalog).nodes.find((n) => n.id === NODE)).toBeUndefined();
    }
  });

  it("a rename against an already-deleted node is a silent no-op that still consumes its op_id", () => {
    const doc = mint(workflow("Original"), catalog);
    applyOps(doc, [deleteNode("alice", 1, "d2")], catalog);

    const ren = rename("bob", 2, "r2", "Ghost rename");
    const result = applyOps(doc, [ren], catalog);

    expect(result.outcomes[0]).toMatchObject({ op_id: ren.op_id, outcome: "no-op" });
    expect(appliedMap(doc).has(ren.op_id)).toBe(true);
    expect(project(doc, catalog).nodes.find((n) => n.id === NODE)).toBeUndefined();
  });
});

describe("set_title idempotency and rejection (KA-4)", () => {
  it("re-applying the same op is a byte-identical no-op", () => {
    const op = rename("alice", 1, "idem", "Idempotent");
    const doc = mint(workflow("Original"), catalog);
    applyOps(doc, [op], catalog);
    const before = Buffer.from(Y.encodeStateAsUpdate(doc));

    const again = applyOps(doc, [op], catalog);

    expect(again.outcomes).toEqual([{ op_id: op.op_id, outcome: "no-op" }]);
    expect(Buffer.from(Y.encodeStateAsUpdate(doc)).equals(before)).toBe(true);
  });

  it("rejects a non-string, non-null title as malformed_op without mutating the doc", () => {
    const doc = mint(workflow("Original"), catalog);
    const before = Buffer.from(Y.encodeStateAsUpdate(doc));
    const bad = { op: "set_title", ...envelope("alice", 1, opId("bad")), node_id: NODE, title: 42 } as unknown as Op;

    const result = applyOps(doc, [bad], catalog);

    expect(result.outcomes[0]).toMatchObject({ outcome: "rejected", reason: { code: "malformed_op" } });
    expect(Buffer.from(Y.encodeStateAsUpdate(doc)).equals(before)).toBe(true);
    expect(appliedMap(doc).has((bad as { op_id: string }).op_id)).toBe(false);
  });

  it("rejects a missing node_id as malformed_op", () => {
    const doc = mint(workflow("Original"), catalog);
    const bad = { op: "set_title", ...envelope("alice", 1, opId("nid")), title: "x" } as unknown as Op;

    const result = applyOps(doc, [bad], catalog);

    expect(result.outcomes[0]).toMatchObject({ outcome: "rejected", reason: { code: "malformed_op" } });
  });
});
