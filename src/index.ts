/**
 * @comfyorg/comfy-multi-player — shared workflow-document package.
 *
 * One implementation of op→doc semantics, used identically by the browser
 * and the server doc host. The op vocabulary is frozen at six kinds; the
 * normative contract is comfy-cli's `docs/op-vocabulary-v1.md` (branch
 * `fix/validate-lowers-ui-to-api`) and the stamp shapes minted by
 * `comfy_cli/workflow_ops.py` (`_new_op`).
 *
 * This module is PURE: no DOM, no framework, no litegraph. `yjs` is the only
 * runtime dependency. CI enforces this (scripts/check-purity.mjs).
 */

import * as Y from "yjs";

// ---------------------------------------------------------------------------
// Schema version
// ---------------------------------------------------------------------------

/**
 * Version of the Y.Doc layout. Bump requires FE sign-off + a `migrate` path.
 * The authoritative layout + op-semantics reference is docs/multiplayer-schema.md.
 */
export const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Identity & stamps (mirrors comfy_cli/workflow_ops.py `_new_op`)
// ---------------------------------------------------------------------------

/** Who minted an op: "cli", "agent", a user/session id, … */
export type Actor = string;

/**
 * Node / link identity. comfy-cli mints ints (`mint_id()`), but historical
 * workflows carry string ids and subgraph-scoped addresses are strings of the
 * form `"57:3"` (instance id `:` interior id). Treat as opaque; compare with
 * String() normalization.
 */
export type NodeId = string | number;

/**
 * Causal stamp for last-writer-wins: `[base_version, actor]`, exact ties
 * broken by `op_id` into a total order. Matches the `stamp` field minted by
 * `_new_op` in comfy-cli.
 */
export type Stamp = [baseVersion: number, actor: Actor];

/** Envelope every op carries (comfy-cli `_new_op`). */
export interface OpBase {
  /** Unique op identity (uuid4 hex in comfy-cli). Idempotence key: an op whose op_id was already applied is a no-op. */
  op_id: string;
  actor: Actor;
  /** Doc version the op was minted against. */
  base_version: number;
  /** `[base_version, actor]` — see {@link Stamp}. */
  stamp: Stamp;
}

// ---------------------------------------------------------------------------
// The six frozen op kinds
// ---------------------------------------------------------------------------

export interface AddNodeOp extends OpBase {
  op: "add_node";
  node_id: NodeId;
  class_type: string;
  /** Layout decided at mint time so replay stays convergent. */
  pos: number[];
  /** Full mint-time node snapshot (id/type/pos/size/flags/order/mode/inputs/outputs/widgets_values). */
  node: WorkflowNode;
}

export interface ConnectOp extends OpBase {
  op: "connect";
  /** Link identity, minted at op-mint time (int in comfy-cli). */
  link_id: NodeId;
  from_node: NodeId;
  from_slot: number;
  to_node: NodeId;
  /** Concrete input index, or null when the slot is grown at apply time (autogrow). */
  to_slot: number | null;
  link_type: string;
  /** Autogrow payload: apply appends this input slot, then wires it. Non-clobbering. */
  grow?: { name: string; type: string; [key: string]: unknown };
}

export interface SetWidgetOp extends OpBase {
  op: "set_widget";
  node_id: NodeId;
  /** Widget NAME — widgets are name-addressed, never index-addressed. */
  widget: string;
  value: unknown;
  /** Previous value at mint time (informational; not used for convergence). */
  old?: unknown;
  /** Subgraph interior addressing: node path segments (e.g. ["57","27"]). */
  path?: string[];
  /** Interior widget name when `path` is present. */
  inner_widget?: string;
  /** Non-fatal validation notes attached at mint time. */
  warnings?: string[];
}

export interface DeleteNodeOp extends OpBase {
  op: "delete_node";
  node_id: NodeId;
  /** Link ids severed by this delete (recorded at mint time). */
  removed_links: NodeId[];
}

export interface ClearOp extends OpBase {
  op: "clear";
  /** Node ids present at mint time. Id counters are preserved across a clear. */
  removed_nodes: NodeId[];
}

/**
 * Replace the entire document with a workflow snapshot.
 *
 * NOTE: comfy-cli does not mint this kind yet (no `reset_doc` in
 * workflow_ops.py as of 2026-08-12); the payload below is this package's
 * first-draft definition and MUST be reviewed against the op-vocabulary doc
 * before the applier lands.
 */
export interface ResetDocOp extends OpBase {
  op: "reset_doc";
  workflow: WorkflowJSON;
}

/** The six frozen op kinds — a discriminated union on `op`. */
export type Op =
  | AddNodeOp
  | ConnectOp
  | SetWidgetOp
  | DeleteNodeOp
  | ClearOp
  | ResetDocOp;

// ---------------------------------------------------------------------------
// Widget catalog (pinned object_info projection)
//
// The op model is deliberately name-addressed and therefore NOT self-contained:
// projecting the name-keyed `widgets` map back to the positional
// `widgets_values` array requires the widget order of the object_info catalog
// the document pins (`meta.catalog_version`). Apply needs the catalog only for
// autogrow collision renames (`autogrow_templates`).
// See docs/multiplayer-schema.md §1.2 / §7; fixtures/catalog.json is the shape.
// ---------------------------------------------------------------------------

/** Per-class widget metadata from the pinned object_info catalog. */
export interface WidgetCatalogEntry {
  /** Widget names in positional (widgets_values) order. */
  widget_order: string[];
  /** Autogrow element-naming templates, keyed by the growable input's base name. */
  autogrow_templates?: Record<string, { prefix?: string; names?: string[] }>;
}

/** The pinned catalog: class_type → entry. Matches fixtures/catalog.json. */
export interface WidgetCatalog {
  comment?: string;
  types: Record<string, WidgetCatalogEntry>;
}

// ---------------------------------------------------------------------------
// Workflow JSON (loose — the projection target, litegraph-shaped)
// ---------------------------------------------------------------------------

export interface WorkflowNode {
  id: NodeId;
  type: string;
  pos?: number[];
  size?: number[];
  flags?: Record<string, unknown>;
  order?: number;
  mode?: number;
  inputs?: unknown[];
  outputs?: unknown[];
  widgets_values?: unknown[] | Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * ComfyUI workflow JSON, typed loosely on purpose: this package guarantees
 * the fields it projects and passes everything else through untouched.
 */
export interface WorkflowJSON {
  nodes: WorkflowNode[];
  links: unknown[];
  groups?: unknown[];
  extra?: Record<string, unknown>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Apply result
// ---------------------------------------------------------------------------

/** Outcome of `applyOps` — per-op accounting, never a throw for a rejected op. */
export interface ApplyResult {
  /** op_ids applied to the doc. */
  applied: string[];
  /** op_ids skipped: already-applied (idempotence) or dropped by last-writer-wins. */
  skipped: string[];
  /** Ops rejected with a reason (unknown kind, malformed payload, …). */
  rejected: { op_id: string; reason: string }[];
  /** Doc version after apply. */
  version: number;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown by stubs whose implementation lands in a later ticket. */
export class NotImplementedError extends Error {
  override name = "NotImplementedError";
  constructor(what: string) {
    super(`${what} is not implemented yet (scaffold stub — see V1-030)`);
  }
}

// ---------------------------------------------------------------------------
// Doc layout helpers (schema v1 — docs/multiplayer-schema.md §1)
//
//   doc
//   ├── Y.Map 'nodes'       — key: String(node id) → per-node Y.Map
//   │     └── type: string, pos: number[], flags: Y.Map,
//   │         widgets: Y.Map (widget NAME → value; positional
//   │         widgets_values exists only in projection — §1.2), …
//   ├── Y.Map 'links'       — key: String(link id) → plain link tuple
//   ├── Y.Map 'definitions' — key: subgraph def id → def Y.Map with its own
//   │                         nested 'nodes'/'links' (recursively — §5)
//   ├── Y.Map 'meta'        — schema_version, catalog_version,
//   │                         last_node_id, last_link_id,
//   │                         groups/extra/… passthrough (plain values, §6)
//   ├── Y.Map '__applied'   — op_id → 1 (idempotency, §4)
//   └── Y.Map '__stamps'    — write-target key → [base_version, actor, op_id] (§4)
// ---------------------------------------------------------------------------

/** Root map holding one Y.Map per node, keyed by String(node id). */
export function nodesMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap<Y.Map<unknown>>("nodes");
}

/** Root map holding one link record per link, keyed by String(link id). */
export function linksMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap<unknown>("links");
}

/**
 * Root map holding subgraph definitions, keyed by definition id — first-class
 * so interior writes stay bounded (schema §5.1), never a meta blob.
 */
export function definitionsMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap<Y.Map<unknown>>("definitions");
}

/** Root map holding schema_version, catalog_version, id high-water marks, and passthrough keys. */
export function metaMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap<unknown>("meta");
}

/**
 * Initialize the v1 layout on a fresh doc (idempotent). Creates the root maps
 * (including bookkeeping) and seeds meta with schema_version, the pinned
 * catalog_version, and the id high-water marks.
 *
 * NOTE: initializing a doc is not the bootstrap path for replicas — replicas
 * fork from one common mint() snapshot (schema §9), never re-seed.
 */
export function initDoc(doc: Y.Doc, catalogVersion = ""): Y.Doc {
  doc.transact(() => {
    nodesMap(doc);
    linksMap(doc);
    definitionsMap(doc);
    doc.getMap("__applied");
    doc.getMap("__stamps");
    const meta = metaMap(doc);
    if (meta.get("schema_version") === undefined) {
      meta.set("schema_version", SCHEMA_VERSION);
      meta.set("catalog_version", catalogVersion);
      meta.set("last_node_id", 0);
      meta.set("last_link_id", 0);
      // Passthrough keys (extra/groups/…) are opaque PLAIN values (schema §6),
      // never Y types — they are replaced whole, not field-merged.
      meta.set("extra", {});
    }
  });
  return doc;
}

/**
 * Build the per-node Y.Map for a workflow node: scalar fields copied, flags
 * as a nested Y.Map, widgets as a NAME-KEYED Y.Map (schema §1.2 — the spike
 * proved positional Y.Array widgets corrupt under same-index concurrency).
 *
 * `widgetOrder` (the pinned catalog's `widget_order` for the node's type) is
 * required to decompose a positional `widgets_values` array; a node whose
 * `widgets_values` is already a name-keyed record needs no catalog.
 */
export function createNodeMap(node: WorkflowNode, widgetOrder?: readonly string[]): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  m.set("id", node.id);
  m.set("type", node.type);
  if (node.pos) m.set("pos", [...node.pos]);
  if (node.size) m.set("size", [...node.size]);
  m.set("order", node.order ?? 0);
  m.set("mode", node.mode ?? 0);
  const flags = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(node.flags ?? {})) flags.set(k, v);
  m.set("flags", flags);
  const widgets = new Y.Map<unknown>();
  const wv = node.widgets_values;
  if (Array.isArray(wv)) {
    if (!widgetOrder) {
      throw new TypeError(
        `createNodeMap(${node.type}): positional widgets_values requires the pinned catalog widget_order (schema §1.2)`,
      );
    }
    if (wv.length > widgetOrder.length) {
      throw new TypeError(
        `createNodeMap(${node.type}): widgets_values has ${wv.length} entries but widget_order names only ${widgetOrder.length}`,
      );
    }
    wv.forEach((v, i) => widgets.set(widgetOrder[i]!, structuredClone(v)));
  } else if (wv && typeof wv === "object") {
    for (const [k, v] of Object.entries(wv)) widgets.set(k, structuredClone(v));
  }
  m.set("widgets", widgets);
  if (node.inputs) m.set("inputs", structuredClone(node.inputs));
  if (node.outputs) m.set("outputs", structuredClone(node.outputs));
  return m;
}

// ---------------------------------------------------------------------------
// Public API stubs (implementations land with the applier spike)
// ---------------------------------------------------------------------------

/**
 * Apply a batch of stamped ops to the doc, transactionally, tagged with
 * `origin` for awareness/undo scoping. Idempotent per op_id; convergent under
 * reordering via the `[base_version, actor, op_id]` stamp order (schema §3).
 *
 * `catalog` is needed only by the autogrow-connect collision-rename path and
 * the `inputcount`-family grow (schema §8.3) — widget writes are name-keyed
 * and catalog-free at apply time (schema §1.2).
 */
export function applyOps(doc: Y.Doc, ops: Op[], origin: Actor, catalog?: WidgetCatalog): ApplyResult {
  void doc;
  void ops;
  void origin;
  void catalog;
  // TODO(V1): port apply semantics from comfy_cli/workflow_ops.py apply_op —
  // idempotence by op_id, LWW by stamp for set_widget, non-clobbering autogrow
  // for connect (incl. inputcount two-register grow, schema §8.3), monotonic
  // id counters across clear. First draft: reference/spike/applier.mjs.
  throw new NotImplementedError("applyOps");
}

/**
 * Project the doc to canonical ComfyUI workflow JSON (schema §7): nodes and
 * links sorted by id, name-keyed `widgets` assembled into the positional
 * `widgets_values` array via the pinned catalog's widget order, passthrough
 * meta keys verbatim. Pure read; byte-stable for a given doc state so browser
 * and server render identical JSON.
 */
export function project(doc: Y.Doc, catalog: WidgetCatalog): WorkflowJSON {
  void doc;
  void catalog;
  // TODO(V1): deterministic projection per schema §7 — sorted-by-id order,
  // widgets map → positional array via catalog widget_order, links: null
  // preserved verbatim, meta passthrough.
  throw new NotImplementedError("project");
}

/**
 * Import an existing workflow JSON into a fresh doc (lazy-mint at cutover).
 * `project(mint(w, catalog), catalog)` must deep-equal `w` modulo the schema
 * §7 canonicalization. The mint() output is THE bootstrap snapshot: every
 * replica forks from it via applyUpdate — never independently re-seeds
 * (schema §9).
 */
export function mint(workflow: WorkflowJSON, catalog: WidgetCatalog): Y.Doc {
  void workflow;
  void catalog;
  // TODO(V1): build nodes/links/definitions/meta from the JSON via
  // createNodeMap (positional widgets_values decomposed through the catalog);
  // seed last_node_id/last_link_id + catalog_version; stash unknown top-level
  // keys in meta as passthrough.
  throw new NotImplementedError("mint");
}

/**
 * Migrate a doc from an older schema layout to SCHEMA_VERSION, in place.
 * No-op when fromVersion === SCHEMA_VERSION.
 */
export function migrate(doc: Y.Doc, fromVersion: number): void {
  if (fromVersion === SCHEMA_VERSION) return;
  void doc;
  // TODO(V1): stepwise vN→vN+1 migrations once a v2 layout exists.
  throw new NotImplementedError(`migrate (from schema v${fromVersion})`);
}
