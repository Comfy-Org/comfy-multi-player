# ADR-0005: Lamport ordering on a clean V1 lineage

Status: accepted for the V1 migration branch; the scalar-v1 surface remains frozen.

## Decision

Native Lamport ops carry `ordering: { kind: "lamport", counter }` and omit
`base_version` and `stamp`. Their total winner key is `[counter, actor, op_id]`.
`counter` is a positive safe integer; zero is bootstrap-only and overflow is a
hard refusal. The existing code-point tuple comparator remains the single
comparator implementation.

```text
[durable producer clock] -- native semantic op --> [applyLamportOps]
       max(local, observed, meta.clock_max)+1          |
       persist before dispatch                        +--> __stamps
                                                     +--> meta.clock_max
                                                     +--> host Yjs delta
                                                            |
                                             state-vector replay to follower
```

Lamport order composes with ADR-0004: DQ-11 chooses the incarnation-qualified
register, while this decision chooses the winner within it. A new lineage uses
schema 3, `ordering_version=2`, `clock_kind=lamport`, and `clock_max=0`.
Legacy stamp ledgers are not converted in place. A migration projects the old
lineage, emits `doc_reset`, mints a clean lineage, and retains the old history
for audit. Ordinary reconnect and sequence gaps remain same-document
state-vector replay under ADR-0003; they never perform this lineage cut.

`applyOps` remains the frozen scalar-v1 entrypoint. `applyLamportOps` rejects a
non-Lamport document, missing/wrong ordering, or either legacy field with
`unsupported_ordering_version`. One incompatible op aborts the remainder after
the valid prefix. Structurally valid admitted no-ops and LWW drops advance
`meta.clock_max`; rejected envelopes do not.

## Alternatives and tradeoffs

- Keep scalar `base_version`: least migration work, but retains a server-shaped
  ordering ceiling and cannot represent producer observation.
- Hybrid logical clock: adds wall-clock diagnostics but does not identify
  concurrency and adds clock-skew policy.
- Dotted/version vector: represents concurrency, but carries materially larger
  state and comparison complexity than V1 requires.

Lamport was selected as the smallest creator-owned logical clock that preserves
offline evaluation and deterministic total order. It does not claim to detect
concurrency; a later need for that property requires a separately versioned
dotted/version-vector migration.

## Invariants

This decision preserves KA-1 through KA-12 and FC-1 through FC-10 in
[`docs/INVARIANTS.md`](../INVARIANTS.md). In particular: semantic ops remain the
replication unit (KA-1), ordering and immutable identity ride in the op (KA-2),
the package remains Yjs-only and portable (KA-3), DQ-11 incarnation namespaces
remain intact (KA-4), followers remain receive-only (KA-6), and reconnect uses
state-vector delta replay rather than replacement (KA-10 and ADR-0003).

## Glossary

- **DQ-10**: the decision to use a Lamport logical clock for V1 ordering.
- **DQ-11**: incarnation-qualified stamp targets preventing old node lives from
  competing with replacement lives.
- **Lamport counter**: a durable producer counter advanced above every observed
  event.
- **Lineage**: one document history; only explicit `doc_reset` starts another.
- **LWW**: last-writer-wins register using the total Lamport key.
- **State vector**: Yjs summary used to request missing same-lineage structs.
