# ADR-033: numeric, document-state-verified link ids for `insert_workflow`

- **Status:** Accepted
- **Date:** 2026-09-22
- **Decider:** Christian Byrne
- **Source:** ComfyUI_frontend#18458 (interim 32-bit-hash review) and the Slack thread it was raised in

## Context

ADR-031 remaps every id `insert_workflow` carries — node, link, group, and
nested-definition id — to a deterministic **string** derived from the op
envelope id, graph scope, id kind, and original id
(`insert:<opId>:<scope>:link:<original>`). That is a correct fit for a
`NodeId` (`string | number` on the frontend) but not for a `LinkId`, which
ComfyUI_frontend brands as `number & { __brand: 'LinkId' }`. The frontend's
interim fix (`ecsFollowerAdapter.ts`'s `resolveLinkId`) hashed the derived
string into a number with FNV-1a folded into a 32-bit space. Two independent
reviewers (Christian Byrne, dante01yoon) found this genuinely broken, not
merely approximate:

- The 32-bit hash space is small enough that two distinct derived ids collide
  at a measured, reproducible rate (~0.01% at 1k live derived links, ~1% at
  10k, birthday-bound), silently replacing one link with another with no
  error reported — indistinguishable from the original "links silently
  dropped" bug this was fixing.
- The resolved numeric id is what `graph.serialize()` writes to the saved
  workflow file. A reserved id range chosen to sit above any real
  `last_link_id` does not survive a save/reload: the persisted file now
  contains a genuine numeric link id inside that "reserved" range, and
  nothing bounds real link ids below it, so a LATER `insert_workflow` can
  collide with a real, previously-synthetic-now-real id. A session-local
  allocator has the same reload hole from the opposite direction: a fresh
  session's reservation map is empty and does not know the reloaded id is
  taken.

Both reviewers converged on the same root fix: mint the numeric identity
where the link is minted (this package), not on every frontend peer that
happens to read it.

## Decision

`remap.ts`'s `derivedLinkId` mints a real JS `number` for every link id
`insert_workflow` derives — at the top-level graph scope AND at every
subgraph-definition interior scope, so the fix does not regress
comfy-multi-player#230's `remapLinkIdArray`/definition-interior handling.
Every other kind `insert_workflow` derives (node, group, definition) is
UNCHANGED: still the ADR-031 string, still a pure function of
(`opId`, `scope`, `kind`, `original`) with no document-state dependency.

The link-id mint is NOT a wider hash gambled to be "unlikely enough" — the
same failure mode being fixed. It is:

1. **Hashed**: SHA-256 of the same `insert:<opId>:<scope>:link:<original>`
   seed ADR-031 already uses, keeping 52 bits (well inside
   `Number.MAX_SAFE_INTEGER`) as the first candidate.
2. **Verified against every id the caller can see**, not assumed collision-free
   by width alone: the caller (`applier.ts`) passes `derivedLinkId` (via
   `remapInsertedWorkflowIds`'s `reservedLinkIds` parameter) every numeric
   link id already persisted in the target document — top-level AND every
   subgraph definition's interior links, at every nesting depth
   (`doc.ts`'s `persistedLinkIds`) — plus every id `derivedLinkId` has already
   minted earlier in the SAME `insert_workflow` call, so two links in one
   insertion can never collide with each other either.
3. **Retried, bounded**: on a collision the mint deterministically tries the
   next candidate (re-hashing with an incremented attempt counter) up to
   `MAX_LINK_ID_MINT_ATTEMPTS` (256) times. Any realistic document — even one
   with millions of live links — succeeds on the first or second attempt;
   the bound exists so a pathological/adversarial reservation set fails
   loudly (`link_id_collision`, byte-identical, `op_id` not consumed) in
   bounded work rather than looping.

This directly fixes the reviewers' reproduction: two independent
`insert_workflow` ops (distinct `op_id`s) inserting links that would
otherwise hash to the same value now resolve to distinct ids, because the
second op's mint sees the first op's already-committed numeric id in
`persistedLinkIds` and retries past it — the exact cross-op collision the
32-bit interim hash reproduced.

## Deviation from KA-5 / ADR-031

Every other id `insert_workflow` derives is intentionally **pure**: a
function of the op's own fields alone, with producers/the applier never
inspecting document state to decide an id (KA-5's "IDs are collision-free
without coordination" and ADR-031's "Producers do not inspect document
state or remap ids"). `derivedLinkId` breaks that purity for links, and only
for links: a truly information-theoretic collision-free encoding of an
unbounded set of possible (`opId`, link) pairs into a fixed 53-bit numeric
space is impossible by construction (pigeonhole), unlike the string form,
whose output space is unbounded and therefore never needs to consult
anything besides the op itself. Squeezing that identity into a small,
externally-imposed numeric type (`LinkId`) is only possible by ALSO checking
it against real state — so this package does, rather than pretending a wide
hash is "collision-free" the way the interim frontend fix did. This is
logged as a deliberate exception in `docs/decisions/EXCEPTIONS.md` (KA-5 row),
with the residual gap named explicitly: two REPLICAS that have never
exchanged this op and each independently mint a colliding candidate from
their own (different) locally-visible document state could in principle
diverge — bounded by the same ~2^-52-per-pair probability that makes a UUID4
`op_id` collision (already a foundational assumption throughout this
package, KA-2) an accepted risk elsewhere in this same system.

## Consequences

- ComfyUI_frontend can delete its `resolveLinkId`/`fnv1a` hashing entirely
  (tracked in ComfyUI_frontend#18458) and read `LinkId` straight off the doc.
- `link_id_collision`'s existing insert-time collision check
  (`applier.ts`'s `acceptsLink`) is no longer reachable via any
  realistically-shaped input for LINKS specifically, because the mint now
  actively avoids everything that check would have caught. It remains
  reachable, and is retained, via the id-space-exhaustion path above; the
  test suite covers exhaustion directly rather than asserting an
  unreachable natural collision.
- `updateInsertedWorkflowMeta`'s `last_link_id` high-water-mark bookkeeping
  deliberately does NOT fold in these new large numeric ids (see the comment
  at its call site) — they are not meant to look like the next sequential
  id, and KA-5 already treats this field as advisory only.
- `SCHEMA_VERSION` is unchanged: no document root or reserved key changes,
  only the VALUES `insert_workflow` was already free to choose for a link id.

## Glossary

- **Derived id:** ADR-031's deterministic string, `insert:<opId>:<scope>:<kind>:<original>`.
- **Candidate:** one hashed, not-yet-verified numeric value `derivedLinkId` tries during a mint.
- **Reservation set:** the ids a mint call must not choose — persisted document ids plus ids already minted in the same call.
