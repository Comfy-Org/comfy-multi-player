# ADR-022: Atomic workflow-template insertion

- **Status:** Accepted
- **Date:** 2026-09-11
- **Decider:** Christian
- **Source:** ADR-T8, in-app-agent program TDD (Notion)

## Context

Agents and users need to insert a complete workflow template, including subgraph definitions,
without decomposing it into independently observable graph edits. Existing op shapes deliberately
reject definition-bearing payloads and cannot express that transaction safely.

## Decision

Add the non-batchable `insert_workflow` op. Its frozen envelope carries one authoritative `workflow`
with top-level nodes, links, and optional `definitions.subgraphs`. The minter allocates collision-free
top-level ids with `remapWorkflowIds`; the applier validates them and rejects collisions as
`node_id_collision` or `link_id_collision`.

An identical colliding definition is skipped. A different definition with the same id is forked to
`<id>-<hash8>`, where `hash8` is the first eight hexadecimal characters of the SHA-256 digest of its
canonical projected content. Inserted instances are retargeted to the fork; existing instances are
unchanged. The operation is one Yjs transaction, stamped as its own register, and exact replay is a
byte-identical no-op through the existing `op_id` gate.

## Consequences

- Template insertion is atomic at the semantic-op boundary and deterministic on replay.
- Producers, not the applier, remain responsible for top-level id allocation.
- Definition interiors retain their independent id namespace.
- Existing op schemas remain closed to definitions.

## Invariants

This decision touches KA-1, KA-2, KA-3, KA-4, KA-5, FC-1, FC-3, and FC-4.

## Glossary

- **ADR-T8:** the accepted in-app-agent program technical design for workflow insertion.
- **Canonical projection:** stable, key-sorted JSON used as the definition-content identity.
- **Fork:** a deterministic new definition id created when equal ids have different content.
- **Minter:** the cloud or CLI producer that allocates ids before dispatch.
