/**
 * Two corrections to the value gates, kept separate on purpose.
 *
 * PIECE 1 — a reference CYCLE is rejected (issue #14). A cyclic op payload is
 * accepted at every site today; `applyOps` reports success; and then
 * `encodeStateAsUpdate` throws `RangeError` for the rest of the document's
 * life. The document cannot be snapshotted, persisted, synced, or compared for
 * the KA-4 byte-identity assertions, and `project()` throws too. One accepted
 * op BRICKS the document, which is a strictly worse outcome than the silent
 * divergence the rest of this neighbourhood is about. Rejecting it narrows
 * nothing any real producer could send: neither `JSON.stringify` nor Python's
 * `json.dumps` can express a cycle (both raise), and the JSON grammar has no
 * reference syntax, so no `JSON.parse` / `json.loads` output can contain one.
 *
 * PIECE 2 — the gate's predicate is corrected from "will yjs ACCEPT this
 * value" to "will this value SURVIVE encoding". `isStorableMapValue` is a
 * faithful mirror of yjs `typeMapSet` and stays that way; it is simply the
 * wrong question for a gate. Two values it accepts at depth 0 diverge across
 * replicas: a `Date`, where one replica projects `"1970-01-01T…"` and the
 * other `{}`, and a `BigInt` wider than int64, which lib0 `writeBigInt64`
 * TRUNCATES — `2n**70n` decodes as `0n`.
 *
 * BOUNDARY. Neither piece is the pending D4 decision (whether to reject a
 * payload whose INTERIOR does not survive encoding). Both gates stay SHALLOW
 * apart from the cycle walk, and the tests at the bottom pin that: a `Map` or a
 * `Date` nested inside an accepted container is still accepted, and so are the
 * two shallow-lossy values outside the cycle/`Date`/`BigInt` set that this
 * change deliberately does not touch (boxed primitive objects at a Y.Map slot,
 * and an `ArrayBuffer` at a Y.Array item).
 *
 * Invariants: KA-1 (ops are the replication unit — a divergent value defeats
 * it), KA-3 (one implementation, identical results everywhere), KA-4 / D4 (a
 * rejected op leaves the document byte-identical and does not burn its op_id).
 */

import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import {
  applyOps,
  appliedMap,
  encodingLosses,
  isStorableArrayItem,
  isStorableMapValue,
  mint,
  project,
  type Op,
  type WidgetCatalog,
  type WorkflowJSON,
} from "../src/index.js";
import { loadCatalog } from "./helpers.js";

const catalog = loadCatalog();
/** Same catalog, but with a real `inputcount` widget on the grow destination. */
const countingCatalog: WidgetCatalog = {
  ...catalog,
  types: {
    ...catalog.types,
    BatchImagesNode: { ...catalog.types["BatchImagesNode"]!, widget_order: ["inputcount"] },
  },
};
const opId = (tag: string) => (tag + "0".repeat(32)).slice(0, 32);

/**
 * Deliberately NOT the empty workflow. An assertion of the form "the rejected
 * op changed no bytes" passes for free on a document with nothing to change,
 * which is how this class of defect outlived a suite full of such assertions
 * (see `reject-no-mutation.regression.test.ts` §1). This fixture has two nodes,
 * a live link, an OCCUPIED destination slot and an EMPTY one, existing widget
 * values, and meta passthrough — so every rejected op below has something it
 * could have damaged.
 */
const source = {
  id: 300,
  type: "LoadImage",
  inputs: [],
  outputs: [{ name: "IMAGE", type: "IMAGE", links: [9000] }],
  widgets_values: ["before.png"],
};
const destination = {
  id: 700,
  type: "BatchImagesNode",
  inputs: [
    { name: "images.image0", type: "IMAGE", link: 9000 },
    { name: "images.image1", type: "IMAGE", link: null },
  ],
  outputs: [{ name: "IMAGE", type: "IMAGE", links: [] }],
  widgets_values: [],
};
const workflow: WorkflowJSON = {
  nodes: [source, destination],
  links: [[9000, 300, 0, 700, 0, "IMAGE"]],
  groups: [],
  extra: { ds: { scale: 1 } },
  last_node_id: 700,
  last_link_id: 9000,
};

function bytes(doc: Y.Doc): Buffer {
  return Buffer.from(Y.encodeStateAsUpdate(doc));
}

function setWidget(value: unknown, tag: string): Op {
  return {
    op: "set_widget",
    op_id: opId(tag),
    actor: "human:z",
    base_version: 9,
    stamp: [9, "human:z"],
    node_id: 300,
    widget: "image",
    value,
  } as Op;
}

/** A fresh direct cycle: `c.self === c`. */
function directCycle(): Record<string, unknown> {
  const c: Record<string, unknown> = { tag: "cyclic" };
  c["self"] = c;
  return c;
}

/** A fresh INDIRECT cycle through an array: `a[0].back === a`. */
function indirectCycle(): unknown[] {
  const a: unknown[] = [];
  a.push({ back: a });
  return a;
}

/**
 * KA-4 / D4, plus the thing this change is actually about: the document is
 * still USABLE afterwards. On the base branch a cyclic payload is accepted and
 * every later `encodeStateAsUpdate` throws, so `before`/`after` cannot even be
 * measured — the assertion below is not "the bytes matched", it is "there were
 * bytes at all".
 */
function assertRejectedAndRecoverable(
  op: Op,
  code: string,
  withCatalog: WidgetCatalog = catalog,
): void {
  const doc = mint(workflow, withCatalog);
  const peer = new Y.Doc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc)); // KA-10: fork, never re-seed
  const before = bytes(doc);

  expect(applyOps(doc, [op], withCatalog).failed).toMatchObject({ code });

  // The document survives: it can still be encoded, projected and compared.
  expect(bytes(doc).equals(before)).toBe(true);
  expect(() => project(doc, withCatalog)).not.toThrow();
  // …and the op is retryable, because it never burned its op_id.
  expect(appliedMap(doc).has(op.op_id)).toBe(false);
  expect(applyOps(doc, [op], withCatalog).failed).toMatchObject({ code });
  expect(bytes(doc).equals(before)).toBe(true);

  // …and the document still accepts, encodes and replicates real work
  // afterwards, which is the whole point: a rejection is recoverable, a bricked
  // document is not.
  const later = setWidget("after.png", `later-${op.op_id.slice(0, 6)}`);
  expect(applyOps(doc, [later], withCatalog).failed).toBeNull();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
  expect(bytes(peer).equals(bytes(doc))).toBe(true);
  expect(JSON.stringify(project(peer, withCatalog))).toBe(
    JSON.stringify(project(doc, withCatalog)),
  );
  expect(project(doc, withCatalog).nodes.find((n) => n.id === 300)!["widgets_values"]).toEqual([
    "after.png",
  ]);
}

// ---------------------------------------------------------------------------
// PIECE 1 — reference cycles
// ---------------------------------------------------------------------------

describe("a reference cycle is refused before it can brick the document (#14)", () => {
  it("set_widget with a cyclic value", () => {
    assertRejectedAndRecoverable(setWidget(directCycle(), "cyc-widget"), "malformed_op");
  });

  it("set_widget with the cycle nested inside an accepted container", () => {
    // Depth is irrelevant to the failure: lib0 `writeAny` walks the interior,
    // so a cycle anywhere inside the payload is the same non-terminating
    // encode. This is the ONE place the cycle guard is deep, and it is deep
    // because a shallow one would not close the bug.
    assertRejectedAndRecoverable(
      setWidget({ properties: [{ deep: directCycle() }] }, "cyc-deep"),
      "malformed_op",
    );
  });

  it("set_widget with an indirect cycle through an array", () => {
    assertRejectedAndRecoverable(setWidget(indirectCycle(), "cyc-arr"), "malformed_op");
  });

  it("add_node with a cyclic node payload", () => {
    assertRejectedAndRecoverable(
      {
        op: "add_node",
        op_id: opId("cyc-add"),
        actor: "human:z",
        base_version: 9,
        stamp: [9, "human:z"],
        node_id: 901,
        node: {
          id: 901,
          type: "CLIPTextEncode",
          inputs: [],
          outputs: [],
          widgets_values: { text: "hi" },
          properties: directCycle(),
        },
      } as unknown as Op,
      "invalid_node_payload",
    );
  });

  it("add_node whose payload references the node itself", () => {
    // The shape a live LiteGraph object actually has: a node holding a
    // back-reference into the graph that holds it.
    const node: Record<string, unknown> = {
      id: 902,
      type: "CLIPTextEncode",
      inputs: [],
      outputs: [],
      widgets_values: { text: "hi" },
    };
    node["graph"] = { nodes: [node] };
    assertRejectedAndRecoverable(
      {
        op: "add_node",
        op_id: opId("cyc-self"),
        actor: "human:z",
        base_version: 9,
        stamp: [9, "human:z"],
        node_id: 902,
        node,
      } as unknown as Op,
      "invalid_node_payload",
    );
  });

  it("connect with a cyclic link_id", () => {
    assertRejectedAndRecoverable(
      {
        op: "connect",
        op_id: opId("cyc-link"),
        actor: "human:z",
        base_version: 9,
        stamp: [9, "human:z"],
        link_id: directCycle() as unknown as number,
        from_node: 300,
        from_slot: 0,
        to_node: 700,
        to_slot: 0,
        link_type: "IMAGE",
      } as unknown as Op,
      "malformed_op",
    );
  });

  it("connect with a cyclic grow.inputcount value", () => {
    assertRejectedAndRecoverable(
      {
        op: "connect",
        op_id: opId("cyc-grow"),
        actor: "human:z",
        base_version: 9,
        stamp: [9, "human:z"],
        link_id: 9501,
        from_node: 300,
        from_slot: 0,
        to_node: 700,
        to_slot: null,
        link_type: "IMAGE",
        grow: {
          name: "images.image2",
          type: "IMAGE",
          inputcount: { widget: "inputcount", value: directCycle() },
        },
      } as unknown as Op,
      "malformed_op",
      countingCatalog,
    );
  });

  it("mint refuses a cycle at every write it owns, naming the workflow key", () => {
    expect(() => mint({ ...workflow, extra: directCycle() }, catalog)).toThrow(
      /workflow\.extra: a reference cycle/,
    );
    expect(() =>
      mint({ ...workflow, links: [[9000, 300, 0, 700, 0, directCycle()]] }, catalog),
    ).toThrow(/mint: link: a reference cycle/);
    expect(() =>
      mint(
        { ...workflow, nodes: [{ ...source, properties: directCycle() }] } as WorkflowJSON,
        catalog,
      ),
    ).toThrow(/properties: a reference cycle/);
    expect(() =>
      mint(
        {
          ...workflow,
          definitions: {
            subgraphs: [{ id: "d1", nodes: [], links: [], custom: directCycle() }],
          },
        } as unknown as WorkflowJSON,
        catalog,
      ),
    ).toThrow(/definition\.custom: a reference cycle/);
    expect(() =>
      mint(
        { ...workflow, definitions: { subgraphs: [], other: directCycle() } } as unknown as WorkflowJSON,
        catalog,
      ),
    ).toThrow(/definitions: a reference cycle/);
    // Every one of those throws BEFORE returning a doc, so there is no
    // half-built document to encode — mint's contract is all-or-nothing.
  });

  it("a shared reference that is not a cycle still applies (the guard is not `any repeated object`)", () => {
    // A DAG is fine: `writeAny` duplicates a shared reference and terminates.
    // Without this row the cycle guard could be `seen.has(obj)` — which would
    // reject a perfectly legal payload — and every other row would still pass.
    const shared = { v: 1 };
    const doc = mint(workflow, catalog);
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    expect(applyOps(doc, [setWidget({ a: shared, b: shared }, "dag")], catalog).failed).toBeNull();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    expect(bytes(peer).equals(bytes(doc))).toBe(true);
    expect(
      ((peer.getMap("nodes").get("300") as Y.Map<unknown>).get("widgets") as Y.Map<unknown>).get(
        "image",
      ),
    ).toEqual({ a: { v: 1 }, b: { v: 1 } });
  });

});

// ---------------------------------------------------------------------------
// PIECE 2 — storable is the wrong predicate; encodable is the right one
// ---------------------------------------------------------------------------

describe("the gate asks whether a value survives encoding, not whether yjs accepts it", () => {
  it("a Date at a Y.Map slot is refused instead of diverging the replicas", () => {
    assertRejectedAndRecoverable(setWidget(new Date(0), "date-widget"), "malformed_op");
  });

  it("a BigInt wider than int64 is refused instead of being silently truncated to 0n", () => {
    assertRejectedAndRecoverable(setWidget(2n ** 70n, "big-widget"), "malformed_op");
  });

  it.each([
    ["2^63 (the first value that truncates)", 2n ** 63n],
    ["-2^63 - 1 (the first negative that truncates)", -(2n ** 63n) - 1n],
  ])("the int64 boundary is exact: %s is refused", (_label, value) => {
    assertRejectedAndRecoverable(setWidget(value, `big-${String(value).slice(0, 6)}`), "malformed_op");
  });

  it.each([
    ["0n", 0n],
    ["10n", 10n],
    ["2^63 - 1 (the largest that survives)", 2n ** 63n - 1n],
    ["-2^63 (the smallest that survives)", -(2n ** 63n)],
  ])("the int64 boundary is exact: %s still applies", (_label, value) => {
    // The correction must not become "reject BigInt": a BigInt that fits int64
    // round-trips losslessly and stays legal.
    const doc = mint(workflow, catalog);
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    expect(applyOps(doc, [setWidget(value, `ok-${String(value).slice(0, 8)}`)], catalog).failed)
      .toBeNull();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    expect(
      ((peer.getMap("nodes").get("300") as Y.Map<unknown>).get("widgets") as Y.Map<unknown>).get(
        "image",
      ),
    ).toBe(value);
  });

  it("a Date in an add_node payload is refused before the node map is integrated", () => {
    assertRejectedAndRecoverable(
      {
        op: "add_node",
        op_id: opId("date-add"),
        actor: "human:z",
        base_version: 9,
        stamp: [9, "human:z"],
        node_id: 903,
        node: {
          id: 903,
          type: "CLIPTextEncode",
          inputs: [],
          outputs: [],
          widgets_values: { text: new Date(0) },
        },
      } as unknown as Op,
      "invalid_node_payload",
    );
  });

  it("a Date in a connect grow.inputcount value is refused before the slot is grown", () => {
    assertRejectedAndRecoverable(
      {
        op: "connect",
        op_id: opId("date-grow"),
        actor: "human:z",
        base_version: 9,
        stamp: [9, "human:z"],
        link_id: 9502,
        from_node: 300,
        from_slot: 0,
        to_node: 700,
        to_slot: null,
        link_type: "IMAGE",
        grow: {
          name: "images.image2",
          type: "IMAGE",
          inputcount: { widget: "inputcount", value: new Date(0) },
        },
      } as unknown as Op,
      "malformed_op",
      countingCatalog,
    );
  });

  it("mint refuses a Date and an oversized BigInt at the writes it owns", () => {
    expect(() => mint({ ...workflow, extra: new Date(0) as unknown as object }, catalog)).toThrow(
      /workflow\.extra: a Date does not survive encoding/,
    );
    expect(() =>
      mint({ ...workflow, extra: (2n ** 70n) as unknown as object }, catalog),
    ).toThrow(/workflow\.extra: BigInt /);
    // A value that DOES survive still mints.
    expect(() => mint({ ...workflow, extra: 10n as unknown as object }, catalog)).not.toThrow();
  });

});

// ---------------------------------------------------------------------------
// BOUNDARY — what this change deliberately does NOT do (pending decision D4)
// ---------------------------------------------------------------------------

describe("the correction stops at the boundary of the pending decision", () => {
  const stillAccepted: Array<[string, unknown]> = [
    ["a Map nested at depth 1", { a: new Map([["k", "v"]]) }],
    ["a Map nested at depth 3", { a: { b: { c: new Map() } } }],
    ["a Map nested in an array", [new Map()]],
    ["a Date nested at depth 1", { a: new Date(0) }],
    ["an oversized BigInt nested at depth 1", { a: 2n ** 70n }],
    ["a boxed Number at depth 0", new Number(1)],
    ["a boxed String at depth 0", new String("ab")],
    ["a boxed Boolean at depth 0", new Boolean(true)],
  ];

  it.each(stillAccepted)(
    "%s is still ACCEPTED — narrowing it further is decision D4, not this fix",
    (label, value) => {
      const doc = mint(workflow, catalog);
      expect(applyOps(doc, [setWidget(value, `keep-${label.length}`)], catalog).failed).toBeNull();
      // Still lossy, and still reported by the detector — accepted, not blessed.
      expect(encodingLosses(structuredClone(value)).length).toBeGreaterThan(0);
      // And the document is not bricked by any of them, which is the line
      // between this fix and that decision.
      expect(() => Y.encodeStateAsUpdate(doc)).not.toThrow();
    },
  );

  it("an ArrayBuffer is still accepted as a Y.Array item, where it decodes as a Uint8Array", () => {
    // The array gate gains only the cycle walk. `isStorableArrayItem` accepts an
    // ArrayBuffer, yjs stores it as ContentBinary, and it decodes as a
    // Uint8Array — lossy in type, and outside the cycle/Date/BigInt set this
    // change is scoped to.
    expect(isStorableArrayItem(new ArrayBuffer(4))).toBe(true);
    const doc = mint(workflow, catalog);
    expect(
      applyOps(
        doc,
        [
          {
            op: "add_node",
            op_id: opId("ab-item"),
            actor: "human:z",
            base_version: 9,
            stamp: [9, "human:z"],
            node_id: 904,
            node: {
              id: 904,
              type: "PreviewImage",
              inputs: [],
              outputs: [{ name: "IMAGE", type: "IMAGE", links: [new ArrayBuffer(4)] }],
            },
          } as unknown as Op,
        ],
        catalog,
      ).failed,
    ).toBeNull();
  });

});
