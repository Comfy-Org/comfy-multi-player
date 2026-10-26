# ADR-039: Hidden DynamicGroup rows are retained, not deleted

- **Status:** Accepted. No document delete operation will be added for widget registers.
- **Date:** 2026-10-23
- **Decider:** in-app Agent program, `operator:delivery`, row `dgarch-4`
- **Supersedes nothing. Constrains:** this package's op vocabulary, and the
  `ComfyUI_frontend` readers enumerated below.

## Context

A DynamicGroup row count is one register; each row field is its own
name-keyed register (`<controller>.<index>.<field>`). Lowering the count
changes projection only, so the vacated rows' fields keep their registers.
[#276](https://github.com/Comfy-Org/comfy-multi-player/pull/276) does this
deliberately: a receiver-side write to clear them would have an outcome that
depends on what that receiver has observed. A receiver that sees the count
change before a concurrent field write derives a different clear op-set from
one that sees the field write first. The clear is therefore new producer intent,
not a deterministic interpretation of the count operation.

Two frontend bug reports asked for the opposite. `ComfyUI_frontend` #21092
states the expectation "after a row removal, the document holds no keys for
indexes at or above the new row count", and #21091 reports that the defaults
the frontend announces for a regrown row can overwrite a peer's concurrent
edit at the same index. Neither is expressible with existing ops: `set_widget`
with `null` stores a null *value*, and only `set_node_field` treats `null` as a
key delete.

So the choice was: retain hidden keys and correct every reader, or add a
delete operation to the document contract.

## Decision

**Retain hidden keys. Do not add a widget delete operation.** Shrinking a
DynamicGroup is a visibility change, not a data deletion. Absence of a register
means "show the template default", resolved at read time by `groupLayout`, with
no writer involved.

Three consequences are part of the decision, not implementation detail:

1. **#21092's stated expectation is rejected.** The document legitimately holds
   keys for indexes at or above the current row count. A reader that treats a
   key's presence as proof the row exists is the defect.
2. **A count-only regrow is a restore; an explicit local add is a creation.** A
   remote, load, undo or redo count change restores the retained register where
   one exists and the template default where none does. A user's local **Add**
   action creates a default-valued row and announces those defaults as ordinary
   `set_widget` intent. This distinction is carried by the producer provenance,
   not inferred by a receiver from the count.
3. **The row-change contract needs no structural operation.** Whole-group
   replacement — the producer writes the count and every visible row field in
   one batch — is sufficient *because* keys are retained: it makes every
   visible row's register authoritative and leaves hidden rows intact for
   regrow.

### Why not a delete operation

A delete op can be made to converge: remove the key from `widgets`, keep its
stamp in `__stamps` so a later-arriving lower-stamped write cannot resurrect
the value. `set_node_field`'s `null` clear (ADR-032) is the in-repo precedent.
It is rejected anyway, on four grounds.

- **Its intent is inferred, not received.** No user or producer ever expresses
  "delete this field". The producer observes that a count went down and derives
  a deletion from it. That is re-deriving intent from an end state, which the
  in-app Agent program's invariant list forecloses by name (its FORECLOSE entry
  13; this package's register stops at FC-10 and has no equivalent id, FC-8
  being the narrower replay case). The count already carries the real intent
  losslessly, so nothing has to be inferred.
- **It makes two orthogonal intents contend.** Today a peer hiding row 2 and a
  peer editing `loras.2.strength` write different registers, so both survive
  and regrow shows the edit. With a delete they share one register, and which
  user's intent survives is decided by whichever Lamport stamp happened to be
  higher. Convergent, and still data loss chosen by a timestamp race.
  #276's `keeps named values coherent when a row edit races with hiding that
  row` is the test that would have to be inverted to assert this.
- **It makes shrink/regrow lossy**, contradicting the dynamic-combo precedent
  (`dynamic-combo-read-time-defaults`) and what a user who shrinks a group and
  grows it back expects.
- **It does not pay for itself.** Of the eleven frontend readers enumerated
  below, three need a change under retention. A delete op dissolves those three
  and adds a new op kind, a mixed-version admission question against released
  reader 0.3.10, and tombstone-stamp semantics — for a problem whose measured
  symptoms are diagnostic noise and one row-ceiling comment.

`SCHEMA_VERSION` stays 5: nothing about the document layout changes, because
nothing changes.

### What retention requires of `ComfyUI_frontend`

Retained keys reach the frontend through three doors. The set is bounded and
closed; this is the enumeration that made retention viable. Measured at
`ComfyUI_frontend` `479cecf9ac`.

| Reader | Door | Verdict |
|---|---|---|
| `changed()` — `liveGraphApplier.ts:1551` | raw doc map | **Must change.** It widens a partial frame only for overflow aliases, not for a changed controller's row fields, so a count-only frame regrows rows at template defaults and never applies the retained registers. |
| `reportMissingWidgets()` — `liveGraphApplier.ts:1176` via `syncWidgets` | raw doc map | **Must change.** A hidden-row key resolves to no widget and emits `agent_graph_widget_missing` on every full or catch-up frame after a shrink. These are false positives in a signal N1 alert thresholds are being built on. |
| `announceAddedValues()` — `dynamicGroupWidget.ts:366`, `announceValue()` — `widgetValueStore.ts:358` | producer | **Keep.** A local Add is received intent to create a default-valued row. Removing the announce reintroduces #20914: remove-last/add resurrects the removed values, remove-middle/add can produce `[A, C, C]`, and bound and unbound workflows give different results. #21091's same-index add-versus-edit race is accepted as a V1 positional-model residual. The shift announce from #21057 also stays because a shift is a real content change. |
| `getRestoredWidgetValueCount()` — `widgetValueStore.ts:168` | `widgets_values_named` | **Audit.** Counts leftover keys, inflating `validateSavedRowCount`'s ceiling. Low severity, same family as the row ceiling below. |
| `nodeHistoryWidgetValues.ts:86` | `widgets_values_named` | **Cosmetic.** Hidden-row keys surface in node history and diffs. |
| `documentedRowCount()` — `liveGraphApplier.ts:509` | raw doc map | Correct as written. It counts documented rows, which under retention are exactly the rows a regrow may legitimately restore (#21264's intent). Wants a comment naming the model, not a behaviour change. |
| `mountedWidgetValues()` — `liveGraphApplier.ts:549` | raw doc map | Correct as written: creation passes `reportMissing: false`, so leftovers are dropped silently. |
| `positionalWidgetValues()` — `liveGraphApplier.ts:570` | raw doc map | Safe by construction — iterates live widgets, not document keys. |
| `LGraphNode.configure` named restore — `LGraphNode.ts:280` | `widgets_values_named` | Safe by construction — indexes by live widget name. |
| `SubgraphNode.ts:497` promoted named restore | `widgets_values_named` | Safe, same shape. |
| `templateInputService.ts:39` | `widgets_values_named` | Safe, indexes by widget name. |

**The second door is not obvious and was nearly missed.** Hidden-row keys are
absent from `widgets_values` but **present in `widgets_values_named`**, because
A23 keeps that passthrough register coherent on every `set_widget` and it is
not derived from the group layout. Measured on #276 at `8283096`: after
shrinking the populated fixture from 2 rows to 1, `widgets_values` is
`["head",1,"A.safetensors",1,true,"tail"]` while `widgets_values_named` still
carries `loras.1.lora_name`, `loras.1.strength` and `loras.1.enabled`. So
"readers that bypass `project()`" is not the boundary; readers of the named
projection see them too.

## Consequences

- A count-only shrink then regrow restores the user's values, on the canvas and
  in the document, without a receiver-side write. A local Add after a shrink
  creates a default-valued row instead.
- #21092 closes as not-a-bug on its stated expectation, with the row-ceiling
  comment and the diagnostic classification as the real follow-ups.
- #21091 remains a stated V1 conflict-policy residual. Two peers adding the
  same positional index while one edits a field can lose one intent under LWW,
  but every replica converges. Solving that conflict without regressing #20914
  requires stable row identity or an equivalent creation token, not
  write-if-absent: a retained leftover and a newer peer edit are
  indistinguishable at the write site.
- The row-change contract may rely on whole-group replacement. No row-level
  structural operation is required by deletion semantics.
- One package test remains as a follow-up after #276 merged: see below.

## Tests and evidence

Four cases gate this ruling. Three exist and pass at #276 head `8283096`
(`npx vitest run test/dynamic-group.test.ts`, 61 passed):

1. **shrink/regrow** — `keeps hidden row values when the count changes`.
2. **out-of-order arrival** — `converges when the row count and a row value
   arrive in either order`, both orders from one seeded snapshot.
3. **defaults versus peer edit** — `keeps named values coherent when a row edit
   races with hiding that row`, both orders.
4. **retry follow-up** — asserted for row-field and trailing edits by `edits %s
   without shifting its siblings`, but **not for the count op itself**. #276
   merged before this assertion landed. The behaviour is correct (measured: a
   replayed count op reports `no-op` and leaves `encodeStateAsUpdate`
   byte-identical); a follow-up must add this to `test/dynamic-group.test.ts`:

```ts
it("replays a row count op as a byte-identical no-op", () => {
  const doc = mint(cases.populated, catalog);
  const shrink = edit("loras", 0);
  expect(applyOps(doc, [shrink], catalog).outcomes[0]?.outcome).toBe("applied");
  const grow = edit("loras", 2, 2);
  expect(applyOps(doc, [grow], catalog).outcomes[0]?.outcome).toBe("applied");
  const projected = project(doc, catalog).nodes[0]!.widgets_values;
  for (const op of [shrink, grow]) {
    const before = Y.encodeStateAsUpdate(doc);
    expect(applyOps(doc, [op], catalog).outcomes[0]?.outcome).toBe("no-op");
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  }
  expect(project(doc, catalog).nodes[0]!.widgets_values).toEqual(projected);
  doc.destroy();
});
```

The user-visible creation semantics are held in the frontend by #20992's
remove-then-add regression: a local Add writes template defaults, while remote,
load and unbound creation mint no extra operation. #21091's race lives in that
producer and is deliberately not claimed as solved here.

## Glossary

- **CRDT:** conflict-free replicated data type; the shared Yjs document here.
- **LWW:** last-writer-wins ordering by the operation's immutable stamp.
- **Hidden row:** a row whose index is at or above the current count, whose
  field registers remain in the document and are absent from the projection.
- **KA-2, KA-4:** the ordering-key-rides-inside-the-op and
  deterministic-idempotent-applier invariants in `docs/INVARIANTS.md`.
- **Never re-derive intent from end states:** the in-app Agent program's
  FORECLOSE entry 13. Not registered here; this package's foreclose ids end at
  FC-10.
