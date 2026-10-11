import * as Y from "yjs";
import { dynamicGroupRowsOf } from "./dynamic-group-rows.js";
import { compareStampKeys, codePointCompare } from "./stamps.js";
import { DYNAMIC_GROUP_STATE_KEY, DYNAMIC_GROUP_SLOT_KEY, type StampKey, type WidgetCatalogEntry } from "./types.js";
import { storedWidgetFormOf, type StoredWidgetForm } from "./widget-form.js";
import { widgetStorageKey, widgetIdentityFromStorageKey, type WidgetValues } from "./widget-identity.js";

export interface RowSlot {
  original_index: number | null;
  data: Record<string, unknown>;
}

/** Only winning values, immutable insertion data and delete-wins state are retained. */
export interface DynamicRowRecord {
  after?: string | null;
  created?: StampKey | null;
  insert_digest?: string;
  deleted?: StampKey;
  values: Record<string, unknown>;
  slots: Record<string, RowSlot>;
}

interface StoredRowRecord extends Omit<DynamicRowRecord, "values" | "slots"> {
  values: [string, unknown][];
  slots: [string, RowSlot][];
}

/** Entry arrays preserve literal field names through lib0 object decoding. */
export function encodeRowRecord(row: DynamicRowRecord): StoredRowRecord {
  const copy = structuredClone(row);
  return { ...copy, values: Object.entries(copy.values), slots: Object.entries(copy.slots) };
}

export function decodeRowRecord(raw: unknown): DynamicRowRecord {
  if (!plainRecord(raw) || !entryArray(raw["values"]) || !entryArray(raw["slots"])) throw new TypeError("DynamicGroup: malformed row record");
  return { ...raw, values: Object.fromEntries(raw["values"]), slots: Object.fromEntries(raw["slots"]) } as DynamicRowRecord;
}

function entryArray(value: unknown): value is [string, unknown][] {
  return Array.isArray(value) && [...value].every((pair) => Array.isArray(pair) && pair.length === 2 && typeof pair[0] === "string")
    && new Set(value.map((pair) => (pair as unknown[])[0])).size === value.length;
}

export interface DynamicRowGroup {
  fields: string[];
  initial_ids: string[];
  records: Map<string, DynamicRowRecord>;
}

export interface RowInputMarker { group: string; row_id: string; field: string }

export function rowSlot(row: DynamicRowRecord | undefined, field: string): RowSlot | undefined {
  return row && Object.hasOwn(row.slots, field) ? row.slots[field] : undefined;
}

export function rowField(name: string, group: string, fields: readonly string[]): { index: number; field: string } | null {
  if (!name.startsWith(`${group}.`)) return null;
  const suffix = name.slice(group.length + 1);
  const dot = suffix.indexOf(".");
  const index = suffix.slice(0, dot);
  const field = suffix.slice(dot + 1);
  return dot > 0 && /^(0|[1-9]\d*)$/.test(index) && Number.isSafeInteger(Number(index)) && fields.includes(field)
    ? { index: Number(index), field } : null;
}

export function storedRowGroup(node: Y.Map<unknown>, group: string): Y.Map<unknown> | null {
  const state = node.get(DYNAMIC_GROUP_STATE_KEY);
  if (state === undefined) return null;
  if (!(state instanceof Y.Map)) throw new TypeError("DynamicGroup: malformed row state");
  const data = state.get(group);
  if (data === undefined) return null;
  if (!(data instanceof Y.Map)) throw new TypeError(`DynamicGroup ${group}: malformed group state`);
  return data;
}

export function readRowGroup(data: Y.Map<unknown>): DynamicRowGroup {
  const fields = data.get("fields");
  const ids = data.get("initial_ids");
  const records = data.get("records");
  if (!Array.isArray(fields) || fields.length === 0 || [...fields].some((field) => typeof field !== "string" || field.length === 0) || new Set(fields).size !== fields.length || !Array.isArray(ids)
      || [...ids].some((id) => typeof id !== "string" || id.length === 0) || new Set(ids).size !== ids.length || !(records instanceof Y.Map)) {
    throw new TypeError("DynamicGroup: malformed group storage");
  }
  const rows = new Map<string, DynamicRowRecord>();
  records.forEach((raw, id) => {
    const row = decodeRowRecord(raw);
    if (!plainRecord(row.values) || !plainRecord(row.slots) || Object.keys(row.values).some((field) => !fields.includes(field))) {
      throw new TypeError("DynamicGroup: malformed row values or slots");
    }
    if ((row.after !== undefined && row.after !== null && typeof row.after !== "string") || (row.created !== undefined && row.created !== null && !validStamp(row.created)) || (row.deleted !== undefined && !validStamp(row.deleted))) throw new TypeError("DynamicGroup: malformed row ordering state");
    for (const [field, slot] of Object.entries(row.slots)) {
      if (!fields.includes(field) || !plainRecord(slot) || !plainRecord(slot.data) || (slot.original_index !== null && (!Number.isSafeInteger(slot.original_index) || slot.original_index < 0))) throw new TypeError("DynamicGroup: malformed row slot");
    }
    rows.set(id, row);
  });
  return { fields: fields as string[], initial_ids: ids as string[], records: rows };
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validStamp(value: unknown): value is StampKey {
  return Array.isArray(value) && value.length === 3 && Number.isSafeInteger(value[0]) && typeof value[1] === "string" && typeof value[2] === "string";
}

export function initialRowGroup(node: Y.Map<unknown>, group: string, fields: readonly string[]): DynamicRowGroup {
  const ids = dynamicGroupRowsOf(node.get("properties"))?.[group];
  if (!ids) throw new TypeError(`DynamicGroup ${group}: producer-owned row IDs are required`);
  const widgets = node.get("widgets");
  if (!(widgets instanceof Y.Map)) throw new TypeError(`DynamicGroup ${group}: named widget storage is required`);
  const records = new Map<string, DynamicRowRecord>();
  ids.forEach((id, index) => {
    const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const field of fields) {
      const key = widgetStorageKey(`${group}.${String(index)}.${field}`);
      if (widgets.has(key)) values[field] = structuredClone(widgets.get(key));
    }
    records.set(id, { after: index === 0 ? null : ids[index - 1]!, created: null, values, slots: {} });
  });
  const inputs = node.get("inputs");
  if (inputs instanceof Y.Array) inputs.forEach((slot, index) => {
    if (!(slot instanceof Y.Map) || typeof slot.get("name") !== "string") return;
    const parsed = rowField(slot.get("name") as string, group, fields);
    if (!parsed) return;
    const id = ids[parsed.index];
    if (id === undefined) throw new TypeError(`DynamicGroup ${group}: input has no row ID`);
    const row = records.get(id)!;
    if (Object.hasOwn(row.slots, parsed.field)) throw new TypeError(`DynamicGroup ${group}: duplicate row input`);
    row.slots = { ...row.slots, [parsed.field]: { original_index: index, data: structuredClone(slot.toJSON()) as Record<string, unknown> } };
  });
  return { fields: [...fields], initial_ids: [...ids], records };
}

export function groupRows(node: Y.Map<unknown>, group: string, entry: WidgetCatalogEntry): DynamicRowGroup {
  const metadata = entry.dynamic_groups?.[group];
  if (!metadata) throw new TypeError(`DynamicGroup ${group}: group metadata is required`);
  const stored = storedRowGroup(node, group);
  if (!stored) return initialRowGroup(node, group, metadata.widgets);
  const data = readRowGroup(stored);
  if (JSON.stringify(data.fields) !== JSON.stringify(metadata.widgets)) throw new TypeError(`DynamicGroup ${group}: catalog fields changed`);
  return data;
}

export function liveRowIds(group: DynamicRowGroup): string[] {
  assertAcyclicAnchors(group);
  const children = new Map<string | null, string[]>();
  for (const [id, row] of group.records) {
    if (row.created === undefined || row.after === undefined) continue;
    const siblings = children.get(row.after) ?? [];
    siblings.push(id);
    children.set(row.after, siblings);
  }
  for (const siblings of children.values()) siblings.sort((a, b) => {
    const left = group.records.get(a)!.created;
    const right = group.records.get(b)!.created;
    if (left === null && right !== null) return 1;
    if (left !== null && right === null) return -1;
    return left && right ? compareStampKeys(right, left) || codePointCompare(a, b) : codePointCompare(a, b);
  });
  const stack = [...(children.get(null) ?? [])].reverse();
  const visited = new Set<string>();
  const live: string[] = [];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (visited.has(id)) throw new TypeError("DynamicGroup: cyclic row anchors");
    visited.add(id);
    const row = group.records.get(id)!;
    if (!row.deleted) live.push(id);
    stack.push(...[...(children.get(id) ?? [])].reverse());
  }
  return live;
}

function assertAcyclicAnchors(group: DynamicRowGroup): void {
  const complete = new Set<string>();
  for (const id of group.records.keys()) {
    const path = new Set<string>();
    let current: string | null | undefined = id;
    while (current != null && !complete.has(current)) {
      if (path.has(current)) throw new TypeError("DynamicGroup: cyclic row anchors");
      const row = group.records.get(current);
      if (!row || row.created === undefined) break;
      path.add(current);
      current = row.after;
    }
    for (const visited of path) complete.add(visited);
  }
}

export function activeRowGroups(node: Y.Map<unknown>): Map<string, DynamicRowGroup> {
  const result = new Map<string, DynamicRowGroup>();
  const state = node.get(DYNAMIC_GROUP_STATE_KEY);
  if (state === undefined) return result;
  if (!(state instanceof Y.Map)) throw new TypeError("DynamicGroup: malformed row state");
  state.forEach((data, group) => {
    if (!(data instanceof Y.Map)) throw new TypeError("DynamicGroup: malformed group state");
    result.set(group, readRowGroup(data));
  });
  return result;
}

export function currentRowIds(node: Y.Map<unknown>): Record<string, readonly string[]> | null {
  const baseline = dynamicGroupRowsOf(node.get("properties"));
  if (!baseline) return null;
  const rows = { ...baseline };
  for (const [name, group] of activeRowGroups(node)) rows[name] = liveRowIds(group);
  return rows;
}

export function rowWidgetValues(node: Y.Map<unknown>): WidgetValues {
  const widgets = node.get("widgets");
  if (!node.has(DYNAMIC_GROUP_STATE_KEY) && widgets instanceof Y.Map) return widgets;
  const result = new Map<string, unknown>();
  if (widgets instanceof Y.Map) widgets.forEach((value, key) => result.set(key, value));
  for (const [name, group] of activeRowGroups(node)) {
    for (const key of result.keys()) if (rowField(widgetIdentityFromStorageKey(key).name, name, group.fields)) result.delete(key);
    const ids = liveRowIds(group);
    result.set(widgetStorageKey(name), ids.length);
    ids.forEach((id, index) => {
      const row = group.records.get(id)!;
      for (const [field, value] of Object.entries(row.values)) result.set(widgetStorageKey(`${name}.${String(index)}.${field}`), value);
    });
  }
  return result;
}

export function rowWidgetForm(node: Y.Map<unknown>): StoredWidgetForm | null {
  const source = storedWidgetFormOf(node);
  if (!source) return null;
  const groups = activeRowGroups(node);
  if (groups.size === 0) return source;
  const form = structuredClone(source);
  for (const [name, group] of groups) {
    const ids = liveRowIds(group);
    if (JSON.stringify(ids) === JSON.stringify(group.initial_ids)) continue;
    const order: string[] = [];
    for (const field of form.order) {
      if (rowField(field, name, group.fields)) continue;
      order.push(field);
      if (field === name) ids.forEach((_id, index) => group.fields.forEach((child) => order.push(`${name}.${String(index)}.${child}`)));
    }
    if (form.keys) {
      const retained = form.keys.filter((key) => !rowField(key, name, group.fields));
      const at = retained.indexOf(name);
      retained.splice(at + 1, 0, ...order.filter((key) => rowField(key, name, group.fields)));
      form.keys = retained;
    }
    form.order = order;
  }
  return form;
}

export interface RowInputProjection {
  inputs: unknown[];
  indices: Map<number, number>;
  rows: Map<string, number>;
  renames: Map<string, string | null>;
}

export function rowEndpointKey(group: string, row: string, field: string): string {
  return JSON.stringify([group, row, field]);
}

export function rowInputProjection(node: Y.Map<unknown>): RowInputProjection {
  const source = node.get("inputs");
  const raw = source instanceof Y.Array ? source.toArray() : [];
  const groups = activeRowGroups(node);
  const positions = new Map<string, Map<string, number>>();
  const renames = new Map<string, string | null>();
  for (const [name, group] of groups) {
    const ids = liveRowIds(group);
    positions.set(name, new Map(ids.map((id, index) => [id, index])));
    group.initial_ids.forEach((id, index) => group.fields.forEach((field) => {
      const current = positions.get(name)!.get(id);
      renames.set(`${name}.${String(index)}.${field}`, current === undefined ? null : `${name}.${String(current)}.${field}`);
    }));
  }
  const inputs: unknown[] = [];
  const indices = new Map<number, number>();
  const rows = new Map<string, number>();
  function append(marker: RowInputMarker, slot: RowSlot): void {
    const index = positions.get(marker.group)?.get(marker.row_id);
    if (index === undefined) return;
    const name = `${marker.group}.${String(index)}.${marker.field}`;
    const data = structuredClone(slot.data);
    data["name"] = name;
    if (typeof data["widget"] === "object" && data["widget"] !== null) data["widget"] = { ...data["widget"] as object, name };
    rows.set(rowEndpointKey(marker.group, marker.row_id, marker.field), inputs.length);
    if (slot.original_index !== null) indices.set(slot.original_index, inputs.length);
    inputs.push(data);
  }
  raw.forEach((slot, index) => {
    const value = slot instanceof Y.Map ? slot.toJSON() as Record<string, unknown> : slot;
    const marker = typeof value === "object" && value !== null ? (value as Record<string, unknown>)[DYNAMIC_GROUP_SLOT_KEY] as RowInputMarker | undefined : undefined;
    if (marker) {
      const data = rowSlot(groups.get(marker.group)?.records.get(marker.row_id), marker.field);
      if (!data) throw new TypeError("DynamicGroup: input marker has no row slot");
      append(marker, data);
    } else {
      indices.set(index, inputs.length);
      inputs.push(structuredClone(value));
    }
  });
  for (const [name, group] of groups) for (const id of liveRowIds(group)) for (const field of group.fields) {
    const slot = rowSlot(group.records.get(id), field);
    if (slot?.original_index === null) append({ group: name, row_id: id, field }, slot);
  }
  return { inputs, indices, rows, renames };
}
