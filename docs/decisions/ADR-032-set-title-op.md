# ADR-032: `set_title` — a package-local node-rename op

- **Status:** Proposed
- **Date:** 2026-09-21
- **Decider:** Christian (requested); pending maintainer review of this PR
- **Source:** title-stomp bug class observed in ComfyUI_frontend's in-app-agent
  live-canvas sync; partially worked around client-side in ComfyUI_frontend
  PR #18075 (single-client self-stomp only, not multiplayer sync)

## Context

A node's `title` enters the Y.Doc exactly once: as a passthrough field on
`add_node`'s initial `node` snapshot (schema §1.1). No op writes it
afterward. A rename made on the canvas — by a user or by the in-app agent —
after the node already exists therefore never produces a CRDT op. It never
reaches `applyOps`, so it never replicates to any other connected client.
Two clients that each rename the same node concurrently, or one client that
renames while a stale local snapshot still shows the old title, resolve by
accident (whichever client's in-memory state happens to win a later
unrelated write) rather than by any defined merge rule. This is the root
cause of a title-stomp bug class.

ComfyUI_frontend PR #18075 worked around the single-client half of this
(a client's own optimistic rename getting clobbered by its own later
snapshot), but it cannot fix true multiplayer divergence: there is still no
op for "this node's title changed", so a second client has nothing to
receive.

## Decision

Add `set_title` to `FROZEN_OPS`: `{ node_id, title }` (plus the ordinary
envelope and an optional `node_incarnation`), where `title` is a string or
`null` (clearing a custom title back to the class default). It is LWW-gated
exactly like a top-level `set_widget` write — same stamp comparison, same
delete-wins no-op, same incarnation check — on its own register,
`("title", String(node_id), node_incarnation)`. See
`docs/multiplayer-schema.md` Amendment A21 for the full rule and the write
target table in §3.

**This is a package-local addition, not an upstream-mirrored one.** Every
other frozen op kind mirrors a definition in comfy-cli's
`docs/op-vocabulary-v1.md`, pinned by SHA (FC-10). comfy-cli's vocabulary has
not been amended to define a title-rename op. This package adds it first,
ahead of upstream ratification, because the bug is diagnosed and scoped
here and a client-side sync fix should not wait on a separate repository's
release cycle. `set_title` is PROVISIONAL: if comfy-cli's vocabulary later
defines an equivalent op under a different name or shape, this op is
reconciled with it rather than the two living in permanent disagreement.

### Alternatives considered

- **`update_node` (a general per-node property op).** Rejected for now:
  `title` is the only known post-creation node property with no write path,
  and a general envelope invites scope creep (which properties? what merge
  rule per property?) without a second confirmed use case. `set_title` can
  be generalized later if one appears; narrowing a general op after the fact
  is harder than widening a specific one.
- **Folding title into `set_widget`.** Rejected: `title` is not a widget,
  has no catalogued `widget_order` position, and is never subject to
  catalog/widget-name validation. Aliasing the widget register would let a
  title write and a same-named widget write on some future class contend for
  one register by accident.
- **Waiting for the comfy-cli vocabulary to add this first.** Rejected for
  this PR: the maintainer asked for the fix at the source in this package
  now (see Source above), and the bug is real and reproducible today. The
  cost is the provisional status above, which this ADR and Amendment A21
  make explicit rather than silent.

## Consequences

- Node-title renames become a first-class, synced, LWW-resolved operation.
- A consumer that switches on `Op["op"]` exhaustively must add a `set_title`
  arm (enforced by the `src/types.ts` partition guard at compile time).
- `docs/upstream-pins.json` is untouched: no existing pin moves, and no new
  pin is fabricated for a vocabulary section that does not exist upstream.
- **Explicitly out of scope for this PR:** wiring an emitting UI affordance
  (a canvas rename action that mints `set_title`) and the corresponding read
  path in `ComfyUI_frontend` and `cloud`. Those are separate, scoped
  follow-ups — see the PR description.
- **Also out of scope:** reconciling with comfy-cli. If/when comfy-cli's
  vocabulary adopts an equivalent op, revisit this ADR and Amendment A21
  together, the way Amendment A15's promoted-`connect` gating exception was
  resolved once comfy-cli PR #818 landed the matching amendment (see
  `docs/decisions/EXCEPTIONS.md`).

## Invariants

New `Op` member, `FROZEN_OPS`/`BATCHABLE_OPS` entry, and `__stamps` register.
Touches KA-2 (stamp rides inside the op — reuses `stampKey` verbatim), KA-4
(idempotent per `op_id`, delete-wins, validated before the first write), and
FC-7 (`op_id` never regenerated) — all by following `set_widget`'s existing
top-level shape rather than introducing new machinery. Does not touch KA-3 /
KA-12 (no catalog or widget-name involvement) or KA-11 (no root-map layout
change; `SCHEMA_VERSION` stays 4). FC-10 is the rule this ADR is deliberately
not yet satisfying for `set_title` itself — see Status above.

## Glossary

- **Title-stomp:** a rename that is silently lost or overwritten because no
  op carried it, observed in the in-app agent's live-canvas sync.
- **ADR-032 provisional status:** `set_title` is implemented and tested here
  but not yet mirrored in comfy-cli's pinned vocabulary; see Decision above.
