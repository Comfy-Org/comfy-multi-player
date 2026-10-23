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
  return dot > 0 && /^(0|[1-9]\d*)$/.test(index) && Number(index) < maxRows(fields)
    && fields.includes(suffix.slice(dot + 1));
}

function maxRows(fields: readonly string[]): number {
  return fields.length === 0 ? 0 : Math.floor(MAX_OVERFLOW_WIDGETS / fields.length);
}

/** The controller whose generated row field `name` is, if any. */
export function fieldGroupOf(entry: WidgetCatalogEntry | undefined, name: string): string | undefined {
  return Object.entries(entry?.dynamic_groups ?? {}).find(([prefix, group]) => isGroupField(prefix, group.widgets, name))?.[0];
}

export function isDynamicGroupField(entry: WidgetCatalogEntry | undefined, name: string): boolean {
  return fieldGroupOf(entry, name) !== undefined;
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

/** The most copies of `name` one selection can lay out from `names`, walking selectors to the same depth as layout expansion. */
function maxSelectedCopies(entry: WidgetCatalogEntry, name: string, names: readonly string[], depth: number): number {
  const combos = entry.dynamic_combos ?? {};
  let copies = 0;
  for (const widget of names) {
    if (widget === name) copies++;
    if (!Object.hasOwn(combos, widget) || depth > 32) continue;
    copies += Math.max(0, ...Object.values(combos[widget]!.options).map((option) =>
      maxSelectedCopies(entry, name, option.widgets, depth + 1)));
  }
  return copies;
}

/**
 * Refuse, from the catalog alone, any selection that would lay out a controller
 * or its generated rows twice. Refusing on write instead would make the outcome
 * depend on which selector write arrived first.
 */
function assertSingleSelection(entry: WidgetCatalogEntry, name: string, baseOrder: readonly string[], optionOrders: readonly (readonly string[])[]): void {
  if (maxSelectedCopies(entry, name, baseOrder, 0) > 1) {
    throw new TypeError(`DynamicGroup controller '${name}' can be selected more than once`);
  }
  const fields = groupOf(entry, name)!.widgets;
  if (optionOrders.some((order) => order.some((widget) => isGroupField(name, fields, widget)))) {
    throw new TypeError(`DynamicGroup '${name}' generated widget names cannot be listed in a DynamicCombo option`);
  }
}

export function assertDynamicGroupCatalog(entry: WidgetCatalogEntry): void {
  const groups = Object.entries(entry.dynamic_groups ?? {});
  if (groups.length === 0) return;
  const optionOrders = Object.values(entry.dynamic_combos ?? {}).flatMap((combo) =>
    Object.values(combo.options).map((option) => option.widgets),
  );
  const orders = [entry.widget_order, ...optionOrders];
  const owned = new Set(optionOrders.flat());
  const baseOrder = entry.widget_order.filter((widget) => !owned.has(widget));
  for (const [name, group] of groups) {
    if (!Array.isArray(group.widgets) || group.widgets.length === 0
        || group.widgets.some((field) => typeof field !== "string" || field.length === 0)
        || new Set(group.widgets).size !== group.widgets.length) {
      throw new TypeError(`DynamicGroup '${name}' must declare distinct nonempty relative widget names`);
    }
    if (!Number.isSafeInteger(group.min) || !Number.isSafeInteger(group.max) || group.min < 0 || group.min > group.max) {
      throw new TypeError(`DynamicGroup '${name}' must declare integer row bounds with 0 <= min <= max`);
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
    assertSingleSelection(entry, name, baseOrder, optionOrders);
  }
}

export function groupCountRefusal(entry: WidgetCatalogEntry | undefined, name: string, value: unknown): string | null {
  const group = groupOf(entry, name);
  if (!group) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < group.min || value > maxRows(group.widgets)) {
    return `${name}: expected an integer row count from the group minimum to the widget allocation bound`;
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
