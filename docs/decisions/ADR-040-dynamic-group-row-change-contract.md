# ADR-040: DynamicGroup row changes are whole-group replacement, not row operations

- **Status:** Accepted for V1. No structural row operation is added to this package.
- **Date:** 2026-10-23
- **Decider:** in-app Agent program, `operator:delivery`, row `dgarch-2`
- **Depends on:** [ADR-039](ADR-039-hidden-dynamic-group-rows-are-retained-not-deleted.md)
  (hidden rows are retained, not deleted). Replacement is only convergent because of it.
- **Constrains:** this package's op vocabulary; comfy-cli's `docs/op-vocabulary-v1.md`
  batch-spec surface; cloud's `applyOpKinds` allowlist.

## Context

A DynamicGroup's row count is one register and each row field is its own name-keyed
register, `<controller>.<index>.<field>`.
[#276](https://github.com/Comfy-Org/comfy-multi-player/pull/276) makes a count change a
projection change only: no reindexing, no link or promotion rewrite, hidden registers
retained. Its `docs/dynamic-groups.md` already asserts the conclusion this ADR ratifies —
"Agent row changes use whole-group replacement instead ... so this package needs no
structural operation" — but that sentence is an unreviewed assertion inside an unmerged
PR, which is exactly the "a decision that lives only in a doc is lost" case.

Two shapes were built against that gap, and the second was never chosen between:

- **Whole-group replacement**, [comfy-cli #1004](https://github.com/Comfy-Org/comfy-cli/pull/1004).
  The producer sends the desired row list; the CLI expands it into existing `set_widget`
  ops — the count, then every field of every written row. No new op kind, no schema
  change, nothing for this package or the doc host to learn.
- **Row identity plus atomic row operations**,
  [#281](https://github.com/Comfy-Org/comfy-multi-player/pull/281) (`properties.dynamicGroupRows`,
  schema v6) and [#282](https://github.com/Comfy-Org/comfy-multi-player/pull/282) (five
  operations, permanent row tombstones, schema v7). Both are complete, tested drafts.
  Their author closed them on 2026-10-18, with
  [cloud #13279](https://github.com/Comfy-Org/cloud/pull/13279), pending this ruling.

The question is not which is better engineering. #282 is strictly the stronger document
model. The question is whether any invariant this program holds *requires* it, because
adopting it costs two schema bumps, refusal and re-mint of every existing document, and
coordinated adoption across this package, the doc host, cloud, the CLI and the frontend —
against a production chain still pinned at doc host `0.3.10`, where Agent DynamicGroup
writes can still bind to the wrong position and #276 alone fixes that.

## Decision

**Accept whole-group replacement as the V1 row-change contract. Add no structural row
operation.** #281, #282 and cloud #13279 stay closed. The producer owns row changes; this
package stays at `SCHEMA_VERSION` 5 and keeps its existing op vocabulary.

The contract, stated normatively so a later contributor cannot add a second row path by
accident:

1. A row change is expressed as **the complete desired list of rows for one group on one
   node**, expanded at the command site into the count register and every field register
   of every written row. There is no row insert, delete, move or identity.
2. **A row's identity is its index.** Nothing in the document carries a durable row
   identity, and no reader may assume one.
3. **Rows a link or a promotion binds to are not moved.** The producer refuses a
   replacement that would require moving one, naming the disconnect or unpromote needed.
   This is the only reason replacement is safe against topology: it never rewires, it
   declines.
4. **Row-field writes are order-independent of the count write.** Confirmed in source:
   `dynamic-groups.ts` `isGroupField` admits any index below
   `MAX_OVERFLOW_WIDGETS / fields.length`, the allocation bound, not the current count. A
   field write that arrives before the count that reveals it is stored hidden and becomes
   visible when the count lands. KA-4 holds for the emitted batch in any arrival order.

### The five acceptance tests, each with a verdict

**Concurrent edits — two actors changing different rows.** Two replacements at equal
Lamport counters tie on the counter, so the actor comparison decides *every* contended
register the same way: one actor's complete list survives intact and the other's is lost
whole. With ADR-039 retaining the loser's hidden registers, the projection is exactly one
of the two intended lists. Convergent, order-independent, and a clean lost update rather
than a corrupt one. **Accepted.**

The unclean case is a replacement racing a *scalar* `set_widget` on one row field, which
is what the frontend UI emits for a human edit. The two claim registers at different
granularity, so the scalar can win its one field while the replacement wins the rest,
leaving a row holding a new `lora_name` with a peer's `strength`. If the replacement also
changed what that index means, the peer's edit lands on a different LoRA. There is no
mitigation at the op layer without row identity; raising the producer's counter cannot
help, because a counter is not orderable against an op the producer has not seen.
**Accepted as a stated residual, not solved** — see Consequences.

**Idempotent retry.** Replay of the emitted ops is a true no-op by KA-4, byte-identical,
and #1004's tests replay every emitted batch to the same canonical workflow. Re-minting
the *spec* at an unchanged `base_version` is refused by #1004's claimed-register guard
rather than resolved by a coin flip, so the failure mode is fail-closed with an
instruction to re-read. **Accepted.**

**Stable identity.** There is none, and the contract says so rather than implying one.
The only identities external readers hold durably — a link's input slot and a promotion's
proxy — are protected by refusal (rule 3), not by rewriting. **Accepted as an explicit
non-property.**

**Hidden rows.** Governed by ADR-039: a shrink retains the vacated rows' registers and a
regrow surfaces them rather than template defaults. Replacement does not read hidden
state and must not clear it — clearing would claim registers the producer does not own
and would destroy a peer's concurrent edit at that index, which is the same objection
ADR-039 raises against a delete op. The consequence is real and new: before #1004 the
Agent could not shrink a group, so an Agent shrink followed by a human regrow is a path
that now surfaces the Agent's discarded rows. That is #21092's defect, and ADR-039's
three enumerated frontend reader fixes are its remedy. **Accepted, gated on ADR-039's
reader fixes.**

**Partial failure.** The doc host applies each op in its own transaction, so a batch is
one frame and one undo unit but is **not atomic in the document**. A rejection after the
count leaves a group whose written rows are new and whose unwritten rows show their
previous occupants — plausible-looking and wrong, with no rollback. The producer
validates on a copy first, so the only expected causes are a concurrent change or a
version mismatch. **Accepted as the single strongest argument for #282, and the named
revisit trigger below.**

### The invariant that would force row operations, so the revisit is testable

Row-level operations become *required*, not merely better, if this product ever asserts:

> A per-field edit authored against a row must apply to that row, or not at all, even
> when a concurrent structural change has moved it.

Nothing in `CLAUDE.md`'s KEEP-ALIVE list, this package's INVARIANTS, or any shipped
product requirement asserts it today. Replacement cannot satisfy it — index-addressed
registers have no way to express it — so the day it is asserted, #281/#282 are reopened
rather than patched around. Writing it down is the point: it is the difference between a
bounded V1 and a permanent one.

## Conditions on this acceptance

1. **The "ops must replay in order" claim must be scoped to comfy-cli.** #1004 writes
   "the emitted ops must replay in order (count first)" into
   `docs/op-vocabulary-v1.md`, the frozen vocabulary this package pins. It is true of the
   CLI's own local workflow model, which materializes rows from the count and answers
   "widget not found" for a field above it (the mechanism in comfy-cli #1006), and it is
   false of this package, by rule 4 above. Left as written, a second receiver implementing
   the vocabulary literally would reject out-of-order arrival and diverge — a KA-4
   violation introduced by documentation.
2. **#1004's same-batch claimed-register guard is an exception with a sunset.** It exists
   only because every op in a CLI batch shares a stamp and the random `op_id` settles the
   tie (comfy-cli #1006). comfy-cli #1007 fixes that generally. The guard is retired when
   #1007 lands, or it is re-justified on its own merits.
3. **The producer's row ceiling is not this package's.** #1004 bounds rows by
   `port.options.max` falling back to a literal `20`; this package bounds counts by
   `[group.min, MAX_OVERFLOW_WIDGETS / fields.length]` and deliberately does not enforce
   the catalog `max` (the catalog controls layout, not prompt validity). Two ceilings that
   disagree is the `max`-ownership question, owned by row `dgarch-3`; this ADR does not
   rule it and does not depend on it.
4. **The read-to-write link race is stated, not silently accepted.** A link added to a row
   after the producer's read is not rechecked, so rule 3's refusal can be bypassed by
   timing and that row rewritten under its link. This package cannot see it — links and
   rows are unrelated registers here — so it belongs in the producer's user-visible
   documentation, not only in a PR body.

## Consequences

- No schema bump, no document re-mint, no new op kind, no doc-host change. The #276
  release chain — merge, publish, doc-host pin, Cloud CLI pin — is unblocked without
  waiting on a row-identity model.
- Row changes are **lost-update at group granularity** against a concurrent peer
  replacement, and can produce a **mixed row** against a concurrent scalar field write.
  Both are accepted and neither is hidden.
- A row change is **not atomic in the document**. Partial application is observable.
- Whole-group replacement is a bounded instance of the in-app Agent program's FORECLOSE
  entry 4 — it clobbers concurrent edits within its scope — but not of its other
  properties: it emits explicit per-field semantic ops, so there is no ingress blowup and
  op-log replay and observability are intact. Naming it is deliberate; the scope is one
  group on one node, and it is the reason this is V1 and not the end state.
- It does **not** re-derive intent from end states. The desired row list is received
  intent, minted where intent is known, which is why it is admissible at all. What it
  loses is finer intent: "deleted row 1" and "rewrote rows 1..n" are indistinguishable to
  a peer, which is precisely the information row operations would carry.

## Revisit if

- A peer's delayed per-field edit landing on the wrong row is observed in production, or
  the invariant quoted above is asserted as a product requirement.
- Partial application of a row batch is observed as a user-visible defect rather than a
  theoretical one.
- Concurrent DynamicGroup editing becomes a supported multiplayer scenario rather than an
  accepted race between one Agent turn and one human.

Any of these reopens #281/#282 and cloud #13279 as the V2, which is why they are closed
rather than deleted.

## Glossary

- **DynamicGroup:** a repeating row of widgets on one node (a LoRA stack's `loras`),
  whose row count is itself a widget.
- **LWW:** last-writer-wins ordering by the op's immutable stamp, `[counter, actor, op_id]`.
- **KA-4:** this package's invariant that the applier is deterministic and idempotent and
  a duplicate `op_id` is a true no-op.
- **FORECLOSE 4:** the in-app Agent program's rule against full-document replace as the
  mutation primitive. This package's register ends at FC-10 and has no equivalent id, so
  the attribution is explicit rather than a dangling citation.
