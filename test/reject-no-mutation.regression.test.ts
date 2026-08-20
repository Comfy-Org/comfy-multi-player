import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import { applyOps, mint, type ConnectOp, type WidgetCatalog, type WorkflowJSON } from "../src/index.js";
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
 * D4: a rejected op leaves the document BYTE-identical, not merely
 * projection-identical. The rejected op also never records its `op_id`, so
 * re-submitting it is re-attempted (and re-rejected) rather than deduped —
 * which is what makes the retry non-mutating too, the second half of #10.
 */
function assertRejectedWithoutMutation(
  workflow: WorkflowJSON,
  op: ConnectOp,
  code: string,
  withCatalog: WidgetCatalog = catalog,
): void {
  const doc = mint(workflow, withCatalog);
  const before = Buffer.from(Y.encodeStateAsUpdate(doc));
  expect(applyOps(doc, [op], withCatalog).failed).toMatchObject({ code });
  expect(Buffer.from(Y.encodeStateAsUpdate(doc)).equals(before)).toBe(true);

  const retry = applyOps(doc, [op], withCatalog);
  expect(retry.failed).toMatchObject({ code });
  expect(Buffer.from(Y.encodeStateAsUpdate(doc)).equals(before)).toBe(true);
}

describe("regression: rejected connect ops leave document bytes unchanged (#10)", () => {
  const source = {
    id: 300, type: "LoadImage", inputs: [],
    outputs: [{ name: "IMAGE", type: "IMAGE", links: [9000] }], widgets_values: [],
  };
  const destination = {
    id: 700, type: "BatchImagesNode",
    inputs: [{ name: "images.image0", type: "IMAGE", link: 9000 }],
    outputs: [{ name: "IMAGE", type: "IMAGE", links: [] }], widgets_values: [],
  };
  const workflow: WorkflowJSON = {
    nodes: [source, destination],
    links: [[9000, 300, 0, 700, 0, "IMAGE"]],
    groups: [], extra: {}, last_node_id: 700, last_link_id: 9000,
  };

  it("invalid source output does not claim the input or remove its incumbent link", () => {
    assertRejectedWithoutMutation(workflow, {
      op: "connect", op_id: opId("bad-output"), actor: "human:z", base_version: 9,
      stamp: [9, "human:z"], link_id: 9500, from_node: 300, from_slot: 5,
      to_node: 700, to_slot: 0, link_type: "IMAGE",
    }, "output_slot_missing");
  });

  it("invalid inputcount widget does not append a grown slot", () => {
    assertRejectedWithoutMutation(workflow, {
      op: "connect", op_id: opId("bad-count"), actor: "human:z", base_version: 9,
      stamp: [9, "human:z"], link_id: 9501, from_node: 300, from_slot: 0,
      to_node: 700, to_slot: null, link_type: "IMAGE",
      grow: {
        name: "images.image0", type: "IMAGE",
        inputcount: { widget: "not_a_widget", value: 2 },
      },
    }, "unknown_widget");
  });

  it("non-string inputcount widget does not append a grown slot (the verified #10 repro)", () => {
    // The exact path recorded against issue #10: `growInput` appended the slot
    // and `applyInputcountBump` then threw `malformed_op` on a non-string
    // `grow.inputcount.widget`. Yjs does not roll a transact body back on
    // throw and `mset(op_id)` never ran, so the doc gained an input slot
    // (inputs 1 -> 2) while `ApplyResult.failed` reported nothing had
    // happened, and a retry appended a second slot.
    assertRejectedWithoutMutation(workflow, {
      op: "connect", op_id: opId("nonstr-count"), actor: "human:z", base_version: 9,
      stamp: [9, "human:z"], link_id: 9502, from_node: 300, from_slot: 0,
      to_node: 700, to_slot: null, link_type: "IMAGE",
      grow: {
        name: "images.image0", type: "IMAGE",
        inputcount: { widget: 7 as unknown as string, value: 2 },
      },
    }, "malformed_op");
  });

  it("malformed grow payload does not append a grown slot", () => {
    assertRejectedWithoutMutation(workflow, {
      op: "connect", op_id: opId("bad-grow"), actor: "human:z", base_version: 9,
      stamp: [9, "human:z"], link_id: 9503, from_node: 300, from_slot: 0,
      to_node: 700, to_slot: null, link_type: "IMAGE",
      grow: { name: 5 as unknown as string, type: "IMAGE" },
    }, "malformed_op");
  });

  it("an opaque destination refuses an inputcount grow before growing the slot", () => {
    const opaque = {
      id: 800, type: "MarkdownNode",
      inputs: [{ name: "images.image0", type: "IMAGE", link: null }],
      outputs: [], widgets_values: ["opaque"],
    };
    assertRejectedWithoutMutation(
      {
        nodes: [source, opaque],
        links: [],
        groups: [], extra: {}, last_node_id: 800, last_link_id: 9000,
      },
      {
        op: "connect", op_id: opId("opaque-count"), actor: "human:z", base_version: 9,
        stamp: [9, "human:z"], link_id: 9504, from_node: 300, from_slot: 0,
        to_node: 800, to_slot: null, link_type: "IMAGE",
        grow: {
          name: "images.image0", type: "IMAGE",
          inputcount: { widget: "inputcount", value: 2 },
        },
      },
      "opaque_widgets",
    );
  });

  it("a non-cloneable inputcount value is refused before the slot is grown", () => {
    // `structuredClone` throws DataCloneError on a value JSON cannot carry.
    // It used to be evaluated as an argument to `mset`, i.e. after `widgetsOf`
    // had created the widgets map and after the autogrow had appended a slot.
    assertRejectedWithoutMutation(workflow, {
      op: "connect", op_id: opId("uncloneable"), actor: "human:z", base_version: 9,
      stamp: [9, "human:z"], link_id: 9505, from_node: 300, from_slot: 0,
      to_node: 700, to_slot: null, link_type: "IMAGE",
      grow: {
        name: "images.image0", type: "IMAGE",
        inputcount: { widget: "inputcount", value: (() => undefined) as unknown as number },
      },
    }, "malformed_op", countingCatalog);
  });

  it.each([
    ["negative", -1],
    ["fractional", 0.5],
    ["NaN", Number.NaN],
    ["out of range", 99],
  ])("a %s from_slot is refused before the link tuple is written", (_label, fromSlot) => {
    // `from_slot >= outs.length` alone admitted every one of these: each
    // reached `outs.get(from_slot)` returning `undefined` and threw a raw
    // TypeError, reported as the generic `apply_failed`, only AFTER the link
    // tuple and the input slot had been written — with `__applied` unwritten,
    // so the retry re-mutated. Identical on `main` and on the first pass of
    // this fix; the fix closed two instances of #10, not the class.
    assertRejectedWithoutMutation(workflow, {
      op: "connect", op_id: opId(`slot${String(fromSlot)}`), actor: "human:z", base_version: 9,
      stamp: [9, "human:z"], link_id: 9506, from_node: 300, from_slot: fromSlot,
      to_node: 700, to_slot: 0, link_type: "IMAGE",
    }, "output_slot_missing");
  });

  it.each([
    ["negative", -1],
    ["fractional", 1.5],
    ["NaN", Number.NaN],
  ])("a %s to_slot is refused before the register is claimed", (_label, toSlot) => {
    assertRejectedWithoutMutation(workflow, {
      op: "connect", op_id: opId(`to${String(toSlot)}`), actor: "human:z", base_version: 9,
      stamp: [9, "human:z"], link_id: 9507, from_node: 300, from_slot: 0,
      to_node: 700, to_slot: toSlot, link_type: "IMAGE",
    }, "input_slot_missing");
  });

  it("a non-cloneable set_widget value is refused before the widgets map is created", () => {
    const doc = mint(workflow, catalog);
    const before = Buffer.from(Y.encodeStateAsUpdate(doc));
    const op = {
      op: "set_widget", op_id: opId("uncloneable-sw"), actor: "human:z", base_version: 9,
      stamp: [9, "human:z"], node_id: 700, widget: "inputcount",
      value: (() => undefined) as unknown,
    } as unknown as ConnectOp;
    expect(applyOps(doc, [op], catalog).failed).toMatchObject({ code: "malformed_op" });
    expect(Buffer.from(Y.encodeStateAsUpdate(doc)).equals(before)).toBe(true);
  });
});
