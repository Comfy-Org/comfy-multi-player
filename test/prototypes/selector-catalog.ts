/**
 * Review-only catalog codec. Not exported, shipped, or wired into the applier.
 * The first commit used real flat-catalog mint as the failing reference adapter.
 */
import * as Y from "yjs";
import { applyOps, mint } from "../../src/index.js";

export interface WidgetField {
  readonly name: string;
  readonly branches?: Readonly<Record<string, readonly WidgetField[]>>;
}

function indexFields(layout: readonly WidgetField[], fields = new Map<string, WidgetField>()): Map<string, WidgetField> {
  for (const field of layout) {
    if (!field.name || fields.has(field.name)) throw new Error(`Ambiguous field: ${field.name}`);
    fields.set(field.name, field);
    for (const branch of Object.values(field.branches ?? {})) indexFields(branch, fields);
  }
  return fields;
}

function walkSelected(layout: readonly WidgetField[], read: (name: string) => unknown): void {
  for (const field of layout) {
    const selection = read(field.name);
    if (field.branches === undefined) continue;
    if (typeof selection !== "string" || !Object.hasOwn(field.branches, selection)) {
      throw new Error(`Unknown selection for ${field.name}`);
    }
    walkSelected(field.branches[selection]!, read);
  }
}

export function decodeWidgets(layout: readonly WidgetField[], values: readonly unknown[]): Map<string, unknown> {
  indexFields(layout);
  const named = new Map<string, unknown>();
  let cursor = 0;
  walkSelected(layout, (name) => {
    if (cursor >= values.length) throw new Error(`Missing value for ${name}`);
    const value = values[cursor++];
    named.set(name, value);
    return value;
  });
  if (cursor !== values.length) throw new Error("Unaccounted positional values");
  return named;
}

export type ResetValue = { readonly kind: "set"; readonly value: unknown } | { readonly kind: "clear" };

/** RED reference: measure the existing single-target selector op, which has no reset payload. */
export function planSelectorReset(
  layout: readonly WidgetField[], selector: string, selection: string,
  _carried: ReadonlyMap<string, unknown>,
): Map<string, ResetValue> {
  const names = [...indexFields(layout).keys()];
  const catalog = { types: { Prototype: { widget_order: names } } };
  const doc = mint({
    nodes: [{ id: 1, type: "Prototype", widgets_values: names.map(() => null) }],
    links: [],
  }, catalog);
  try {
    applyOps(doc, [{
      op: "set_widget", op_id: "a".repeat(32), actor: "prototype", base_version: 1,
      stamp: [1, "prototype"], node_id: 1, widget: selector, value: selection,
    }], catalog);
    const node = doc.getMap<Y.Map<unknown>>("nodes").get("1")!;
    const widgets = node.get("widgets") as Y.Map<unknown>;
    return new Map([...widgets].filter(([, value]) => value !== null)
      .map(([name, value]) => [name, { kind: "set", value }]));
  } finally {
    doc.destroy();
  }
}
