import { MAX_OVERFLOW_WIDGETS } from "./limits.js";
import type { WidgetCatalogEntry } from "./types.js";

export function groupOf(entry: WidgetCatalogEntry | undefined, name: string) {
  const groups = entry?.dynamic_groups;
  return groups && Object.hasOwn(groups, name) ? groups[name] : undefined;
}

function isGroupField(prefix: string, fields: readonly string[], name: string): boolean {
  if (!name.startsWith(`${prefix}.`)) return false;
  const suffix = name.slice(prefix.length + 1);
  const dot = suffix.indexOf(".");
  const index = suffix.slice(0, dot);
  return dot > 0 && /^(0|[1-9]\d*)$/.test(index) && Number.isSafeInteger(Number(index))
    && fields.includes(suffix.slice(dot + 1));
}

export function isDynamicGroupField(entry: WidgetCatalogEntry | undefined, name: string): boolean {
  return Object.entries(entry?.dynamic_groups ?? {}).some(([prefix, group]) => isGroupField(prefix, group.widgets, name));
}

function assertDynamicGroupOrder(entry: WidgetCatalogEntry, name: string, order: readonly string[]): boolean {
  const group = groupOf(entry, name)!;
  const controllerIndex = order.indexOf(name);
  if (controllerIndex !== order.lastIndexOf(name)) {
    throw new TypeError(`DynamicGroup controller '${name}' is duplicated in widget order`);
  }
  const generated = order.filter((widget) => isGroupField(name, group.widgets, widget));
  if (generated.length === 0) return controllerIndex >= 0;
  const minimum = groupLayout(entry, name, group.min)!.order;
  if (controllerIndex < 0 || generated.length !== minimum.length
      || minimum.some((widget, index) => generated[index] !== widget || order[controllerIndex + 1 + index] !== widget)) {
    throw new TypeError(`DynamicGroup '${name}' generated widget names collide with its minimum-row layout`);
  }
  return controllerIndex >= 0;
}

export function assertDynamicGroupCatalog(entry: WidgetCatalogEntry): void {
  const groups = Object.entries(entry.dynamic_groups ?? {});
  if (groups.length === 0) return;
  const orders = [entry.widget_order, ...Object.values(entry.dynamic_combos ?? {}).flatMap((combo) =>
    Object.values(combo.options).map((option) => option.widgets),
  )];
  for (const [name, group] of groups) {
    if (!Array.isArray(group.widgets) || group.widgets.length === 0
        || group.widgets.some((field) => typeof field !== "string" || field.length === 0)
        || new Set(group.widgets).size !== group.widgets.length) {
      throw new TypeError(`DynamicGroup '${name}' must declare distinct nonempty relative widget names`);
    }
    if (Object.hasOwn(entry.dynamic_combos ?? {}, name) || isDynamicGroupField(entry, name)) {
      throw new TypeError(`DynamicGroup controller '${name}' collides with another dynamic widget`);
    }
    let controllerFound = false;
    for (const order of orders) {
      const present = assertDynamicGroupOrder(entry, name, order);
      controllerFound ||= present;
    }
    if (!controllerFound) throw new TypeError(`DynamicGroup controller '${name}' is missing from widget order`);
  }
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
