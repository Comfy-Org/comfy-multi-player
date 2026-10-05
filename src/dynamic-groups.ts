import { MAX_OVERFLOW_WIDGETS } from "./limits.js";
import type { WidgetCatalogEntry } from "./types.js";

export function groupOf(entry: WidgetCatalogEntry | undefined, name: string) {
  const groups = entry?.dynamic_groups;
  return groups && Object.hasOwn(groups, name) ? groups[name] : undefined;
}

export function isDynamicGroupField(entry: WidgetCatalogEntry | undefined, name: string): boolean {
  return Object.entries(entry?.dynamic_groups ?? {}).some(([prefix, group]) => {
    if (!name.startsWith(`${prefix}.`)) return false;
    const suffix = name.slice(prefix.length + 1);
    const dot = suffix.indexOf(".");
    const index = suffix.slice(0, dot);
    return dot > 0 && /^(0|[1-9]\d*)$/.test(index) && Number.isSafeInteger(Number(index))
      && group.widgets.includes(suffix.slice(dot + 1));
  });
}

export function groupCountRefusal(entry: WidgetCatalogEntry | undefined, name: string, value: unknown): string | null {
  const group = groupOf(entry, name);
  if (!group) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0
      || group.widgets.length === 0 || value > Math.floor(MAX_OVERFLOW_WIDGETS / group.widgets.length)) {
    return `${name}: expected a non-negative integer row count within the widget allocation bound`;
  }
  return null;
}

export function groupLayout(entry: WidgetCatalogEntry, name: string, value: unknown) {
  const group = groupOf(entry, name);
  if (!group) return undefined;
  const count = value === undefined ? group.min : value;
  const refusal = groupCountRefusal(entry, name, count);
  if (refusal) throw new TypeError(refusal);
  const order: string[] = [];
  const defaults = new Map<string, unknown>();
  defaults.set(name, group.min);
  for (let row = 0; row < (count as number); row++) {
    for (const field of group.widgets) {
      const child = `${name}.${String(row)}.${field}`;
      order.push(child);
      if (Object.hasOwn(group.defaults, field)) defaults.set(child, group.defaults[field]);
    }
  }
  return { order, defaults };
}
