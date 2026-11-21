/**
 * ADR-API-0023 — the exported placeability predicate IS the applier's check.
 *
 * WHY THIS FILE EXISTS. A host guard must answer "can this stored widget name
 * be placed?" the same way this package does, or it refuses documents the
 * package itself just minted and locks the workflow out of the agent entirely.
 * That is not hypothetical: the doc-host's `catalogpins.ts` hand-copied this
 * rule three times, once per production lockout —
 *
 *  - 2026-10-08, v0.448.0 — dynamic-combo option names (`optionOwnedWidgets`);
 *  - 2026-10-12 / 2026-10-15 — selection-relative `_extra_<n>` slots;
 *  - 2026-11-18, v0.557.0 — dynamic-group row fields (`isDynamicGroupField`),
 *    279 refused turns over 6 workflows, reseed refused the same way.
 *
 * Each copy was correct when written and wrong one package release later, so
 * `catalogPlacesDynamicName` is published and the applier calls it. The first
 * test here is the one that makes that load-bearing rather than decorative: it
 * drives real `set_widget` ops through `applyOps` and asserts the predicate's
 * verdict equals the applier's, name by name. A future widening of what the
 * applier places cannot pass this file while leaving the predicate behind.
 *
 * Invariants: KA-3 (one implementation, browser and host identically — the
 * defect this closes is a SECOND implementation of the placement rule in the
 * host), KA-2 (value-blind: accepting only the current selection's names would
 * make the outcome depend on selector arrival order), KA-12 (the verdict reads
 * the pinned catalog, never the document).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyOps,
  catalogPlacesDynamicName,
  mint,
  overflowWidgetName,
  parseOverflowWidgetName,
  widgetIdentityFromStorageKey,
  widgetStorageKey,
  type TopLevelSetWidgetOp,
  type WidgetCatalog,
  type WorkflowJSON,
} from "../src/index.js";

const groupFixture = JSON.parse(
  readFileSync(new URL("./fixtures/dynamic-group.json", import.meta.url), "utf8"),
) as { catalog: WidgetCatalog; cases: Record<"empty" | "populated", WorkflowJSON> };

const GROUP_CLASS = "DevToolsNodeWithDynamicGroup";
const groupCatalog = groupFixture.catalog;
const groupEntry = groupCatalog.types[GROUP_CLASS]!;

/** A dynamic-combo entry in the prod shape that locked out on 2026-10-08. */
const comboCatalog: WidgetCatalog = {
  types: {
    ResizeImageMaskNode: {
      widget_order: ["resize_type", "resize_type.width", "resize_type.height"],
      dynamic_combos: {
        resize_type: {
          default: "resize to width/height",
          options: {
            "resize to width/height": {
              widgets: ["resize_type.width", "resize_type.height"],
              defaults: { "resize_type.width": 512, "resize_type.height": 512 },
            },
            "scale by multiplier": {
              widgets: ["resize_type.multiplier"],
              defaults: { "resize_type.multiplier": 1 },
            },
          },
        },
      },
    },
  },
};

const edit = (nodeId: number, widget: string, value: unknown, counter = 1) =>
  ({
    op: "set_widget",
    node_id: nodeId,
    widget,
    value,
    op_id: counter.toString(16).padStart(32, "0"),
    actor: "agent:a",
    base_version: counter,
    stamp: [counter, "agent:a"],
  }) satisfies TopLevelSetWidgetOp;

/** Whether `applyOps` places a name-addressed write, by its own verdict. */
function applierPlaces(workflow: WorkflowJSON, catalog: WidgetCatalog, widget: string): boolean {
  const doc = mint(structuredClone(workflow), catalog);
  try {
    const [outcome] = applyOps(doc, [edit(workflow.nodes[0]!.id as number, widget, "x")], catalog).outcomes;
    if (outcome?.outcome === "applied") return true;
    // Only `unknown_widget` is the placement verdict. Any other rejection code
    // means the op failed for an unrelated reason and the case is not a
    // measurement of placeability, so surface it rather than reading it as a
    // refusal to place.
    expect(
      outcome?.outcome === "rejected" ? outcome.reason.code : outcome?.outcome,
      `${widget}: expected an applied write or an unknown_widget refusal`,
    ).toBe("unknown_widget");
    return false;
  } finally {
    doc.destroy();
  }
}

function groupWorkflow(rows: number): WorkflowJSON {
  const workflow = structuredClone(groupFixture.cases.empty);
  const values: Record<string, unknown> = { before: "first", loras: rows, after: "last" };
  for (let row = 0; row < rows; row++) {
    values[`loras.${String(row)}.lora_name`] = "A.safetensors";
    values[`loras.${String(row)}.strength`] = 1;
    values[`loras.${String(row)}.enabled`] = true;
  }
  workflow.nodes[0]!.widgets_values = values;
  return workflow;
}

function comboWorkflow(selection: string): WorkflowJSON {
  return {
    ...groupFixture.cases.empty,
    nodes: [
      {
        ...structuredClone(groupFixture.cases.empty.nodes[0]!),
        type: "ResizeImageMaskNode",
        widgets_values: { resize_type: selection },
      },
    ],
  };
}

describe("ADR-API-0023 catalogPlacesDynamicName", () => {
  /**
   * The biconditional, stated honestly. `applyOps` accepts a name that its
   * REALIZED order lists OR that this predicate places, so agreement on a name
   * the realized order already lists is weak evidence. The load-bearing rows
   * are therefore the ones the realized order cannot list — a row past the
   * controller's stored count, and an unselected option's child — because
   * there the applier's verdict reduces to this predicate alone. Both kinds
   * are present and labelled, and the whole table must agree either way: a
   * disagreement anywhere is drift between the two.
   */
  it("agrees with applyOps on every dynamically placed name, and on every name it refuses", () => {
    const cases: readonly {
      label: string;
      workflow: WorkflowJSON;
      catalog: WidgetCatalog;
      type: string;
      widget: string;
      placed: boolean;
    }[] = [
      // Dynamic-group rows. Row 0 is the group minimum, so the stored order
      // lists it; rows 1 and 2 are the 2026-11-18 lockout exactly.
      { label: "group row 0 field", workflow: groupWorkflow(3), catalog: groupCatalog, type: GROUP_CLASS, widget: "loras.0.strength", placed: true },
      { label: "group row 1 field (prod lockout)", workflow: groupWorkflow(3), catalog: groupCatalog, type: GROUP_CLASS, widget: "loras.1.strength", placed: true },
      { label: "group row 2 field (prod lockout)", workflow: groupWorkflow(3), catalog: groupCatalog, type: GROUP_CLASS, widget: "loras.2.enabled", placed: true },
      // LOAD-BEARING. Value-blind (KA-2): a row past the controller's CURRENT
      // count is still placeable, because the pinned catalog can place it and
      // refusing would make the verdict depend on whether the count write
      // arrived first. The realized order of a one-row node lists neither of
      // these, so only this predicate can accept them — which is precisely the
      // document shape that locked out in prod on 2026-11-18.
      { label: "group row 1 field past a one-row count", workflow: groupWorkflow(1), catalog: groupCatalog, type: GROUP_CLASS, widget: "loras.1.strength", placed: true },
      { label: "group row 2 field past a one-row count", workflow: groupWorkflow(1), catalog: groupCatalog, type: GROUP_CLASS, widget: "loras.2.strength", placed: true },
      // Refusals the guard must keep making.
      { label: "field the group does not declare", workflow: groupWorkflow(3), catalog: groupCatalog, type: GROUP_CLASS, widget: "loras.1.nope", placed: false },
      { label: "non-canonical row index", workflow: groupWorkflow(3), catalog: groupCatalog, type: GROUP_CLASS, widget: "loras.01.strength", placed: false },
      { label: "negative row index", workflow: groupWorkflow(3), catalog: groupCatalog, type: GROUP_CLASS, widget: "loras.-1.strength", placed: false },
      { label: "row field of an undeclared controller", workflow: groupWorkflow(3), catalog: groupCatalog, type: GROUP_CLASS, widget: "other.0.strength", placed: false },
      { label: "unrelated name", workflow: groupWorkflow(3), catalog: groupCatalog, type: GROUP_CLASS, widget: "totally_unknown", placed: false },
      // Dynamic-combo option names: owned at ANY selection, which is the
      // 2026-10-08 lockout. `multiplier` is owned by the unselected option.
      { label: "selected option child", workflow: comboWorkflow("resize to width/height"), catalog: comboCatalog, type: "ResizeImageMaskNode", widget: "resize_type.width", placed: true },
      { label: "unselected option child (prod lockout)", workflow: comboWorkflow("resize to width/height"), catalog: comboCatalog, type: "ResizeImageMaskNode", widget: "resize_type.multiplier", placed: true },
      { label: "option child under the other selection", workflow: comboWorkflow("scale by multiplier"), catalog: comboCatalog, type: "ResizeImageMaskNode", widget: "resize_type.height", placed: true },
      { label: "name no option owns", workflow: comboWorkflow("scale by multiplier"), catalog: comboCatalog, type: "ResizeImageMaskNode", widget: "resize_type.depth", placed: false },
    ];

    // Vacuity guard: the biconditional is only evidence if both verdicts occur.
    expect(cases.filter((c) => c.placed).length).toBeGreaterThan(1);
    expect(cases.filter((c) => !c.placed).length).toBeGreaterThan(1);

    for (const { label, workflow, catalog, type, widget, placed } of cases) {
      const predicate = catalogPlacesDynamicName(catalog.types[type], widget);
      const applier = applierPlaces(workflow, catalog, widget);
      expect(predicate, `${label}: predicate disagrees with the recorded verdict`).toBe(placed);
      expect(applier, `${label}: applyOps disagrees with catalogPlacesDynamicName`).toBe(predicate);
    }
  });

  it("places no name at a later occurrence: one slot per dynamically placed name", () => {
    expect(catalogPlacesDynamicName(groupEntry, "loras.1.strength", 0)).toBe(true);
    expect(catalogPlacesDynamicName(groupEntry, "loras.1.strength", 1)).toBe(false);
    expect(catalogPlacesDynamicName(comboCatalog.types["ResizeImageMaskNode"], "resize_type.multiplier", 2)).toBe(false);
  });

  it("refuses a row index at or past the allocation bound every group shares", () => {
    // MAX_OVERFLOW_WIDGETS / 3 declared fields. The bound is a property of
    // every group of the entry together, not of the controller's count.
    const bound = Math.floor(4096 / 3);
    expect(catalogPlacesDynamicName(groupEntry, `loras.${String(bound - 1)}.strength`)).toBe(true);
    expect(catalogPlacesDynamicName(groupEntry, `loras.${String(bound)}.strength`)).toBe(false);
  });

  it("places nothing from an absent, value-blind, or group-less entry (fail-closed)", () => {
    expect(catalogPlacesDynamicName(undefined, "loras.1.strength")).toBe(false);
    // The value-blind catalog shape: the same class with `dynamic_groups`
    // stripped, which is what a stale request catalog looks like.
    const valueBlind = { widget_order: groupEntry.widget_order };
    expect(catalogPlacesDynamicName(valueBlind, "loras.1.strength")).toBe(false);
    expect(catalogPlacesDynamicName(valueBlind, "loras.0.strength")).toBe(false);
  });
});

describe("ADR-API-0023 stored-name spellings", () => {
  it("round-trips the overflow placeholder spelling a consumer would otherwise copy", () => {
    for (const index of [0, 1, 3, 4095]) {
      expect(parseOverflowWidgetName(overflowWidgetName(index))).toBe(index);
    }
    // The shape the doc-host guard's hand copy matched, pinned here so a
    // rename moves the definition and this test together.
    expect(overflowWidgetName(3)).toBe("_extra_3");
    for (const notOverflow of ["_extra_", "_extra_01", "_extra_-1", "extra_1", "loras.1.strength", "_extra_1x"]) {
      expect(parseOverflowWidgetName(notOverflow), notOverflow).toBeNull();
    }
  });

  it("round-trips the occurrence storage key a consumer would otherwise copy", () => {
    expect(widgetStorageKey("strength")).toBe("strength");
    expect(widgetStorageKey("strength", 0)).toBe("strength");
    expect(widgetIdentityFromStorageKey(widgetStorageKey("strength", 0))).toEqual({ name: "strength", occurrence: 0 });
    expect(widgetIdentityFromStorageKey(widgetStorageKey("strength", 2))).toEqual({ name: "strength", occurrence: 2 });
    // Occurrence 0 keeps the bare name; every later occurrence is prefixed, and
    // the prefix is NUL-led so it cannot collide with a catalog name.
    expect(widgetStorageKey("strength", 1).startsWith("\u0000")).toBe(true);
  });
});
