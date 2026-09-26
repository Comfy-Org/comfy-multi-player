/**
 * Opaque widget storage whose value is a NAME-KEYED RECORD rather than a
 * positional array (schema §1.2).
 *
 * Some classes override widget serialization in their own frontend code and
 * save `widgets_values` as an object keyed by widget name (VideoHelperSuite's
 * video loaders are the common case). The object carries names that exist only
 * in that frontend code (a DOM preview widget, an upload button), so the
 * catalog's `widget_order` can never describe it and the name-keyed `widgets`
 * map cannot project it. A host therefore keeps such a node's object whole
 * under {@link OPAQUE_WIDGETS_KEY}, and `project()` hands it back verbatim.
 *
 * Unlike an opaque ARRAY, a record IS name-addressable: the name is the key.
 * So `set_widget` on such a node writes that one key, as a whole-value
 * read-modify-write of the record (the same Amendment A2 shape a promoted host
 * write uses for an opaque array), instead of refusing with `opaque_widgets`.
 * The name must be one the record already holds or one the catalog lists for
 * the class; anything else is `unknown_widget`, with the document untouched.
 */
import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import { OPAQUE_WIDGETS_KEY, appliedMap, nodesMap } from "../src/doc.js";
import { applyOps, mint, project, type SetWidgetOp, type WidgetCatalog, type WorkflowJSON } from "../src/index.js";
import { loadCatalog } from "./helpers.js";

const CLASS = "RecordWidgetsVideoLoader";

const catalog: WidgetCatalog = {
  types: {
    ...loadCatalog().types,
    // The class IS catalogued: the record shape, not catalog absence, is why
    // its values are stored opaquely.
    [CLASS]: {
      widget_order: ["video", "force_rate", "custom_width", "custom_height", "frame_load_cap", "format"],
    },
  },
};

const RECORD = {
  video: "clip.mp4",
  force_rate: 0,
  custom_width: 0,
  custom_height: 0,
  frame_load_cap: 0,
  format: "AnimateDiff",
  "choose video to upload": "image",
  videopreview: { hidden: false, paused: false, params: { filename: "clip.mp4", type: "input" } },
};

let seq = 0;
function envelope(actor: string, lamport: number) {
  seq += 1;
  return {
    op_id: ("e" + String(seq).padStart(4, "0")).padEnd(32, "0"),
    base_version: 0,
    actor,
    stamp: [lamport, actor] as [number, string],
  };
}

/**
 * Mint a one-node workflow and store the node's object the way a host that
 * keeps record-shaped `widgets_values` whole does: under the opaque key.
 */
function recordDoc(): Y.Doc {
  const wf: WorkflowJSON = {
    nodes: [{ id: 7, type: CLASS, inputs: [], outputs: [], widgets_values: [] }],
    links: [],
  };
  const doc = mint(wf, catalog);
  const node = nodesMap(doc).get("7") as Y.Map<unknown>;
  doc.transact(() => {
    node.delete("widgets");
    node.set(OPAQUE_WIDGETS_KEY, structuredClone(RECORD));
  });
  return doc;
}

function setWidget(widget: string, value: unknown, actor = "agent", lamport = 1): SetWidgetOp {
  return { op: "set_widget", ...envelope(actor, lamport), node_id: 7, widget, value };
}

/**
 * The full rejection contract: the op is rejected with `code`, the document is
 * byte-identical (no stamp, no ledger entry, no value), and a valid op queued
 * behind it is `batch_aborted` without being applied.
 */
function expectRejected(doc: Y.Doc, op: SetWidgetOp, code: string, cat: WidgetCatalog | undefined = catalog): void {
  const before = Buffer.from(Y.encodeStateAsUpdate(doc));
  const follower = setWidget("custom_width", 999, "carol", 50);
  const res = applyOps(doc, [op, follower], cat);
  expect(res.outcomes[0]).toMatchObject({ outcome: "rejected", reason: { code } });
  expect(res.outcomes[1]).toMatchObject({ outcome: "rejected", reason: { code: "batch_aborted" } });
  expect(Buffer.from(Y.encodeStateAsUpdate(doc)).equals(before)).toBe(true);
  expect(appliedMap(doc).has(op.op_id)).toBe(false);
  expect(appliedMap(doc).has(follower.op_id)).toBe(false);
}

function projectedValues(doc: Y.Doc): unknown {
  return project(doc, catalog).nodes.find((n) => String(n.id) === "7")!.widgets_values;
}

describe("set_widget on a record-shaped opaque node", () => {
  it("writes the named key and keeps every other key verbatim", () => {
    const doc = recordDoc();
    const res = applyOps(doc, [setWidget("custom_height", 512)], catalog);
    expect(res.outcomes[0]).toMatchObject({ outcome: "applied" });
    expect(projectedValues(doc)).toEqual({ ...RECORD, custom_height: 512 });

    // A replica built only from the encoded state projects the same object.
    const replica = new Y.Doc();
    Y.applyUpdate(replica, Y.encodeStateAsUpdate(doc));
    expect(projectedValues(replica)).toEqual({ ...RECORD, custom_height: 512 });
  });

  it("accepts a key only the record holds (a frontend-defined widget)", () => {
    const doc = recordDoc();
    const preview = { hidden: true, paused: true, params: {} };
    const res = applyOps(doc, [setWidget("videopreview", preview)], catalog);
    expect(res.outcomes[0]).toMatchObject({ outcome: "applied" });
    expect(projectedValues(doc)).toEqual({ ...RECORD, videopreview: preview });
  });

  it("accepts a catalogued name the record does not hold yet", () => {
    const doc = recordDoc();
    const node = nodesMap(doc).get("7") as Y.Map<unknown>;
    const sparse: Record<string, unknown> = { ...RECORD };
    delete sparse["frame_load_cap"];
    node.set(OPAQUE_WIDGETS_KEY, sparse);
    const res = applyOps(doc, [setWidget("frame_load_cap", 48)], catalog);
    expect(res.outcomes[0]).toMatchObject({ outcome: "applied" });
    expect(projectedValues(doc)).toEqual({ ...sparse, frame_load_cap: 48 });
  });

  it("rejects a name neither the record nor the catalog knows, leaving the document byte-identical", () => {
    const doc = recordDoc();
    expectRejected(doc, setWidget("no_such_widget", 1), "unknown_widget");
    expect(projectedValues(doc)).toEqual(RECORD);
  });

  it("rejects `__proto__` rather than writing a key the encoder would drop", () => {
    const doc = recordDoc();
    expectRejected(doc, setWidget("__proto__", { polluted: true }), "unknown_widget");
    expect(projectedValues(doc)).toEqual(RECORD);
  });

  it("rejects a write when the pinned catalog does not know the class (KA-12)", () => {
    const doc = recordDoc();
    const without: WidgetCatalog = { types: { ...catalog.types } };
    delete without.types[CLASS];
    expectRejected(doc, setWidget("custom_height", 512), "uncatalogued_widget_write", without);
    expect(projectedValues(doc)).toEqual(RECORD);
  });

  it("with no catalog at all, accepts only the record's own keys", () => {
    const doc = recordDoc();
    expect(applyOps(doc, [setWidget("custom_height", 512)]).outcomes[0]).toMatchObject({ outcome: "applied" });
    expectRejected(recordDoc(), setWidget("select_every_nth", 2), "unknown_widget", undefined);
  });

  it("two writes to different keys commute (each read-modify-writes the whole record)", () => {
    const a = setWidget("custom_width", 640, "alice", 1);
    const b = setWidget("custom_height", 480, "bob", 1);
    const ab = recordDoc();
    applyOps(ab, [a, b], catalog);
    const ba = recordDoc();
    applyOps(ba, [b, a], catalog);
    expect(projectedValues(ab)).toEqual({ ...RECORD, custom_width: 640, custom_height: 480 });
    expect(projectedValues(ba)).toEqual(projectedValues(ab));
  });

  it("same-key writes converge in both arrival orders, and a re-applied op is a no-op", () => {
    const newer = setWidget("custom_height", 720, "alice", 5);
    const older = setWidget("custom_height", 240, "bob", 2);
    const a = recordDoc();
    expect(applyOps(a, [newer, older], catalog).outcomes.map((o) => o.outcome)).toEqual(["applied", "lww-dropped"]);
    const b = recordDoc();
    expect(applyOps(b, [older, newer], catalog).outcomes.map((o) => o.outcome)).toEqual(["applied", "applied"]);
    expect((projectedValues(a) as Record<string, unknown>)["custom_height"]).toBe(720);
    expect(projectedValues(b)).toEqual(projectedValues(a));

    const before = Buffer.from(Y.encodeStateAsUpdate(a));
    expect(applyOps(a, [newer], catalog).outcomes[0]).toMatchObject({ outcome: "no-op" });
    expect(Buffer.from(Y.encodeStateAsUpdate(a)).equals(before)).toBe(true);
  });

  it("a promoted host write cannot replace the record with a positional array", () => {
    const doc = recordDoc();
    const before = Buffer.from(Y.encodeStateAsUpdate(doc));
    const op = {
      ...setWidget("custom_height", 512),
      promoted: { value_index: 3, host_widgets_values: ["clip.mp4", 0, 0, 0] },
    } as SetWidgetOp;
    expectRejected(doc, op, "opaque_widgets");
    expect(Buffer.from(Y.encodeStateAsUpdate(doc)).equals(before)).toBe(true);
    expect(projectedValues(doc)).toEqual(RECORD);
  });
});

describe("set_widget on an array-shaped opaque node (unchanged)", () => {
  it("still refuses with opaque_widgets", () => {
    const wf: WorkflowJSON = {
      nodes: [{ id: 9, type: "UncataloguedThing", inputs: [], outputs: [], widgets_values: ["a", 1] }],
      links: [],
    };
    const doc = mint(wf, catalog);
    const op: SetWidgetOp = { op: "set_widget", ...envelope("agent", 1), node_id: 9, widget: "text", value: "x" };
    const res = applyOps(doc, [op], catalog);
    expect(res.outcomes[0]).toMatchObject({ outcome: "rejected", reason: { code: "opaque_widgets" } });
  });
});
