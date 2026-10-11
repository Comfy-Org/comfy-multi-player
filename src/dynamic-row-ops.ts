import * as Y from "yjs";
import { adel, mdel, mset, mapValueRefusal } from "./doc.js";
import { compareStampKeys, stampKey } from "./stamps.js";
import { DYNAMIC_GROUP_SLOT_KEY, DYNAMIC_GROUP_STATE_KEY, OpRejectedError, type DynamicGroupRowOp, type StampKey, type WidgetCatalogEntry } from "./types.js";
import { groupRows, liveRowIds, rowField, storedRowGroup, encodeRowRecord, type DynamicRowGroup, type DynamicRowRecord } from "./dynamic-row-state.js";
import { widgetIdentityFromStorageKey } from "./widget-identity.js";

export function dynamicGroupRowId(opId: string, ordinal: number): string {
  if (!/^[0-9a-f]{32}$/.test(opId) || !Number.isSafeInteger(ordinal) || ordinal < 0) throw new TypeError("DynamicGroup: invalid insertion identity");
  return `row:${opId}:${String(ordinal)}`;
}

function refuse(message: string): never {
  throw new OpRejectedError("malformed_op", `DynamicGroup: ${message}`);
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function valueRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nodeId(value: unknown): boolean {
  return nonempty(value) || (typeof value === "number" && Number.isSafeInteger(value));
}

export function validateRowOp(op: DynamicGroupRowOp): void {
  if (!nonempty(op.group) || !nonempty(op.node_incarnation) || !/^[0-9a-f]{32}$/.test(op.op_id)) refuse("group, node lifetime and immutable insertion identity are required");
  if (!nodeId(op.node_id)) refuse("node_id is required");
  if (op.path !== undefined && (!Array.isArray(op.path) || op.path.length === 0 || [...op.path].some((part) => !nonempty(part)))) refuse("path must contain container instance IDs");
  if (op.stamp === undefined) refuse("creator stamp is required");
  if (op.op === "dynamic_group_insert_rows") return validateInsertion(op);
  if (op.op === "dynamic_group_delete_rows") return validateDeletion(op);
  validateRowEditOrLink(op);
}

function validateValues(value: unknown): void {
  if (!valueRecord(value) || Object.keys(value).length === 0) refuse("row values must be a nonempty field object");
  for (const field of Object.values(value)) {
    const refusal = mapValueRefusal(structuredClone(field));
    if (refusal) refuse(refusal);
  }
}

function validateInsertion(op: Extract<DynamicGroupRowOp, { op: "dynamic_group_insert_rows" }>): void {
  if (op.after_row_id !== null && !nonempty(op.after_row_id)) refuse("after_row_id must be a row ID or null");
  if (!Array.isArray(op.rows) || op.rows.length === 0) refuse("insertion requires at least one row");
  for (const value of op.rows) validateValues(value);
  if (op.rows.some((_row, index) => dynamicGroupRowId(op.op_id, index) === op.after_row_id)) refuse("an insertion cannot anchor to one of its own rows");
}
function validateDeletion(op: Extract<DynamicGroupRowOp, { op: "dynamic_group_delete_rows" }>): void {
  if (!Array.isArray(op.row_ids) || op.row_ids.length === 0 || [...op.row_ids].some((id) => !nonempty(id)) || new Set(op.row_ids).size !== op.row_ids.length) refuse("deletion requires distinct row IDs");
}
function validateRowEditOrLink(op: Exclude<DynamicGroupRowOp, { op: "dynamic_group_insert_rows" | "dynamic_group_delete_rows" }>): void {
  if (!nonempty(op.row_id)) refuse("row_id is required");
  if (op.op === "dynamic_group_set_row") validateRowValues(op);
  else validateRowConnection(op);
}

function validateRowValues(op: Extract<DynamicGroupRowOp, { op: "dynamic_group_set_row" }>): void {
  validateValues(op.values);
  if (op.host_path !== undefined && (!Array.isArray(op.host_path) || op.host_path.length === 0 || [...op.host_path].some((id) => !nonempty(id)) || !nonempty(op.host_incarnation))) refuse("a host path requires its lifetime");
  if (op.host_path === undefined && op.host_incarnation !== undefined) refuse("host lifetime has no host path");
}
function validateRowConnection(op: Extract<DynamicGroupRowOp, { op: "dynamic_group_connect" | "dynamic_group_disconnect" }>): void {
  if (!nonempty(op.field)) refuse("field is required");
  if (op.op === "dynamic_group_connect") {
    if (!nodeId(op.from_node) || !Number.isSafeInteger(op.from_slot) || op.from_slot < 0 || !nonempty(op.link_type) || !nonempty(op.input_type)) refuse("connection needs a source node, slot and input/link types");
    if (!nodeId(op.link_id)) refuse("link identity is required");
  }
}

export function rowFieldStamp(owner: string | string[], incarnation: string, group: string, row: string, field: string, kind = "dynamic_group_widget"): string {
  return JSON.stringify([kind, owner, incarnation, group, row, field]);
}

export interface RowMutationPlan {
  group: DynamicRowGroup;
  writes: Map<string, DynamicRowRecord>;
  stamps: Map<string, StampKey>;
  outcome: "applied" | "no-op" | "lww-dropped";
}

export function prepareRowMutation(node: Y.Map<unknown>, owner: string | string[], op: DynamicGroupRowOp, entry: WidgetCatalogEntry, stamps: Pick<Y.Map<unknown>, "get">, digest: string): RowMutationPlan {
  const group = groupRows(node, op.group, entry);
  const writes = new Map<string, DynamicRowRecord>();
  const stampWrites = new Map<string, StampKey>();
  const key = stampKey(op);
  const live = new Set(liveRowIds(group));
  let changed = false;
  let visible = false;
  function row(id: string): DynamicRowRecord {
    const current = writes.get(id) ?? group.records.get(id) ?? { values: {}, slots: {} };
    const next = structuredClone(current);
    writes.set(id, next);
    return next;
  }
  function claim(id: string, field: string, kind?: string): boolean {
    const target = rowFieldStamp(owner, op.node_incarnation, op.group, id, field, kind);
    const prior = stamps.get(target) as StampKey | undefined;
    if (prior && compareStampKeys(key, prior) <= 0) return false;
    stampWrites.set(target, key);
    changed = true;
    return true;
  }
  function known(values: Record<string, unknown>, complete: boolean): void {
    if (Object.keys(values).some((field) => !group.fields.includes(field)) || (complete && group.fields.some((field) => !Object.hasOwn(values, field)))) refuse("fields must match the group template");
  }
  function insertRows(op: Extract<DynamicGroupRowOp, { op: "dynamic_group_insert_rows" }>): void {
    op.rows.forEach((values, index) => {
      known(values, true);
      const id = dynamicGroupRowId(op.op_id, index);
      const next = row(id);
      if (next.created !== undefined && next.insert_digest !== digest) throw new OpRejectedError("op_id_reuse", "DynamicGroup: row insertion identity was reused");
      if (next.created === undefined) {
        next.after = index === 0 ? op.after_row_id : dynamicGroupRowId(op.op_id, index - 1);
        next.created = key;
        next.insert_digest = digest;
        changed = true;
      }
      for (const [field, value] of Object.entries(values)) if (claim(id, field)) next.values = { ...next.values, [field]: structuredClone(value) };
      visible ||= !next.deleted;
    });

  }
  function setRow(op: Extract<DynamicGroupRowOp, { op: "dynamic_group_set_row" }>): void {
    known(op.values, false);
    const next = row(op.row_id);
    for (const [field, value] of Object.entries(op.values)) if (claim(op.row_id, field)) next.values = { ...next.values, [field]: structuredClone(value) };
    visible = live.has(op.row_id);

  }
  function deleteRows(op: Extract<DynamicGroupRowOp, { op: "dynamic_group_delete_rows" }>): void {
    for (const id of op.row_ids) {
      const next = row(id);
      if (!next.deleted || compareStampKeys(key, next.deleted) > 0) {
        next.deleted = key;
        claim(id, "", "dynamic_group_delete");
      }
      visible ||= live.has(id);
    }

  }
  function linkRow(op: Extract<DynamicGroupRowOp, { op: "dynamic_group_connect" | "dynamic_group_disconnect" }>): void {
    if (!group.fields.includes(op.field)) refuse("connection field is not in the group template");
    const next = row(op.row_id);
    if (claim(op.row_id, op.field, "dynamic_group_input")) {
      const prior = Object.hasOwn(next.slots, op.field) ? next.slots[op.field] : undefined;
      if (!prior && op.op === "dynamic_group_disconnect") return;
      const slot = prior ?? { original_index: null, data: { type: op.op === "dynamic_group_connect" ? op.input_type : "*", widget: { name: op.field } } };
      if (op.op === "dynamic_group_connect" && slot.data["type"] !== op.input_type) refuse("input type disagrees with the stored row slot");
      slot.data["link"] = op.op === "dynamic_group_connect" ? op.link_id : null;
      next.slots = { ...next.slots, [op.field]: slot };
    }
    visible = live.has(op.row_id);

  }
  if (op.op === "dynamic_group_insert_rows") insertRows(op);
  else if (op.op === "dynamic_group_set_row") setRow(op);
  else if (op.op === "dynamic_group_delete_rows") deleteRows(op);
  else linkRow(op);
  let outcome: RowMutationPlan["outcome"] = "lww-dropped";
  if (changed) outcome = visible ? "applied" : "no-op";
  return { group, writes, stamps: stampWrites, outcome };
}

export function commitRowMutation(node: Y.Map<unknown>, groupName: string, plan: RowMutationPlan, stamps: Y.Map<unknown>): void {
  if (plan.outcome === "lww-dropped") return;
  let stored = storedRowGroup(node, groupName);
  if (!stored) {
    const rows = new Y.Map<unknown>();
    for (const [id, row] of plan.group.records) rows.set(id, encodeRowRecord(row));
    stored = new Y.Map<unknown>();
    stored.set("fields", [...plan.group.fields]);
    stored.set("initial_ids", [...plan.group.initial_ids]);
    stored.set("records", rows);
    let groups = node.get(DYNAMIC_GROUP_STATE_KEY);
    if (!(groups instanceof Y.Map)) {
      groups = new Y.Map<unknown>();
      mset(node, DYNAMIC_GROUP_STATE_KEY, groups);
    }
    mset(groups as Y.Map<unknown>, groupName, stored);
    replaceInitialRowSlots(node, groupName, plan.group);
  }
  const rows = stored.get("records") as Y.Map<unknown>;
  for (const [id, row] of plan.writes) mset(rows, id, encodeRowRecord(row));
  for (const [target, key] of plan.stamps) mset(stamps, target, key);
}

function replaceInitialRowSlots(node: Y.Map<unknown>, groupName: string, group: DynamicRowGroup): void {
  const widgets = node.get("widgets");
  if (widgets instanceof Y.Map) for (const name of [...widgets.keys()]) if (rowField(widgetIdentityFromStorageKey(name).name, groupName, group.fields)) mdel(widgets, name);
  const inputs = node.get("inputs");
  if (!(inputs instanceof Y.Array)) return;
  for (const [id, row] of group.records) for (const [field, slot] of Object.entries(row.slots)) {
    if (slot.original_index === null) continue;
    const marker = new Y.Map<unknown>();
    marker.set(DYNAMIC_GROUP_SLOT_KEY, { group: groupName, row_id: id, field });
    adel(inputs, slot.original_index);
    inputs.insert(slot.original_index, [marker]);
  }
}
