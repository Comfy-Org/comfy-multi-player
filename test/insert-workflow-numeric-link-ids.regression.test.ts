/**
 * `insert_workflow` numeric link ids (ADR-033).
 *
 * ComfyUI_frontend's `LinkId` is `number & { __brand: 'LinkId' }`, unlike the
 * string-or-number `NodeId`, so `remap.ts`'s usual string `derivedId`
 * (`insert:<opId>:<scope>:link:<original>`) cannot satisfy it. The interim
 * frontend fix (ComfyUI_frontend#18458, `ecsFollowerAdapter.ts`'s
 * `resolveLinkId`) hashed that string into a 32-bit number and was found by
 * two reviewers to be genuinely broken, not merely approximate: two
 * independent derived ids collided at a measured ~0.01-1% rate at realistic
 * link counts, AND the resolved id is what `graph.serialize()` persists, so
 * a "reserved range" chosen above `last_link_id` does not survive a
 * save/reload — the saved file now contains a genuine numeric link id
 * inside that range.
 *
 * `remap.ts`'s `derivedLinkId` fixes this at the source: it hashes the same
 * op-id-derived seed to a 52-bit candidate, then verifies it against every
 * numeric link id already persisted in the target document (`doc.ts`'s
 * `persistedLinkIds` — top-level AND every subgraph-definition interior, at
 * any depth) plus every id already minted earlier in the same call, retrying
 * past a collision (bounded, `MAX_LINK_ID_MINT_ATTEMPTS`) rather than
 * accepting one. See `docs/decisions/ADR-033-insert-workflow-numeric-link-ids.md`
 * and the KA-5 row in `docs/decisions/EXCEPTIONS.md`.
 *
 * `test/insert-workflow.test.ts`'s "numeric link id minting (ADR-033)" block
 * covers the single-op avoidance and id-space-exhaustion cases directly
 * against `occupiedIdVectors`' existing node/definition siblings. This file
 * covers the harder cross-cutting properties named in review: collision
 * avoidance that spans top-level and subgraph-interior scopes, multiple
 * `insert_workflow` ops in one session (sequential and same-batch), the
 * exact cross-op collision ComfyUI_frontend#18458 reproduced, scale within
 * one op, save/reload round-trip stability, and comfy-multi-player#230's
 * definition-interior promoted-linkIds threading with the new numeric ids.
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { applyOps, mint, project, type Op, type WidgetCatalog, type WorkflowJSON } from "../src/index.js";
import { appliedMap, persistedLinkIds } from "../src/doc.js";
import { remapInsertedWorkflowIds } from "../src/remap.js";

const catalog: WidgetCatalog = {
  types: {
    Src: { widget_order: [] },
    Sink: { widget_order: [] },
    Def: { widget_order: [] },
  },
};

let seq = 0;
function opEnvelope(overrides: Partial<Op> = {}): Op {
  const op_id = ("n" + String(seq++).padStart(4, "0")).padEnd(32, "0");
  return { op: "insert_workflow", op_id, actor: "a", base_version: 1, stamp: [1, "a"], ...overrides } as unknown as Op;
}

/** All top-level projected link tuples, typed loosely for id/label access. */
function links(wf: WorkflowJSON): Array<[unknown, unknown, unknown, unknown, unknown, unknown]> {
  return (wf.links ?? []) as never;
}

function linkNamed(wf: WorkflowJSON, label: unknown): [unknown, unknown, unknown, unknown, unknown, unknown] {
  const found = links(wf).find((link) => link[5] === label);
  if (!found) throw new Error(`no projected link labeled ${String(label)}`);
  return found;
}

describe("insert_workflow numeric link ids (ADR-033)", () => {
  it("mints a real number for a top-level link while node ids stay derived strings", () => {
    const doc = mint({ nodes: [], links: [] }, catalog);
    const op = opEnvelope({ workflow: { nodes: [{ id: 1, type: "Src" }, { id: 2, type: "Sink" }], links: [[10, 1, 0, 2, 0, "L"]] } });

    expect(applyOps(doc, [op], catalog).outcomes[0]).toMatchObject({ outcome: "applied" });
    const wf = project(doc, catalog);
    expect(typeof linkNamed(wf, "L")[0]).toBe("number");
    for (const node of wf.nodes!) expect(typeof node.id).toBe("string");
  });

  it("reproduces and fixes ComfyUI_frontend#18458's exact cross-op scenario: two independent insert_workflow ops never collide", () => {
    // The reviewers' reproduction used two distinct 32-char op ids whose
    // FNV-1a-folded-to-32-bit hashes collided. This package's mint uses 52
    // bits AND actively verifies against the document, so two distinct ops —
    // regardless of whether their raw hash candidates would have collided —
    // can never persist the same numeric link id.
    const doc = mint({ nodes: [], links: [] }, catalog);
    const opA = opEnvelope({
      workflow: {
        nodes: [{ id: 101, type: "Src" }, { id: 102, type: "Sink" }],
        links: [[201, 101, 0, 102, 0, "op-a-link"]],
      },
    });
    const opB = opEnvelope({
      workflow: {
        nodes: [{ id: 103, type: "Src" }, { id: 104, type: "Sink" }],
        links: [[201, 103, 0, 104, 0, "op-b-link"]],
      },
    });

    expect(applyOps(doc, [opA], catalog).outcomes[0]).toMatchObject({ outcome: "applied" });
    expect(applyOps(doc, [opB], catalog).outcomes[0]).toMatchObject({ outcome: "applied" });

    const wf = project(doc, catalog);
    expect(wf.nodes).toHaveLength(4);
    const linkA = linkNamed(wf, "op-a-link");
    const linkB = linkNamed(wf, "op-b-link");
    expect(linkA[0]).not.toBe(linkB[0]);
    // Op A's wire must not have been replaced by op B's (the reported bug):
    // both endpoints resolve to their OWN op's nodes.
    const nodeIds = new Set(wf.nodes!.map((n) => n.id));
    expect(nodeIds.has(linkA[1] as string)).toBe(true);
    expect(nodeIds.has(linkB[1] as string)).toBe(true);
  });

  it("avoids colliding with a numeric link id in the SAME batch's other insert_workflow op", () => {
    // Same as the cross-op case above, but delivered as ONE `applyOps` batch
    // rather than two sequential calls — op B's mint must see op A's
    // already-committed link (from the earlier `doc.transact` in the same
    // batch) even though nothing has round-tripped through a snapshot yet.
    const doc = mint({ nodes: [], links: [] }, catalog);
    const opA = opEnvelope({
      workflow: { nodes: [{ id: 111, type: "Src" }, { id: 112, type: "Sink" }], links: [[301, 111, 0, 112, 0, "batch-a"]] },
    });
    const opB = opEnvelope({
      workflow: { nodes: [{ id: 113, type: "Src" }, { id: 114, type: "Sink" }], links: [[301, 113, 0, 114, 0, "batch-b"]] },
    });

    const result = applyOps(doc, [opA, opB], catalog);
    expect(result.outcomes).toEqual([
      { op_id: opA.op_id, outcome: "applied" },
      { op_id: opB.op_id, outcome: "applied" },
    ]);
    const wf = project(doc, catalog);
    expect(linkNamed(wf, "batch-a")[0]).not.toBe(linkNamed(wf, "batch-b")[0]);
  });

  it("a top-level insert avoids a numeric link id already used INSIDE an existing subgraph definition", () => {
    // The reservation set spans scopes: a definition's interior links are a
    // real collision domain for a top-level candidate too (`doc.ts`'s
    // `persistedLinkIds` walks every definition, not just the top-level map).
    const opId = "aa11df0c31f9440b9385ac8e01e099b2";
    const occupied = firstCandidate(opId, 501);
    const doc = mint(
      {
        nodes: [{ id: 1, type: "Def" }],
        links: [],
        definitions: {
          subgraphs: [
            {
              id: "Def",
              nodes: [{ id: "x", type: "Src" }, { id: "y", type: "Sink" }],
              links: [{ id: occupied, origin_id: "x", origin_slot: 0, target_id: "y", target_slot: 0, type: "X" }],
            },
          ],
        },
      } as unknown as WorkflowJSON,
      catalog,
    );

    const op = opEnvelope({
      workflow: { nodes: [{ id: 701, type: "Src" }, { id: 702, type: "Sink" }], links: [[501, 701, 0, 702, 0, "top-level"]] },
      op_id: opId,
    });
    expect(applyOps(doc, [op], catalog).outcomes[0]).toMatchObject({ outcome: "applied" });
    const wf = project(doc, catalog);
    expect(linkNamed(wf, "top-level")[0]).not.toBe(occupied);
  });

  it("an inserted subgraph definition's interior link avoids a numeric link id already used at the top level", () => {
    const opId = "bb11df0c31f9440b9385ac8e01e099b2";
    const workflow = {
      nodes: [{ id: 900, type: "NewDef" }],
      links: [],
      definitions: {
        subgraphs: [
          {
            id: "NewDef",
            nodes: [{ id: "p", type: "Src" }, { id: "q", type: "Sink" }],
            links: [{ id: 502, origin_id: "p", origin_slot: 0, target_id: "q", target_slot: 0, type: "X" }],
          },
        ],
      },
    };

    // First, discover the definition-interior candidate this exact (opId,
    // workflow) pair mints against an EMPTY doc — nothing to avoid yet.
    const emptyDoc = mint({ nodes: [], links: [] }, catalog);
    const probe = opEnvelope({ workflow, op_id: opId });
    expect(applyOps(emptyDoc, [probe], catalog).outcomes[0]).toMatchObject({ outcome: "applied" });
    const naturalDefinition = (
      project(emptyDoc, catalog).definitions as { subgraphs: Array<{ links: Array<{ id: unknown }> }> }
    ).subgraphs[0]!;
    const naturalCandidate = naturalDefinition.links[0]!.id as number;

    // Now seed a FRESH doc where that exact numeric id is already a
    // TOP-LEVEL link (never touched by insert_workflow) and re-run the
    // IDENTICAL op. `persistedLinkIds` walks the top-level map, so the
    // definition-interior mint below must land somewhere else.
    const occupiedDoc = mint(
      { nodes: [{ id: 1, type: "Src" }, { id: 2, type: "Sink" }], links: [[naturalCandidate, 1, 0, 2, 0, "top-incumbent"]] },
      catalog,
    );
    const op = opEnvelope({ workflow, op_id: opId });
    expect(applyOps(occupiedDoc, [op], catalog).outcomes[0]).toMatchObject({ outcome: "applied" });

    const wf = project(occupiedDoc, catalog);
    const definition = (wf.definitions as { subgraphs: Array<{ links: Array<{ id: unknown }> }> }).subgraphs[0]!;
    expect(definition.links).toHaveLength(1);
    expect(definition.links[0]!.id).not.toBe(naturalCandidate);
    expect(typeof definition.links[0]!.id).toBe("number");
    // The top-level incumbent is completely untouched.
    expect(linkNamed(wf, "top-incumbent")[0]).toBe(naturalCandidate);
  });

  it("mints distinct ids for a large batch of links inserted in one op", () => {
    const opId = "cc11df0c31f9440b9385ac8e01e099b2";
    const count = 200;
    const nodes = Array.from({ length: count * 2 }, (_, i) => ({ id: `n${String(i)}`, type: i % 2 === 0 ? "Src" : "Sink" }));
    const rawLinks = Array.from({ length: count }, (_, i) => [1000 + i, `n${String(i * 2)}`, 0, `n${String(i * 2 + 1)}`, 0, `link-${String(i)}`]);
    const doc = mint({ nodes: [], links: [] }, catalog);
    const op = opEnvelope({ workflow: { nodes, links: rawLinks }, op_id: opId });

    expect(applyOps(doc, [op], catalog).outcomes[0]).toMatchObject({ outcome: "applied" });
    const wf = project(doc, catalog);
    expect(wf.links).toHaveLength(count);
    const ids = wf.links!.map((link) => (link as unknown[])[0]);
    expect(new Set(ids).size).toBe(count);
    for (const id of ids) expect(typeof id).toBe("number");
  });

  it("survives a save/reload round trip: a re-minted doc's persisted numeric link ids are still avoided by a later insert", () => {
    // The exact failure the second frontend reviewer identified in the
    // interim hash fix: once an inserted link's numeric id is persisted into
    // a saved workflow and the doc is re-minted from that JSON, a later
    // insert must still avoid it — there is no session-local allocator state
    // to lose here, because avoidance is grounded in the DOCUMENT itself.
    const firstOpId = "dd11df0c31f9440b9385ac8e01e099b2";
    const original = mint({ nodes: [], links: [] }, catalog);
    const firstOp = opEnvelope({
      workflow: { nodes: [{ id: 1, type: "Src" }, { id: 2, type: "Sink" }], links: [[601, 1, 0, 2, 0, "persisted"]] },
      op_id: firstOpId,
    });
    expect(applyOps(original, [firstOp], catalog).outcomes[0]).toMatchObject({ outcome: "applied" });
    const persistedWorkflow = project(original, catalog);
    const persistedLinkId = linkNamed(persistedWorkflow, "persisted")[0];
    expect(typeof persistedLinkId).toBe("number");

    // "Save and reload": a FRESH doc, minted from nothing but the projected
    // JSON — no memory of the first doc, no in-process allocator survives.
    const reloaded = mint(persistedWorkflow, catalog);
    expect(persistedLinkIds(reloaded).has(persistedLinkId as number)).toBe(true);

    // A raw id that happens to derive to the SAME candidate the first op
    // used (found deterministically, not by chance) must still avoid it.
    const secondOpId = "ee11df0c31f9440b9385ac8e01e099b2";
    const collidingRaw = firstCandidate(secondOpId, 601) === persistedLinkId ? 601 : findCollidingRawId(secondOpId, persistedLinkId as number);
    if (collidingRaw === undefined) return; // 52 bits: no natural collision is the expected outcome.

    const secondOp = opEnvelope({
      workflow: { nodes: [{ id: 3, type: "Src" }, { id: 4, type: "Sink" }], links: [[collidingRaw, 3, 0, 4, 0, "after-reload"]] },
      op_id: secondOpId,
    });
    expect(applyOps(reloaded, [secondOp], catalog).outcomes[0]).toMatchObject({ outcome: "applied" });
    const after = project(reloaded, catalog);
    expect(linkNamed(after, "after-reload")[0]).not.toBe(persistedLinkId);
  });

  it("round-trips numeric link ids byte-for-byte through project → mint with no duplication or corruption", () => {
    const opId = "ff11df0c31f9440b9385ac8e01e099b2";
    const doc = mint({ nodes: [], links: [] }, catalog);
    const op = opEnvelope({
      workflow: {
        nodes: [{ id: 1, type: "Src" }, { id: 2, type: "Sink" }, { id: 3, type: "Def" }],
        links: [[701, 1, 0, 2, 0, "L1"]],
        definitions: {
          subgraphs: [
            {
              id: "Def",
              nodes: [{ id: "a", type: "Src" }, { id: "b", type: "Sink" }],
              links: [{ id: 702, origin_id: "a", origin_slot: 0, target_id: "b", target_slot: 0, type: "X" }],
            },
          ],
        },
      },
      op_id: opId,
    });
    expect(applyOps(doc, [op], catalog).outcomes[0]).toMatchObject({ outcome: "applied" });
    const first = project(doc, catalog);

    const reminted = mint(first, catalog);
    const second = project(reminted, catalog);
    expect(second).toEqual(first);
  });

  it("subgraph-interior promoted linkIds thread numeric ids end-to-end (comfy-multi-player#230 non-regression)", () => {
    // Mirrors `test/insert-workflow-promoted-input-linkids.regression.test.ts`
    // but through the REAL applier + project path, asserting the ids
    // `remapLinkIdArray` threads into a definition's own `inputs[].linkIds`
    // are the SAME real numbers as `links[].id` — exactly what ComfyUI_
    // frontend's `agentSubgraphHostSlots.ts` (`Map<number, ...>` keyed by
    // `link.id`) needs to resolve a promoted widget.
    const opId = "0011df0c31f9440b9385ac8e01e099b2";
    const doc = mint({ nodes: [], links: [] }, catalog);
    const op = opEnvelope({
      workflow: {
        nodes: [{ id: 100, type: "PromotedDef", inputs: [{ name: "text", type: "STRING", link: null, widget: { name: "text" } }] }],
        links: [],
        definitions: {
          subgraphs: [
            {
              id: "PromotedDef",
              name: "Promoted text",
              inputs: [{ name: "text", type: "STRING", linkIds: [34] }],
              outputs: [],
              nodes: [
                { id: 10, type: "Src", inputs: [], outputs: [{ name: "STRING", type: "STRING", links: [34] }] },
                { id: 11, type: "Def", inputs: [{ name: "text", type: "STRING", link: 34, widget: { name: "text" } }], outputs: [] },
              ],
              links: [{ id: 34, origin_id: 10, origin_slot: 0, target_id: 11, target_slot: 0, type: "STRING" }],
            },
          ],
        },
      },
      op_id: opId,
    });

    expect(applyOps(doc, [op], catalog).outcomes[0]).toMatchObject({ outcome: "applied" });
    const wf = project(doc, catalog);
    const definition = (
      wf.definitions as { subgraphs: Array<{ inputs: Array<{ linkIds: unknown[] }>; links: Array<{ id: unknown }> }> }
    ).subgraphs[0]!;

    expect(definition.links).toHaveLength(1);
    const realLinkId = definition.links[0]!.id;
    expect(typeof realLinkId).toBe("number");
    // The promoted input names the SAME numeric id, not a stringified or
    // otherwise-derived stand-in — a `Map<number, Link>` keyed by
    // `definition.links[].id` resolves `inputs[0].linkIds[0]` directly.
    expect(definition.inputs[0]!.linkIds).toEqual([realLinkId]);
  });

  it("keeps a definition-interior link fed by the subgraph IO sentinels numeric (sentinel non-regression)", () => {
    const opId = "1122df0c31f9440b9385ac8e01e099b2";
    const doc = mint({ nodes: [], links: [] }, catalog);
    const op = opEnvelope({
      workflow: {
        nodes: [
          {
            id: 100,
            type: "SentinelDef",
            inputs: [{ name: "text", type: "STRING", link: null, widget: { name: "text" } }],
            outputs: [{ name: "IMAGE", type: "IMAGE", links: [] }],
          },
        ],
        links: [],
        definitions: {
          subgraphs: [
            {
              id: "SentinelDef",
              name: "Sentinel",
              inputs: [{ name: "text", type: "STRING", linkIds: [16] }],
              outputs: [{ name: "IMAGE", type: "IMAGE", linkIds: [17] }],
              nodes: [
                { id: 27, type: "Def", inputs: [{ name: "text", type: "STRING", link: 16, widget: { name: "text" } }], outputs: [] },
                { id: 8, type: "Src", inputs: [], outputs: [{ name: "IMAGE", type: "IMAGE", links: [17] }] },
              ],
              links: [
                { id: 16, origin_id: -10, origin_slot: 0, target_id: 27, target_slot: 1, type: "STRING" },
                { id: 17, origin_id: 8, origin_slot: 0, target_id: -20, target_slot: 0, type: "IMAGE" },
              ],
            },
          ],
        },
      },
      op_id: opId,
    });

    expect(applyOps(doc, [op], catalog).outcomes[0]).toMatchObject({ outcome: "applied" });
    const wf = project(doc, catalog);
    const definition = (
      wf.definitions as {
        subgraphs: Array<{
          inputs: Array<{ linkIds: unknown[] }>;
          outputs: Array<{ linkIds: unknown[] }>;
          links: Array<{ id: unknown; origin_id: unknown; target_id: unknown }>;
        }>;
      }
    ).subgraphs[0]!;

    expect(definition.links).toHaveLength(2);
    const promotedLink = definition.links.find((link) => link.origin_id === -10)!;
    const exposedLink = definition.links.find((link) => link.target_id === -20)!;
    expect(typeof promotedLink.id).toBe("number");
    expect(typeof exposedLink.id).toBe("number");
    expect(definition.inputs[0]!.linkIds).toEqual([promotedLink.id]);
    expect(definition.outputs[0]!.linkIds).toEqual([exposedLink.id]);
  });

  it("an exact replay (same op_id, same payload) is a true no-op and does not re-mint the link id", () => {
    const opId = "2233df0c31f9440b9385ac8e01e099b2";
    const doc = mint({ nodes: [], links: [] }, catalog);
    const op = opEnvelope({
      workflow: { nodes: [{ id: 1, type: "Src" }, { id: 2, type: "Sink" }], links: [[801, 1, 0, 2, 0, "L"]] },
      op_id: opId,
    });

    expect(applyOps(doc, [op], catalog).outcomes[0]).toMatchObject({ outcome: "applied" });
    const firstProjection = project(doc, catalog);
    const mintedId = linkNamed(firstProjection, "L")[0];
    const beforeReplay = Buffer.from(Y.encodeStateAsUpdate(doc));

    expect(applyOps(doc, [op], catalog).outcomes[0]).toMatchObject({ outcome: "no-op" });
    expect(Buffer.from(Y.encodeStateAsUpdate(doc)).equals(beforeReplay)).toBe(true);
    expect(appliedMap(doc).has(op.op_id)).toBe(true);
    const afterReplay = project(doc, catalog);
    expect(linkNamed(afterReplay, "L")[0]).toBe(mintedId);
  });
});

/** The candidate `derivedLinkId` would pick at root scope for (`opId`, `rawLinkId`) with no reservations. */
function firstCandidate(opId: string, rawLinkId: number): number {
  const remapped = remapInsertedWorkflowIds(
    { nodes: [{ id: "a", type: "Src" }, { id: "b", type: "Sink" }], links: [[rawLinkId, "a", 0, "b", 0, "x"]] } as unknown as WorkflowJSON,
    opId,
  ) as unknown as { links: Array<[number, ...unknown[]]> };
  return remapped.links[0]![0];
}

/** Search a small range of raw link ids for one whose first candidate (given `opId`) equals `target`. */
function findCollidingRawId(opId: string, target: number): number | undefined {
  for (let raw = 1; raw < 5000; raw++) {
    if (firstCandidate(opId, raw) === target) return raw;
  }
  return undefined;
}
