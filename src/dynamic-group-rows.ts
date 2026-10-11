import { MAX_OVERFLOW_WIDGETS } from "./limits.js";
import type { WidgetCatalogEntry } from "./types.js";

type RowIds = Readonly<Record<string, readonly string[]>>;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** Producer-owned live row order, scoped to this node and group. */
export function dynamicGroupRowsOf(properties: unknown): RowIds | null {
  if (typeof properties !== "object" || properties === null || !Object.hasOwn(properties, "dynamicGroupRows")) return null;
  if (!isPlainRecord(properties)) throw new TypeError("dynamicGroupRows: properties must be a plain object");
  const rows = properties["dynamicGroupRows"];
  if (!isPlainRecord(rows)) {
    throw new TypeError("dynamicGroupRows: expected a group-to-row-ID object");
  }
  for (const [group, ids] of Object.entries(rows)) {
    if (group.length === 0 || !Array.isArray(ids) || ids.length > MAX_OVERFLOW_WIDGETS
        || new Set(ids).size !== ids.length) {
      throw new TypeError(`dynamicGroupRows.${group}: expected distinct nonempty row IDs within the allocation bound`);
    }
    for (const id of ids as unknown[]) {
      if (typeof id !== "string" || id.length === 0) {
        throw new TypeError(`dynamicGroupRows.${group}: expected distinct nonempty row IDs within the allocation bound`);
      }
    }
  }
  return rows as RowIds;
}

export function assertDynamicGroupRowCounts(rows: RowIds | null, valueAt: (name: string) => unknown): void {
  for (const [name, ids] of Object.entries(rows ?? {})) {
    const count = valueAt(name);
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count !== ids.length) {
      throw new TypeError(`dynamicGroupRows.${name}: row IDs must match the stored row count`);
    }
  }
}

export function assertDynamicGroupRowCatalog(rows: RowIds | null, groups: WidgetCatalogEntry["dynamic_groups"]): void {
  for (const [name, ids] of Object.entries(rows ?? {})) {
    if (!groups || !Object.hasOwn(groups, name)) {
      throw new TypeError(`dynamicGroupRows.${name}: group metadata is required in the pinned catalog`);
    }
    const fields = groups[name]!.widgets;
    if (fields.length === 0 || ids.length > Math.floor(MAX_OVERFLOW_WIDGETS / fields.length)) {
      throw new TypeError(`dynamicGroupRows.${name}: rows exceed the widget allocation bound`);
    }
  }
}
