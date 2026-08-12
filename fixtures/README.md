# Replay fixtures

Recorded op sessions used by `test/replay.test.ts` to prove the applier: each
session is replayed onto a fresh `Y.Doc` via `applyOps`, and the projection
(`project(doc)`) must deep-equal the workflow JSON the recording ended with.

Fixtures are delivered by the fixtures + first-draft-applier spike (separate
ticket); this directory ships empty in the scaffold.

## Format: `<name>.session.jsonl`

One JSON object per line.

**Line 1 — header:**

```json
{"session": "<session id>", "source": "<where it was recorded: agent|cli|frontend>", "workflow_final": { ...full ComfyUI workflow JSON... }}
```

`workflow_final` is the complete workflow JSON at the end of the session — the
deep-equal target for the replayed projection.

**Lines 2..N — one stamped op per line**, in recorded order, exactly as minted
by comfy-cli's `workflow_ops` (`op`, `op_id`, `actor`, `base_version`,
`stamp: [base_version, actor]`, plus the kind-specific payload):

```json
{"op": "add_node", "op_id": "…", "actor": "cli", "base_version": 0, "stamp": [0, "cli"], "node_id": 4503599627370501, "class_type": "KSampler", "pos": [420, 180], "node": { … }}
{"op": "set_widget", "op_id": "…", "actor": "cli", "base_version": 1, "stamp": [1, "cli"], "node_id": 4503599627370501, "widget": "steps", "value": 30, "old": 20}
```

The normative op vocabulary is comfy-cli `docs/op-vocabulary-v1.md`
(branch `fix/validate-lowers-ui-to-api`).
