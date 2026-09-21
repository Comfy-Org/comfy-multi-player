# Selector-aware catalog: review prototype, not runtime adoption

Christian approved a reviewable prototype on September 21, 2026 in the investigation thread.
The motivating consumer is [cloud PR 10081](https://github.com/Comfy-Org/cloud/pull/10081):
multiplayer 0.3.2 permits Magnific's extra values but also permits an incomplete static catalog.
Import can preserve every value while a later named write overwrites the wrong slot.

## Proposed representation

A catalog entry becomes an ordered recursive field sequence. Each field has a stable name;
a selector additionally has a map from selection strings to ordered child sequences. There
are no defaults in this representation. A consumer must not flatten only the first branch.

```text
[sharpen, smart_grain, mode, after]
                       |
                       +-- creative -> []
                       +-- faithful -> [mode.skin_detail]
                       +-- flexible -> [mode.optimized_for]

values -> read mode -> walk its branch -> resume at after -> require exact end
```

`after` is an intentional fixture extension, not an actual Magnific field. It exposes the
middle-slot corruption that a selector at the end of the real node would hide. Nested
selectors recurse before resuming their enclosing sequence. Unknown selections and leftover
or missing values are errors. This detects arity mismatch, not same-length catalog permutations;
canonical producer derivation and immutable catalog identity are still necessary.

## Reset intent must not depend on the receiving document

A future selector operation carries the chosen value and the complete active child values,
including nested selections. Its write targets are the selector plus the union of descendants
of every branch in the pinned catalog. Active targets receive carried values; inactive targets
receive a clear intent. A clear is a distinct tagged state, not `null`, which is a valid value.
Extra or missing carried child values must be rejected before mutation. Defaults must not be
regenerated during replay.

The existing single applier must eventually compare that operation's stamp independently at
each target, including clears. Resetting only the fields visible at receipt time is rejected:
replicas receiving a mode switch and a child edit in opposite orders could choose different
write targets. Fixed targets alone are not a convergence proof; ancestor/descendant selector
races, inactive edits, node lifetime, retries, rejection byte identity and restart need tests
against the real applier before adoption.

## Boundaries of this PR

The executable prototype lives under `test/prototypes/`, outside `src`, the package build and
the exported API. It is a codec and intent planner, not a second applier. No consumer selects
it, no Yjs schema changes, and no published operation accepts a new payload. Existing safety
assertions and product behavior remain unchanged. This is not a fix for cloud PR 10081 yet.

Follow-up integration gates, in order:

1. Review name identity across branches, JSON value validation, recursive depth limits and
   canonical hashing with the CLI producer. A field name must not ambiguously identify two
   different logical values. Do not guess names from positional overflow.
2. Extend the pinned catalog producer and compare CLI/shared-package decoding and projection
   on real object-info fixtures. Prototype fixtures alone do not prove producer parity.
3. Extend the existing shared applier with atomic selector intent validation and per-target
   stamps. Prove both arrival orders, parent/child selector races, retry and snapshot restart.
4. Bump the document schema where old readers would mis-project. Refuse unreadable alpha
   state and re-mint from source; do not add a compatibility migration.
5. Adopt through reviewed consumer PRs only after the cloud wrong-catalog tests and Magnific
   cases pass together, followed by real browser saved/reloaded-value acceptance.

These constraints preserve the existing invariants: KA-2 ordering, KA-3/FC-3 one portable
implementation, KA-4 deterministic replay, KA-11 schema refusal, KA-12/FC-10 immutable catalog
identity, and FC-8 operation-carried values. No exception or release approval is claimed.

## Verification

The first test commit uses real `mint` with a first-option flat catalog as its reference adapter.
That is evidence about the existing reader contract, not a test of the CLI producer itself.
The implementation commit will replace the adapter without changing the decoder assertions.
All execution is hosted while the desktop resource hold remains active. CI receipts belong in
the PR body; an intentionally failing draft is not a merge-ready result.

## Glossary

- **Catalog:** metadata mapping stable widget names to serialized positions.
- **Selector:** a field whose value determines which nested fields are serialized.
- **Codec:** converts positional values to named values and back.
- **Reset intent:** carried writes and clears for one future semantic operation.
- **Stamp:** creator-carried ordering key used by the existing conflict resolver.
- **KA / FC:** keep-alive and foreclose invariant identifiers in `INVARIANTS.md`.
- **CLI:** command-line tool that produces the shared catalog.
