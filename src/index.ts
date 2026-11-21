/**
 * @comfyorg/comfy-multi-player — shared workflow-document package.
 *
 * One implementation of op→doc semantics, used identically by the browser
 * and the server doc host. The public vocabulary declares nine operation
 * kinds: eight implemented kinds plus the deferred `reset_doc` kind. The
 * normative contract is comfy-cli's `docs/op-vocabulary-v1.md` and the stamp
 * shapes minted by `comfy_cli/workflow_ops.py` (`_new_op`), both pinned at
 * comfy-cli commit `7e732242d971daf0d2d30f22f997abfacd78986e` — by SHA and
 * never by branch, because a branch re-targets silently and a contract that
 * moves under a citation is the FC-10 failure. Section numbers quoted in this
 * package are section numbers AT THAT COMMIT. The pin registry, how the SHA was
 * established, and the amendments upstream has since added are in
 * docs/upstream-pins.json (`npm run check:pins`). The Y.Doc layout and
 * op-semantics reference is docs/multiplayer-schema.md.
 *
 * Public surface:
 *  - `mint(workflow, catalog)` — workflow JSON → fresh Y.Doc (the bootstrap
 *    snapshot every replica forks from — schema §9);
 *  - `compact(doc, catalog)` — fresh-checkpoint re-mint (schema §4 rule 2):
 *    a new-lineage Y.Doc with the same projection, live stamps, incarnations,
 *    link state and clock reservations but an empty `__applied` ledger and no
 *    tombstone history; the host owns the replica cutover;
 *  - `applyOps(doc, ops, catalog?)` — idempotent, LWW-gated, abort-remainder
 *    op application (schema §2–§4);
 *  - `inspectOps(ops)` — pure validation and canonical bytes/digest/stamp
 *    extraction for storage preflight (ADR-API-0022);
 *  - `project(doc, catalog)` — canonical workflow JSON projection (schema §7),
 *    fail-closed on a schema this package cannot read (KA-11);
 *  - `migrate(doc, fromVersion)` — layout versioning, fail-closed (schema §10);
 *  - `readSchemaVersion(doc)` / `assertReadableSchema(doc, context)` — the
 *    KA-11 read gate, for a host that wants to refuse a mismatched document
 *    with its own structured error before it reads;
 *  - `encodingLosses(value)` — a read-only diagnostic for values that Yjs
 *    accepts but does not preserve across encode → decode;
 *  - stamp machinery (`compareStampKeys`, `stampKey`, `writeTarget`) for
 *    hosts that need conflict identity or watermark bookkeeping;
 *  - evidence-only collaboration trace declarations and
 *    `assertCollabReplayTraceV1` for fail-closed trace reads;
 *  - the ADR-DISTRIBUTION-0004 follower read surface (`nodesMap`, `linksMap`,
 *    `OPAQUE_WIDGETS_KEY`) for consuming the wire layout without applying ops;
 *  - the safer snapshot surface (`readGraph`, `readMeta`, `docCatalogPin`,
 *    `hasNode`, `hasAppliedOp`, `appliedOpIds`, `readApplied`, `readStamps`) for
 *    consumers
 *    that do not need ADR-DISTRIBUTION-0004's live follower handles — see src/read.ts;
 *  - the ADR-API-0023 widget-identity and placeability questions
 *    (`catalogPlacesDynamicName`, `overflowWidgetName`,
 *    `parseOverflowWidgetName`, `widgetStorageKey`,
 *    `widgetIdentityFromStorageKey`) for a host guard that must agree with
 *    this package on whether a stored name can be placed;
 *  - operation, workflow, catalog, and result types.
 *
 * Every other Y.Doc layout and low-level mutation helper is deliberately
 * module-private. Consumers that own mutation must change shared state through
 * `applyOps` so stamp, idempotency, and convergence semantics cannot be bypassed.
 *
 * This module is PURE: no DOM, no framework, no litegraph. `yjs` is the only
 * runtime dependency. CI enforces this (scripts/check-purity.mjs).
 */

export * from "./types.js";
export * from "./event-schema.js";
export * from "./stamps.js";
export * from "./limits.js";
export * from "./clock.js";
export {
  CMP_EVENT_SCHEMA_VERSION,
  type CmpCallContext,
  type CmpEvent,
  type CmpEventSink,
  type CmpEventType,
} from "./events.js";
export * from "./collab-trace.js";
/**
 * ADR-DISTRIBUTION-0004 follower read-surface. These helpers expose the established wire
 * layout only so the frontend follower can consume host updates. They are
 * read-only by contract: followers never write and never call `applyOps`
 * (KA-1, KA-6, FC-5); the host remains the sole op applier.
 */
export {
  OPAQUE_WIDGETS_KEY,
  encodingLosses,
  linksMap,
  nodesMap,
  type EncodingLoss,
} from "./doc.js";
/**
 * Amendment A24 — the node-local widget form. `WIDGET_FORM_FIELD` is the
 * workflow field a PRODUCER writes and `WidgetValuesForm` is its shape, so a
 * serializer does not hardcode the name; `WIDGET_FORM_KEY` is the doc-internal
 * storage key a catalog-less follower reads to tell the three widget-storage
 * strategies apart. No applier internals are exported: deriving, validating
 * and projecting a form stay owned by this package, so a consumer cannot
 * build a second interpretation of the same declaration.
 */
export {
  WIDGET_FORM_FIELD,
  WIDGET_FORM_KEY,
  type WidgetFormShape,
  type WidgetValuesForm,
} from "./widget-form.js";
/**
 * ADR-API-0023 — the widget-identity and placeability questions a host guard
 * must answer the same way this package does.
 *
 * These are READ-ONLY questions about a name and a pinned catalog entry. They
 * are published because withholding them did not stop a second interpretation
 * of the placement rule from being written — it forced one. The doc-host's
 * `catalogpins.ts` guard, which must agree with this package or refuse
 * documents the package itself just minted, carries five hand copies of the
 * rules below, each added after a production lockout:
 *
 *  - 2026-10-08 (v0.448.0) — dynamic-combo option names, copied from
 *    `optionOwnedWidgets`;
 *  - 2026-10-12 and 2026-10-15 — selection-relative overflow slots, copied
 *    from the `_extra_<n>` naming in `overflowWidgetName`;
 *  - 2026-11-18 (v0.557.0) — dynamic-group row fields, copied from
 *    `isDynamicGroupField`; 279 refused turns over 6 workflows, with the
 *    documented stale-schema reseed also refused, so the class had no
 *    automatic recovery.
 *
 * {@link catalogPlacesDynamicName} is the applier's own name check, called by
 * it, so a consumer cannot answer it differently. `overflowWidgetName` /
 * `parseOverflowWidgetName` and `widgetStorageKey` /
 * `widgetIdentityFromStorageKey` are the two spellings a consumer must share
 * to read a stored key at all; the overflow copy fails OPEN on a rename, which
 * is why it is published rather than left to be copied again.
 *
 * This does NOT widen the mutation surface and is not a retreat from the
 * closed-barrel rule (issue #18): no applier internal, no Y.Doc layout helper
 * and no mutation path is exported, and deriving, validating and projecting a
 * widget form stay owned by this package. A caller still changes shared state
 * only through `applyOps`.
 */
export { catalogPlacesDynamicName } from "./dynamic-combos.js";
export { overflowWidgetName, parseOverflowWidgetName } from "./doc.js";
export {
  widgetIdentityFromStorageKey,
  widgetStorageKey,
  type WidgetIdentity,
} from "./widget-identity.js";
export { applyOps, inspectOps } from "./applier.js";
export { project } from "./project.js";
export { mint } from "./mint.js";
export { compact } from "./compact.js";
export { migrate } from "./migrate.js";
export { assertReadableSchema, readSchemaVersion } from "./schema-version.js";
export {
  appliedOpIds,
  docCatalogPin,
  hasAppliedOp,
  hasNode,
  readApplied,
  readGraph,
  readLinkState,
  readMeta,
  readStamps,
  type GraphSnapshot,
  type NodeSnapshot,
} from "./read.js";
