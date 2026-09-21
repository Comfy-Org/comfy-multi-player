# Changelog

All notable changes to `@comfyorg/comfy-multi-player` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this package uses semantic versioning.

## Unreleased

## 0.3.0 - 2026-09-19

### Changed

- Breaking: advances the published package from document schema 2 to schema 4.
  Durable link state lives in `__link_state`, and Lamport reservations now live
  in `__clock_reservations`, separate from the winning write-target stamps
  returned by `readStamps()`.
- Old document layouts are refused without mutation. `migrate()` validates the
  current layout; it does not upgrade or relabel schemas 1–3. Hosts must
  re-mint source workflows into a new lineage and settle or discard old pending
  queues before a coordinated consumer cutover. Publication alone does not
  authorize that cutover or establish frontend rollout sign-off.

### Added

- Added the standalone `insert_workflow` op for atomic workflow-template
  insertion. The applier derives every carried node, link, group, and
  definition ID from the operation ID and graph scope, avoiding allocation
  against mutable document state.
- Recovered standalone link, definition, scoped interior-connect, operation
  inspection, and checked public operation-type surfaces.

### Fixed

- Hardened stamp admission, opaque-widget projection, hostile snapshot keys,
  definition identities, interior link preservation, and draft-07 event-schema
  compatibility.
- Restored standalone package gates and release retry verification. Existing
  npm versions are reused only when artifact integrity and verified provenance
  match the tagged source; different bytes must use a new version.

## 0.2.0 - 2026-08-30

### Changed

- Breaking: replaced the 0.1.0 `ApplyResult` shape with ADR-007's ordered,
  discriminated per-op `outcomes` records and renamed `version` to `ops_seen`.
- Added ADR-008's caller-owned event sink contract so hosts can receive
  structured cmp events without a package-global registry or telemetry
  dependency.
- Exported the agent event schema surface from `src/index.ts`, including
  `AGENT_EVENT_JSON_SCHEMA`, `CMP_EVENT_SCHEMA_VERSION`, and event types.
- Added the ADR-011 replay-never-wipe reconnect contract to the 0.2.0 surface:
  reconnects continue from document state and state-vector delta replay instead
  of replacing follower documents during ordinary catch-up.
- Added ADR-021's `DocDerivedLamportClockStore`, deriving Lamport floors from
  the caller-owned document's committed `__stamps` ledger rather than package
  process state.

## 0.1.0 - 2026-08-13

### Added

- Initial op-based CRDT applier for Comfy workflow graph edits.
- Stamp-based conflict identity and idempotent op replay keyed by `op_id`.
- Catalog SHA binding at mint time for deterministic widget projection.
- Read-only snapshot and projection surfaces for consumers that need workflow
  JSON without direct document mutation.
