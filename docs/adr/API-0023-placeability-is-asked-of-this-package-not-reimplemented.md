# ADR-API-0023: Placeability is a question asked of this package, not a rule consumers reimplement

Date: 2026-11-20

Relation: Refines ADR-API-0005. That record's rule — the public entrypoint hands
back no live Y handle and no mutation path — remains true and is unchanged by
this ADR. This record addresses a case it does not cover: a read-only *question*
that a consumer must answer identically to this package, and that the closed
barrel left them no way to ask.

## Status

Accepted

## Context

`src/index.ts` is a curated barrel, narrowed by
[#18](https://github.com/Comfy-Org/comfy-multi-player/issues/18) after it
wildcard-exported `src/doc.ts` and handed consumers `mset`/`mdel`/`apush`, the
root maps and the mutation counter. Narrowing it was right: a consumer that can
write the document directly bypasses stamp gating (KA-2), idempotency and
convergence (KA-4) and the catalog check at mint (KA-12).

The narrowing was applied to one thing it should not have been: the predicates
that answer **whether a stored widget name can be placed at all.** Those are not
mutation paths and not layout access. They are pure questions about a name and a
pinned catalog entry, and there is a consumer that cannot do its job without
them.

That consumer is the doc host's catalog-pin guard
(`cloud/services/agent/dochost/src/catalogpins.ts`). It refuses a document whose
stored widgets its catalog cannot place, because projecting such a document
would decompose values at the wrong positions. To do that it must agree with
this package about what "can be placed" means. With nothing to import, it
hand-copied the rule. Five copies, each added after the previous one proved
insufficient *in production*:

| Date | Release | Copied from | User-visible result |
| --- | --- | --- | --- |
| 2026-10-08 | v0.448.0 | `optionOwnedWidgets` | every workflow with a dynamic-combo selection refused on every turn |
| 2026-10-12 | — | `overflowWidgetName` naming | ByteDanceSeedreamNodeV3 refused |
| 2026-10-15 | — | same | TopazImageEnhanceV2 refused |
| 2026-11-18 | v0.557.0 | `isDynamicGroupField` | 279 refused turns over 6 workflows; multi-row LoRA stacks locked out |
| ongoing | — | `widgetStorageKey` | occurrence registers unreadable if the spelling moves |

The 2026-11-18 case is the clearest statement of the cost. v0.557.0 was the
first production release carrying this package at 0.3.13, where a
`COMFY_DYNAMICGROUP_V3` input lays out its rows from `dynamic_groups`. A
three-row `LoadLoraModel` therefore stores `loras.1.*` and `loras.2.*`. The
guard's copy of the rule predated that, so it refused a document **this package
had just minted**, with `catalog_mismatch`, before any tool ran — and the
documented self-recovery path, a client-canvas reseed, mints the same names and
was refused the same way. The class had no automatic recovery; the workflow was
simply unusable with the agent until a human widened the copy.

Two properties make this a structural defect rather than a sequence of
oversights. First, every copy was **correct when written**: the drift is created
by a later release of this package, so no amount of care at copy time prevents
it. Second, the copies fail in both directions — the `_extra_<n>` regex copy
fails **open** on a rename here (the guard stops recognising overflow slots),
while the occurrence-prefix copy fails **closed**. A guard that silently changes
polarity when an unrelated package renames a constant is not a guard.

AGENTS.md states the rule this violates in one sentence: *"There is no second
applier implementation."* Withholding the predicates did not prevent a second
interpretation of the placement rule. It **caused** one, in the single consumer
least able to tolerate disagreement.

## Decision

Publish the questions, keep withholding the machinery.

1. **`catalogPlacesDynamicName(entry, name, occurrence)`** is exported from the
   package root. It is the catalog-only half of the applier's own name check:
   occurrence 0, and either a dynamic-combo option owns the name at any
   selection and any depth, or a dynamic group generates it as a row field.
2. **The applier calls it.** `validateWidgetName` in `src/applier.ts` no longer
   spells that condition inline; it invokes the exported function. This is the
   load-bearing half of the decision. An export that merely *resembles* the
   applier's rule would be a sixth copy with better distribution; one the
   applier itself depends on cannot diverge from the applier without reddening
   the applier's own suite.
3. **The stored-name spellings are exported too:** `overflowWidgetName` /
   `parseOverflowWidgetName` and `widgetStorageKey` /
   `widgetIdentityFromStorageKey`. A consumer cannot parse a stored key without
   them, so withholding them guarantees a copy rather than preventing one.
4. **Agreement is tested against the applier, not asserted.**
   `test/widget-placement-export.test.ts` drives real `set_widget` ops through
   `applyOps` and requires the predicate's verdict to equal the applier's, name
   by name, with the rows whose acceptance depends on the predicate alone
   labelled as such. Dropping either arm of the predicate reddens three tests in
   that file.
5. **Widening stays a reviewable diff.** The new names are classified in
   `test/readonly-surface.test.ts` and, for the two from `src/doc.ts`, in
   `test/public-api.regression.test.ts`'s sanctioned list. Both guards continue
   to fail on an unclassified export, which is how this change was forced to
   declare itself.

The predicate is deliberately **value-blind**: it answers what the pinned
catalog *can* place, not what the node's current selection or row count *does*
place. Accepting only the current selection's names would make the outcome
depend on whether the selector write arrived first (KA-2). A caller that wants
the realized layout wants `widgetOrderForValues` or `widgetLayoutForWidgets`,
which stay module-private.

It is also **fail-closed**: an absent entry, or a value-blind entry carrying
neither `dynamic_combos` nor `dynamic_groups`, places nothing. A stale request
catalog therefore still refuses the names it cannot describe, rather than
projecting them through an order that would drop them.

## Alternatives considered

**Keep hand-mirroring in the doc host, and add a conformance test there.** This
is the status quo plus a test, and it is what the 2026-11-19 fix
([cloud#19769](https://github.com/Comfy-Org/cloud/pull/19769)) did for the
dynamic-group arm specifically. It is strictly better than nothing and it did
stop the bleeding. It does not address the class: the test can only pin the
behaviours known when it was written, and the next widening in this package
reaches production before anyone writes the next test. Four lockouts is the
measured evidence that reactive mirroring does not converge.

**Export the three underlying helpers (`optionOwnedWidgets`,
`isDynamicGroupField`, `widgetOrderForValues`) and let the consumer compose
them.** Rejected. Composition is where the rule lives, and the consumer would
still be guessing at it — the `occurrence === 0` clause and the shared
allocation bound are not obvious from the parts. Exporting a question rather
than its ingredients is what keeps the second interpretation from reappearing.

**Make the doc host call `applyOps` to decide placeability.** Rejected as a
category error: the guard runs *before* apply, on stored state, to decide
whether the document can be read at all. Using the mutation path as an oracle
for a read-time question would require a throwaway document per check and would
couple refusal semantics to apply semantics.

**Publish a second, explicitly-internal entrypoint (`./internal`).** Rejected as
more surface for the same outcome. These five names are a stable, small,
read-only contract that a host needs permanently, not an escape hatch; a
subpath export would invite the raw layout helpers back in behind it.

## What we reject

- **Re-exporting `src/doc.ts` wholesale, or any Y.Doc layout or mutation
  helper.** Issue #18's conclusion stands. The two names taken from `doc.ts`
  here are pure string functions that touch no Y type.
- **A consumer-side copy of any rule this package owns**, now that there is
  something to import. A new hand copy of placement or name-identity logic in
  the doc host, the frontend or comfy-cli is a defect, not a local decision —
  including a copy written because the package's pinned version is older than
  the export. Bump the pin.
- **An exported predicate the applier does not itself call.** Decision 2 is not
  stylistic. An export that duplicates the applier's condition reintroduces the
  exact failure mode with wider blast radius.
- **Widening this predicate to consult document state.** It takes a catalog
  entry and a name. Giving it a node, a selection or a row count would make
  refusals arrival-order-dependent (KA-2) and would make the guard's answer
  depend on the document it is deciding whether to trust (KA-12).
- **Reading an unclassified export as approved.** If a future change adds a name
  to the barrel, the surface tests must be updated in the same diff, with the
  reason, as this one was.

## Consequences

**Positive.** The lockout class has one definition instead of two. A future
widening of what the applier places propagates to the doc-host guard by a pin
bump rather than by a production incident and a hand-edited copy. The guard
loses roughly 120 lines of mirrored rule and five constants.

**Negative.** The public surface grows by five names, each of which must now be
maintained as API. `catalogPlacesDynamicName` is the narrowest of the five but
still exposes the existence of dynamic layout to consumers that do not need it.

**Operational and migration.** This change is purely additive to the package's
behaviour: no op semantics, no schema version, no wire layout, and no
projection change. `npm run build`, the surface guards and the full suite hold
it. The consumer-side work is a **separate, sequenced change** and is not
claimed by this ADR: the doc host must first pin a release of this package that
contains the export, and only then delete `optionOwnedNamesOf`,
`dynamicGroupRowsOf`, `isGroupRowField`, `isOptionOwned`, `OVERFLOW_WIDGET_NAME`
and `OCCURRENCE_KEY_PREFIX` in favour of imports. Until that lands, the copies
remain live and the class remains open — the export removes the *cause*, the pin
bump removes the *instances*.

**Known limit, stated rather than papered over.** `isSelectionOverflow` in the
doc-host guard mirrors the overflow-naming behaviour of
`widgetOrderForValues`, which is selection-dependent and therefore not fully
answerable by a value-blind predicate. Exporting the `_extra_<n>` spelling
closes the half that fails open; the selection-relative half still needs either
a further export shaped around the guard's actual question or a conformance
fixture. That residual is deliberately out of scope here, because a predicate
designed without the consumer's call site in front of it would be the sixth
copy.

## Revisit triggers

- A sixth hand copy of a package-owned rule appears in any consumer. That means
  the export surface is still the wrong shape and the gap it leaves should be
  named here.
- The doc-host pin bump lands and the mirrored rule is not deleted. The export
  is then dead weight and this record's premise needs re-stating.
- `isSelectionOverflow`'s residual causes a production refusal. That converts the
  known limit above into the next unit of work.
- A consumer asks for the realized layout rather than the pinned catalog's
  capability. That is a different question than this one and needs its own
  decision, not a widened `catalogPlacesDynamicName`.
