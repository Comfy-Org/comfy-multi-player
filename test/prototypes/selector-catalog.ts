/**
 * Review-only reference adapter for the current first-option catalog contract.
 * Not exported or shipped. The first test commit intentionally demonstrates
 * that the real flat-catalog mint cannot recover mode-dependent field names.
 */
import * as Y from "yjs";
import { mint } from "../../src/index.js";

export interface WidgetField {
  readonly name: string;
  readonly branches?: Readonly<Record<string, readonly WidgetField[]>>;
}

function defaultOrder(layout: readonly WidgetField[]): string[] {
  return layout.flatMap((field) => [
    field.name,
    ...defaultOrder(Object.values(field.branches ?? {})[0] ?? []),
  ]);
}

export function decodeWidgets(layout: readonly WidgetField[], values: readonly unknown[]): Map<string, unknown> {
  const doc = mint({
    nodes: [{ id: 1, type: "Prototype", widgets_values: [...values] }],
    links: [],
  }, { types: { Prototype: { widget_order: defaultOrder(layout) } } });
  try {
    const node = doc.getMap<Y.Map<unknown>>("nodes").get("1");
    const widgets = node?.get("widgets") as Y.Map<unknown>;
    return new Map(Object.entries(widgets.toJSON() as Record<string, unknown>));
  } finally {
    doc.destroy();
  }
}
