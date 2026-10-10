# DynamicGroup catalog support

The fixture and catalog are derived from [comfy-cli `65769ee31183cd1e1049321c2fb42296f03bf4b5`](https://github.com/Comfy-Org/comfy-cli/blob/65769ee31183cd1e1049321c2fb42296f03bf4b5/comfy_cli/cql/widget_catalog.py). The registered functions are `build_types` and `build_catalog`.

To regenerate `test/fixtures/dynamic-group.json` at that revision, load `tests/comfy_cli/fixtures/dynamic_group.json`, pass its `object_info` through `Graph.from_object_info` and `build_catalog`, and copy each case's `workflow`. The `editing` case applies `workflow_ops.set_widget` to `loras.1.strength=0.7` and `after="edited tail"`, with consecutive base versions, and records both emitted ops plus `workflow_ops.canonical` of the final workflow. The `source_commit` records that revision. Expected edits in `test/dynamic-group.test.ts` are authored independently of this package. The source fixture records its frontend/core capture provenance.

`dynamic_groups` maps a row-count controller to `min`, `max`, relative `widgets`, and field `defaults`. Each row expands immediately after its controller under `<controller>.<index>.<field>`. Remove any default rows already present in `widget_order` before expanding the saved count.

The catalog controls layout, not prompt validity. Saved rows above an advertised `max` are retained; CLI/core validation decides whether they can execute. Counts must be non-negative safe integers and cannot expand a group beyond the existing `MAX_OVERFLOW_WIDGETS` allocation bound.

Like dynamic-combo selections, count changes only change projection. Fields in hidden rows retain their name-keyed registers, and newly visible fields without a stored value show template defaults. This avoids receiver-side writes whose outcome depends on op arrival order (KA-2, KA-4). This is not a live structural row operation: it does not remove a middle row, reindex surviving identities, or update connections and promotions. Those changes require the separate atomic row-operation protocol.

An explicit `widgets_values_form` remains authoritative. Existing row fields can be edited through it; a count change that requires replacing that declaration is refused before mutation. This PR does not introduce an op for changing producer-owned forms.

No wire key or op kind changes. New catalog content changes the catalog hash. Consumers must adopt this reader before receiving a DynamicGroup catalog; old documents remain tied to their original catalog and must be re-minted to adopt a new layout (KA-11, KA-12, FC-10).

## Namespace safety

Relative group fields must be distinct. A controller cannot also be a DynamicCombo selector or another group's row field. Each source widget order may declare a controller once, and any generated names already present must be its contiguous minimum-row block. The selected layout also refuses duplicate generated fields/controllers before they can share a register. Ordinary duplicate names keep their existing occurrence identities; unrelated dotted names are not rejected merely for sharing a group prefix. Seed companions such as `weights.0.seed.0` remain legal when declared by the template metadata.

## Reader and producer adoption

The released reader `0.3.10` and this draft both use schema v5. The schema gate and a catalog hash do **not** prove that an old reader understands `dynamic_groups`. An offline probe with the CLI composite fixture demonstrated that the old reader can mint a new positional workflow, acknowledge an `after` edit, and write that value into the first row's enabled position while leaving the real trailing value unchanged. Omitting group metadata produces the same unsupported mapping even with the current reader.

| Producer declaration | Reader/catalog combination | Supported scope |
| --- | --- | --- |
| Positional array without a node-local form | Complete group metadata plus this reader | Existing field edits and lossless projection, including two groups, a nondefault DynamicCombo, trailing widgets, and seed companions. |
| Positional array without a node-local form | Released `0.3.10`, or group metadata omitted | Unsupported: trailing writes can target a row value. Schema v5 does not reject this combination. |
| Explicit `widgets_values_form` | Either reader, group metadata omitted | Existing field edits retain the declared mapping. Count changes are not safe live row operations. |
| Explicit `widgets_values_form` | This reader plus complete group metadata | Existing field edits work; count changes requiring a new declaration are refused before mutation. |

Deploy the producer, complete catalog, package reader, and document host together. Re-mint source workflows when adopting the new pinned catalog. The caller owns compatibility admission; this package cannot recognize missing metadata as a DynamicGroup without guessing. Full Agent row insertion/deletion, declarations, connections, promotions, and convergence remain blocked on the separate atomic row-operation protocol.

`test/fixtures/dynamic-group-composite.json` records an actual CLI capture from the main-merged working tree. Its implemented producer is pinned at [comfy-cli `acc3b822d428db6c8572dd056bbb58ee217ed77b`](https://github.com/Comfy-Org/comfy-cli/blob/acc3b822d428db6c8572dd056bbb58ee217ed77b/comfy_cli/cql/widget_catalog.py), with `build_types` and `build_catalog` registered in `docs/upstream-pins.json`. The fixture records the capture base and the committed safety follow-up separately. A committed revision is not a released deployment; adopt compatible producer and reader pins together (KA-11, KA-12, FC-10).

To reproduce the trailing-write probe from this checkout, set `CMP_READER` to the released `0.3.10` package's `dist/index.js`, then repeat with this branch's built `dist/index.js`:

```sh
CMP_READER=/absolute/path/to/dist/index.js node --input-type=module <<'JS'
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const reader = await import(pathToFileURL(process.env.CMP_READER).href);
const fixture = JSON.parse(readFileSync("test/fixtures/dynamic-group-composite.json", "utf8"));
const doc = reader.mint(fixture.workflow, fixture.catalog, fixture.catalog.catalog_version);
try {
  const op = { ...fixture.op, widget: "after", value: "edited tail" };
  console.log(reader.applyOps(doc, [op], fixture.catalog).outcomes);
  console.log(reader.project(doc, fixture.catalog).nodes[0].widgets_values);
} finally {
  doc.destroy();
}
JS
```

The released reader acknowledges the write at position 4, replacing the enabled value. This reader edits the final `tail` position. Both readers accept an existing-field edit with the fixture's explicit form; that is a separate supported path, not evidence of live row-resize support.
