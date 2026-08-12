# @comfyorg/comfy-multi-player

The shared workflow-document package for multi-player ComfyUI: **one
implementation of op→doc semantics used identically by the browser and the
server doc host**. It owns the CRDT document layout (Yjs), the op applier, and
the deterministic projection back to ComfyUI workflow JSON — so every host
that applies the same stamped ops converges on the same document and renders
the same JSON.

> Naming note: the V1 design docs call this package `@comfy/graph-doc` — it
> was renamed to `@comfyorg/comfy-multi-player` at repo creation. Same thing.

## What lives here

- `applyOps(doc, ops, origin)` — apply a batch of stamped ops (idempotent per
  `op_id`, convergent under reordering via the `[base_version, actor]` stamp).
- `project(doc)` — deterministic projection of the doc to ComfyUI workflow JSON.
- `mint(workflow)` — import an existing workflow JSON into a fresh doc
  (lazy-mint at cutover).
- `migrate(doc, fromVersion)` + `SCHEMA_VERSION` — doc-layout versioning.
- Doc layout helpers (`initDoc`, `nodesMap`, `linksMap`, `metaMap`,
  `createNodeMap`) for the v1 schema: `Y.Map 'nodes'` (per-node `Y.Map` with
  `type`/`pos`/`flags`/`widgets_values` `Y.Array`), `Y.Map 'links'`,
  `Y.Map 'meta'` (schema_version, id counters, `extra` passthrough).

**Status: scaffold (V1-030).** `applyOps`/`project`/`mint`/`migrate` are typed
stubs that throw `NotImplementedError`; the first-draft applier and recorded
replay fixtures land in a separate spike.

## The op vocabulary is frozen

Six op kinds: `add_node`, `connect`, `set_widget`, `delete_node`, `clear`,
`reset_doc`. The **normative contract** is the op-vocabulary doc in comfy-cli:
[`docs/op-vocabulary-v1.md`](https://github.com/Comfy-Org/comfy-cli/blob/fix/validate-lowers-ui-to-api/docs/op-vocabulary-v1.md)
(branch `fix/validate-lowers-ui-to-api`), whose stamps are minted by
`comfy_cli/workflow_ops.py`. The `Op` types in `src/index.ts` mirror those
stamps field-for-field; any divergence is a bug here, not there.

## Purity is an invariant, not a convention

This package runs in the browser bundle **and** in the server doc host, so it
must stay free of UI frameworks, DOM implementations, and litegraph. Enforced
by `npm run check:purity` (CI-gated), which:

1. walks the full resolved dependency tree (`npm ls --json --all`) and fails
   on `vue`, `react`, `jsdom`, `electron`, anything matching `/litegraph/i`,
   or other DOM-touching libs;
2. imports the built `dist/index.js` in a bare Node subprocess and asserts no
   DOM globals exist before or after import.

`yjs` is the **only** runtime dependency. Keep it that way.

## Governance

- **The doc schema requires FE sign-off.** Any change to the Y.Doc layout or
  `SCHEMA_VERSION` bump must be reviewed by the frontend team before merge —
  the browser is a co-equal host of this document.
- **Ownership transfers to FE post-V1.** The backend team scaffolds and drives
  this package through V1 cutover; after that it is FE-owned.

## Acceptance gates (V1)

1. **Purity** — `check:purity` green in CI (dependency tree + bare-Node import).
2. **Fixtures green** — recorded op sessions in `fixtures/*.session.jsonl`
   replay through `applyOps` and `project` deep-equals the recorded final
   workflow (`test/replay.test.ts`; format in `fixtures/README.md`).
3. **Published SHA-pinnable artifact** — the package is consumable pinned to
   an exact commit/version by both the frontend and the server doc host.

## Develop

```bash
npm install
npm run build         # tsc → dist/
npm test              # vitest: schema + purity pass; replay is todo until the applier lands
npm run check:purity  # dependency-tree + bare-Node import gate
```
