# API-contract review

Catch breaking changes to this package's public surface. Applies to `src/index.ts`, exported types, the op vocabulary, the wire envelope, and `schema_version`/`catalog_version` handling.

## What to check

1. **Public exports** — `src/index.ts` re-exports the op layer (including ADR-API-0022's pure `inspectOps` storage preflight), KA-11 read gate, ADR-DISTRIBUTION-0004 follower reads, #71's payload-bound constants and `opBoundsRefusal` from `src/limits.ts`, the snapshot surface from `src/read.ts`, and everything from `types` and `stamps`. A removed or renamed export without a compatibility alias is breaking. New exports are fine only when deliberately classified.
   Most of `src/doc.ts` stays private because its accessors and mutators bypass the op layer (KA-1, KA-2, KA-4, FC-5). Re-adding `export * from "./doc.js"`, or adding a `./doc` subpath, or exposing any further `doc.ts` runtime export from the entrypoint, is a blocking finding, not a compatibility fix. The named exceptions are `nodesMap`, `linksMap`, and `OPAQUE_WIDGETS_KEY` (ADR-DISTRIBUTION-0004's frontend-follower reads) plus `encodingLosses` (KA-1's read-only value diagnostic, which takes no document); `test/public-api.regression.test.ts` guards that exact list, and widening it is a diff rather than a silent consequence of adding an export.
   Prefer snapshot reads for new consumers: values returned by `src/read.ts` must not expose a live `Y.AbstractType`, at any depth. `test/readonly-surface.test.ts` proves its current functions return deep-copied, deep-frozen plain data, and that they refuse a document carrying content under an unreadable schema on the same predicate `project()` uses (KA-11). Not the same DISPOSITION, and do not report it as such: for a document carrying NOTHING the snapshot surface returns its empty value where `project()` refuses — Amendment A12 records that divergence against A5's consumer-impact note. Two things are blocking findings here: a gate on this surface that asks "does the document carry content" by enumerating the §1 root NAMES (blind to a v2 that renamed them, which is the canonical bump trigger), and a new entrypoint export not classified by that test.

<!-- claim: "encodingLosses", :: test/public-api.regression.test.ts -->
<!-- claim: read-only surface — the KA-11 read gate (#38) :: test/readonly-surface.test.ts -->
<!-- claim: export * from "./limits.js"; :: src/index.ts -->
2. **Op vocabulary** — op kind names, required fields, and the frozen/deferred sets are a contract shared with the server. Renaming an op kind, adding a required field to an existing op, or moving an op between frozen and deferred is breaking; cite the vocabulary section.
<!-- claim: export const FROZEN_OPS = [ :: src/types.ts -->
<!-- claim: export const DEFERRED_OPS = ["reset_doc"] as const; :: src/types.ts -->
<!-- claim: export type WireOp = Op | DeferredOp; :: src/types.ts -->
3. **Exported event envelopes** — keep the two public event surfaces distinct. `AgentEvent` is the cross-repo `{ type, data }` broadcast envelope pinned against the vendored Go contract; it does not carry `data.v`. Caller-owned `CmpEvent` telemetry carries `schema_version` at the top level. Changing an existing event type, payload shape, or schema version without a documented migration is breaking.
<!-- claim: type: "object", additionalProperties: false, required: ["type", "data"], :: src/event-schema.ts -->
<!-- claim: export const CMP_EVENT_SCHEMA_VERSION = 1 as const; :: src/events.ts -->
<!-- claim: readonly schema_version: typeof CMP_EVENT_SCHEMA_VERSION; :: src/events.ts -->
4. **Stamp/order contract** — the total order key `[base_version, actor, op_id]` and ADR-API-0007's `ApplyResult` are consumed downstream. `ApplyResult.outcomes` has one ordered discriminated result per submitted op (`applied`, `no-op`, `lww-dropped`, or `rejected`), and `ops_seen` is the consumed-op ledger size rather than a CAS token. Narrowing or reshaping either contract is breaking.
<!-- claim: export type StampKey = [baseVersion: number, actor: Actor, opId: string]; :: src/types.ts -->
<!-- claim: | { op_id: string; outcome: "applied" } :: src/types.ts -->
<!-- claim: | { op_id: string; outcome: "no-op" } :: src/types.ts -->
<!-- claim: | { op_id: string; outcome: "lww-dropped" } :: src/types.ts -->
<!-- claim: outcome: "rejected"; :: src/types.ts -->
<!-- claim: outcomes: ApplyOutcome[]; :: src/types.ts -->
<!-- claim: ops_seen: number; :: src/types.ts -->
   In private alpha, `base_version` is the creator-owned Lamport counter carried in the single op format. DQ-11 incarnation-qualified target keys must remain unchanged.
5. **Schema/catalog versioning** — bump `SCHEMA_VERSION` when an old reader would mis-project a new doc, and document an explicit old-layout disposition (KA-11). The current schema-v5 implementation refuses old layouts without mutation or relabelling, provides no compatibility reader, and requires re-minting source workflows. Schema A22 requires coordinated reader adoption and frontend sign-off before rollout; source integration is not a package release or consumer acceptance. A future release must explicitly choose and document refusal, migration, or another disposition rather than universally promising migration support. Silently changing on-doc shape without a version bump is a breaking, fail-open change.
<!-- claim: export const SCHEMA_VERSION = 5; :: src/types.ts -->
<!-- claim: export function migrate(doc: Y.Doc, fromVersion: number): void { :: src/migrate.ts -->
6. **Type narrowing / default changes** — an exported function that used to accept a wider input now rejecting part of it, or a changed default, can break callers.

## Rules

- Only flag changes that break existing consumers; do not flag additions.
- Check for a re-export alias and the documented old-layout disposition before flagging.
- Do not treat `__`-prefixed internal doc keys as public API.
- Critical for removed/renamed exports or op kinds; high for changed signatures or wire shapes; medium for changed defaults. Cite the affected KA-*/FC-* ID where relevant.

<!--
Staleness anchors for rule 1 (the public export surface this profile restates).
`scripts/check-profile-claims.mjs` verifies each substring below is still present
verbatim in the cited file; if an export is removed or renamed, this profile fails
CI so the prose above cannot silently describe a contract that no longer exists.
-->
<!-- claim: export { applyOps, inspectOps } from "./applier.js" :: src/index.ts -->
<!-- claim: export { project } from "./project.js" :: src/index.ts -->
<!-- claim: export * from "./clock.js" :: src/index.ts -->
<!-- claim: export { mint } from "./mint.js" :: src/index.ts -->
<!-- claim: export { migrate } from "./migrate.js" :: src/index.ts -->
<!-- claim: export { assertReadableSchema, readSchemaVersion } from "./schema-version.js" :: src/index.ts -->
<!-- claim: export * from "./types.js" :: src/index.ts -->
<!-- claim: export * from "./stamps.js" :: src/index.ts -->

> Before reporting PASS for any check above, apply [vacuity.md](vacuity.md): P0 to every check, P1 to any guard this change adds, P10 to what that guard's test asserts on, P2 to any tool you ran, and P7 to any run you quote.
