import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import { applyOps, mint, project, type TopLevelSetWidgetOp, type WidgetCatalog, type WidgetCatalogEntry, type WorkflowJSON } from "../src/index.js";
import { widgetOrderForProducerOrder, widgetOrderForValues } from "../src/dynamic-combos.js";
import { DynamicGroupCountError, fieldGroupOf, groupLayout, isDynamicGroupField } from "../src/dynamic-groups.js";

const group = { min: 0, max: 8, widgets: ["lora_name", "strength"], defaults: { strength: 1 } };
const entry: WidgetCatalogEntry = { widget_order: ["loras", "tail"], dynamic_groups: { loras: group } };
const catalog: WidgetCatalog = { types: { Loras: entry } };
const workflow: WorkflowJSON = {
  last_node_id: 1, last_link_id: 0, links: [], groups: [], version: 0.4,
  nodes: [{ id: 1, type: "Loras", pos: [0, 0], size: [100, 100], flags: {}, order: 0, mode: 0, inputs: [], outputs: [], properties: {}, widgets_values: [0, "t"] }],
};

const write = (widget: string, value: unknown, stamp: number, actor: string) => ({
  op: "set_widget", node_id: 1, widget, value,
  op_id: `${actor.padEnd(2, "0")}${stamp.toString(16).padStart(30, "0")}`, actor, base_version: 1, stamp: [stamp, actor],
} satisfies TopLevelSetWidgetOp);

describe("#21091 same-index add versus peer edit (ADR-039 V1 residual)", () => {
  const addAndAnnounce = (stamp: number) => [
    write("loras", 1, stamp, "aa"),
    write("loras.0.lora_name", "default.safetensors", stamp + 2, "aa"),
  ];
  const addAndEdit = (stamp: number) => [
    write("loras", 1, stamp, "bb"),
    write("loras.0.lora_name", "picked.safetensors", stamp + 1, "bb"),
  ];
  const settle = (first: TopLevelSetWidgetOp[], second: TopLevelSetWidgetOp[]) => {
    const doc = mint(workflow, catalog);
    for (const op of [...first, ...second]) applyOps(doc, [op], catalog);
    const node = project(doc, catalog).nodes[0]!;
    const state = { values: node.widgets_values, named: node.widgets_values_named };
    doc.destroy();
    return state;
  };

  it("converges on the later-stamped default and loses the peer's edit in either arrival order", () => {
    const announced = addAndAnnounce(5);
    const edited = addAndEdit(5);
    const oneWay = settle(announced, edited);

    expect(settle(edited, announced)).toEqual(oneWay);
    expect(oneWay.values).toEqual([1, "default.safetensors", 1, "t"]);
  });

  it("keeps the peer's edit when it carries the later stamp, in either arrival order", () => {
    const announced = addAndAnnounce(1);
    const edited = addAndEdit(9);
    const oneWay = settle(announced, edited);

    expect(settle(edited, announced)).toEqual(oneWay);
    expect(oneWay.values).toEqual([1, "picked.safetensors", 1, "t"]);
  });
});

describe("DynamicGroup layout edges", () => {
  it("answers no group for an unknown catalog entry", () => {
    expect(fieldGroupOf(undefined, "loras.0.strength")).toBeUndefined();
    expect(isDynamicGroupField(undefined, "loras.0.strength")).toBe(false);
  });

  it("recognises only in-range row fields of a declared group", () => {
    expect(fieldGroupOf(entry, "loras.0.strength")).toBe("loras");
    expect(fieldGroupOf(entry, "loras.00.strength")).toBeUndefined();
    expect(fieldGroupOf(entry, "loras.0.missing")).toBeUndefined();
    expect(fieldGroupOf({ widget_order: ["loras"] }, "loras.0.strength")).toBeUndefined();
  });

  it("lays out the group minimum when no count is stored and leaves undeclared defaults to the reader", () => {
    const layout = groupLayout({ ...entry, dynamic_groups: { loras: { ...group, min: 1 } } }, "loras", undefined)!;

    expect(layout.order).toEqual(["loras.0.lora_name", "loras.0.strength"]);
    expect([...layout.defaults]).toEqual([["loras", 1], ["loras.0.strength", 1]]);
  });

  it("has no layout for a name that is not a controller", () => {
    expect(groupLayout(entry, "tail", 1)).toBeUndefined();
  });

  it("refuses an out-of-range stored count before laying out rows", () => {
    expect(() => groupLayout(entry, "loras", -1)).toThrow(DynamicGroupCountError);
  });
});

describe("widget order for DynamicGroup values", () => {
  it("has no order without a catalog entry", () => {
    expect(widgetOrderForValues(undefined, [1])).toBeUndefined();
  });

  it("falls back to the group minimum when a node holds no values", () => {
    const minOne: WidgetCatalogEntry = { ...entry, dynamic_groups: { loras: { ...group, min: 1 } } };

    expect(widgetOrderForValues(minOne, null)).toEqual(["loras", "loras.0.lora_name", "loras.0.strength", "tail"]);
  });

  it("refuses a name-keyed count outside the group's range", () => {
    expect(() => widgetOrderForValues(entry, { loras: -1 })).toThrow(DynamicGroupCountError);
  });

  it("ignores a name-keyed form that omits the count", () => {
    expect(widgetOrderForValues(entry, { tail: "t" })).toEqual(["loras", "tail"]);
  });

  it("refuses a selected layout that repeats a controller", () => {
    const repeated: WidgetCatalogEntry = {
      widget_order: ["first", "second"],
      dynamic_groups: { loras: group },
      dynamic_combos: {
        first: { default: "on", options: { on: { widgets: ["loras"], defaults: {} } } },
        second: { default: "on", options: { on: { widgets: ["loras"], defaults: {} } } },
      },
    };

    expect(() => widgetOrderForValues(repeated, ["on", 0, "on", 0])).toThrow("DynamicGroup controller 'loras' is duplicated");
  });

  it("keeps the producer's order for a group node with no selector", () => {
    const widgets = new Y.Doc().getMap<unknown>("widgets");

    expect(widgetOrderForProducerOrder(entry, ["tail", "loras"], widgets)).toEqual(["tail", "loras"]);
  });
});
