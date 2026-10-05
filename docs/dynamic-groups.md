# DynamicGroup catalog support

The fixture and catalog are derived from [comfy-cli `65769ee31183cd1e1049321c2fb42296f03bf4b5`](https://github.com/Comfy-Org/comfy-cli/blob/65769ee31183cd1e1049321c2fb42296f03bf4b5/comfy_cli/cql/widget_catalog.py). The registered functions are `build_types` and `build_catalog`.

To regenerate `test/fixtures/dynamic-group.json` at that revision, load `tests/comfy_cli/fixtures/dynamic_group.json`, pass its `object_info` through `Graph.from_object_info` and `build_catalog`, and copy each case's `workflow`. The `editing` case applies `workflow_ops.set_widget` to `loras.1.strength=0.7` and `after="edited tail"`, with consecutive base versions, and records both emitted ops plus `workflow_ops.canonical` of the final workflow. The `source_commit` records that revision. Expected edits in `test/dynamic-group.test.ts` are authored independently of this package. The source fixture records its frontend/core capture provenance.

`dynamic_groups` maps a row-count controller to `min`, `max`, relative `widgets`, and field `defaults`. Each row expands immediately after its controller under `<controller>.<index>.<field>`. Remove any default rows already present in `widget_order` before expanding the saved count.

The catalog controls layout, not prompt validity. Saved rows above an advertised `max` are retained; CLI/core validation decides whether they can execute. Counts must be non-negative safe integers and cannot expand a group beyond the existing `MAX_OVERFLOW_WIDGETS` allocation bound.

Like dynamic-combo selections, count changes only change projection. Fields in hidden rows retain their name-keyed registers, and newly visible fields without a stored value show template defaults. This avoids receiver-side writes whose outcome depends on op arrival order (KA-2, KA-4). It is not a destructive row-delete operation: deleting a row and its links is a separate producer responsibility.

An explicit `widgets_values_form` remains authoritative. Existing row fields can be edited through it; a count change that requires replacing that declaration is refused before mutation. This PR does not introduce an op for changing producer-owned forms.

No wire key or op kind changes. New catalog content changes the catalog hash. Consumers must adopt this reader before receiving a DynamicGroup catalog; old documents remain tied to their original catalog and must be re-minted to adopt a new layout (KA-11, KA-12, FC-10).
