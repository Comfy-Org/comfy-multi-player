import { readFileSync } from "node:fs";
import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import { applyOps, mint, project, type Op, type TopLevelSetWidgetOp, type WidgetCatalog, type WidgetCatalogEntry, type WorkflowJSON } from "../src/index.js";
import { canonicalize } from "./helpers.js";
import { assertRejectedWithoutMutation } from "./rejection-test-helpers.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/dynamic-group.json", import.meta.url), "utf8")) as {
  catalog: WidgetCatalog;
  cases: Record<"empty" | "populated", WorkflowJSON>;
  editing: { ops: Op[]; expected: WorkflowJSON };
};
const { catalog, cases } = fixture;
const composite = JSON.parse(readFileSync(new URL("./fixtures/dynamic-group-composite.json", import.meta.url), "utf8")) as {
  catalog: WidgetCatalog;
  workflow: WorkflowJSON;
  op: TopLevelSetWidgetOp;
  expected_workflow: WorkflowJSON;
  explicit_form_workflow: WorkflowJSON;
  standalone_count_op: TopLevelSetWidgetOp;
};
const groupEntry = catalog.types["DevToolsNodeWithDynamicGroup"]!;
const loras = groupEntry.dynamic_groups!["loras"]!;
const conditionalCatalog: WidgetCatalog = { types: { DevToolsNodeWithDynamicGroup: {
  ...groupEntry,
  widget_order: ["before", "mode", "after"],
  dynamic_combos: { mode: { default: "off", options: {
    off: { widgets: [], defaults: {} },
    on: { widgets: ["loras"], defaults: { loras: 0 } },
  } } },
} } };
const edit = (widget: string, value: unknown, counter = 1) => ({
  op: "set_widget", node_id: 1, widget, value,
  op_id: counter.toString(16).padStart(32, "0"), actor: "agent:a", base_version: counter, stamp: [counter, "agent:a"],
} satisfies TopLevelSetWidgetOp);

describe("DynamicGroup catalog layout", () => {
  it.each([
    ["duplicate controller", { ...groupEntry, widget_order: ["before", "loras", "loras", "after"] }],
    ["duplicate relative field", { ...groupEntry, dynamic_groups: { loras: { ...loras, widgets: ["strength", "strength"] } } }],
    ["ordinary generated-name alias", { ...groupEntry, widget_order: ["before", "loras", "after", "loras.0.strength"] }],
    ["duplicate minimum-row field", {
      ...groupEntry,
      widget_order: ["before", "loras", "loras.0.lora_name", "loras.0.strength", "loras.0.enabled", "loras.0.strength", "after"],
      dynamic_groups: { loras: { ...loras, min: 1 } },
    }],
    ["misplaced minimum-row field", {
      ...groupEntry,
      widget_order: ["loras.0.lora_name", "before", "loras", "loras.0.strength", "loras.0.enabled", "after"],
      dynamic_groups: { loras: { ...loras, min: 1 } },
    }],
    ["controller also used by DynamicCombo", {
      ...groupEntry,
      dynamic_combos: { loras: { default: "none", options: { none: { widgets: [], defaults: {} } } } },
    }],
    ["missing controller", { ...groupEntry, widget_order: ["before", "after"] }],
    ["other group controller aliases a row field", {
      ...groupEntry,
      widget_order: ["before", "loras", "loras.0.strength", "after"],
      dynamic_groups: { ...groupEntry.dynamic_groups, "loras.0.strength": { min: 0, max: 3, widgets: ["value"], defaults: { value: 1 } } },
    }],
  ] satisfies [string, WidgetCatalogEntry][])("refuses %s catalog metadata before naming values", (_label, entry) => {
    const malformed = structuredClone(catalog);
    malformed.types["DevToolsNodeWithDynamicGroup"] = entry;
    const workflow = structuredClone(cases.empty);
    workflow.nodes[0]!.widgets_values = { before: "first", loras: 0, after: "last" };

    expect(() => mint(workflow, malformed)).toThrow(/DynamicGroup/);
  });

  it("refuses a malformed catalog on projection or apply without changing the document", () => {
    const doc = mint(cases.populated, catalog);
    const malformed = structuredClone(catalog);
    malformed.types["DevToolsNodeWithDynamicGroup"]!.dynamic_groups!["loras"]!.widgets.push("strength");
    const op = edit("after", "must not land");
    const trailing = edit("before", "must not land either", 2);
    const before = Y.encodeStateAsUpdate(doc);

    expect(() => project(doc, malformed)).toThrow(/DynamicGroup/);
    expect(applyOps(doc, [op, trailing], malformed).outcomes).toMatchObject([
      { outcome: "rejected", reason: { code: "apply_failed" } },
      { outcome: "rejected", reason: { code: "batch_aborted" } },
    ]);
    expect(applyOps(doc, [op], malformed).outcomes[0]).toMatchObject({ outcome: "rejected", reason: { code: "apply_failed" } });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(doc.getMap("__applied").has(op.op_id)).toBe(false);
    expect(doc.getMap("__applied").has(trailing.op_id)).toBe(false);
    expect(project(doc, catalog).nodes[0]!.widgets_values).toEqual(cases.populated.nodes[0]!.widgets_values);
    doc.destroy();
  });

  it("keeps ordinary duplicate occurrences and unrelated dotted names distinct", () => {
    const duplicateCatalog = structuredClone(catalog);
    duplicateCatalog.types["DevToolsNodeWithDynamicGroup"]!.widget_order = ["before", "before", "loras", "loras.note", "after", "after"];
    const workflow = structuredClone(cases.empty);
    delete workflow.nodes[0]!["widgets_values_named"];
    workflow.nodes[0]!.widgets_values = ["first", "second", 1, "A.safetensors", 1, true, "ordinary dotted value", "tail one", "tail two"];
    const doc = mint(workflow, duplicateCatalog);

    expect(project(doc, duplicateCatalog).nodes[0]!.widgets_values).toEqual(workflow.nodes[0]!.widgets_values);
    expect(applyOps(doc, [{ ...edit("before", "edited second"), widget_occurrence: 1 }], duplicateCatalog).outcomes[0]?.outcome).toBe("applied");
    expect(project(doc, duplicateCatalog).nodes[0]!.widgets_values).toEqual(["first", "edited second", 1, "A.safetensors", 1, true, "ordinary dotted value", "tail one", "tail two"]);
    doc.destroy();
  });

  it("round-trips the CLI two-group, nondefault-combo, seed-companion composition and replays its field edit", () => {
    const doc = mint(composite.workflow, composite.catalog);
    expect(canonicalize(project(doc, composite.catalog))).toEqual(canonicalize(composite.workflow));

    expect(applyOps(doc, [composite.op], composite.catalog).outcomes[0]?.outcome).toBe("applied");
    expect(canonicalize(project(doc, composite.catalog))).toEqual(canonicalize(composite.expected_workflow));
    const beforeRetry = Y.encodeStateAsUpdate(doc);
    applyOps(doc, [composite.op], composite.catalog);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(beforeRetry);
    doc.destroy();
  });

  it("uses an explicit producer form for existing field edits without group metadata", () => {
    const withoutGroups = structuredClone(composite.catalog);
    delete withoutGroups.types["CompositeDynamicGroup"]!.dynamic_groups;
    const doc = mint(composite.explicit_form_workflow, withoutGroups);

    expect(applyOps(doc, [composite.op], withoutGroups).outcomes[0]?.outcome).toBe("applied");
    const expected = structuredClone(composite.expected_workflow);
    expected.nodes[0]!.widgets_values_form = composite.explicit_form_workflow.nodes[0]!.widgets_values_form;
    expect(canonicalize(project(doc, withoutGroups))).toEqual(canonicalize(expected));
    doc.destroy();
  });

  it("refuses the CLI standalone count op when replay cannot update the producer form", () => {
    const workflow = structuredClone(composite.explicit_form_workflow);
    const before = structuredClone(workflow);
    assertRejectedWithoutMutation(workflow, composite.standalone_count_op,
      "malformed_op", composite.catalog, { ...composite.op, op_id: "d".repeat(32) });
    expect(workflow).toEqual(before);
  });

  it("replays CLI-authored field and trailing-widget edits exactly", () => {
    const doc = mint(cases.populated, catalog);
    expect(applyOps(doc, fixture.editing.ops, catalog).outcomes.map((o) => o.outcome)).toEqual(["applied", "applied"]);
    expect(canonicalize(project(doc, catalog))).toEqual(canonicalize(fixture.editing.expected));
    doc.destroy();
  });
  it.each(["empty", "populated"] as const)("round-trips the %s frontend workflow", (name) => {
    const doc = mint(cases[name], catalog);
    expect(canonicalize(project(doc, catalog))).toEqual(canonicalize(cases[name]));
    doc.destroy();
  });

  it.each([
    ["loras.1.strength", 0.7, ["head", 2, "A.safetensors", 1, true, "C.safetensors", 0.7, false, "tail"]],
    ["after", "edited", ["head", 2, "A.safetensors", 1, true, "C.safetensors", 0.5, false, "edited"]],
  ])("edits %s without shifting its siblings", (widget, value, expected) => {
    const doc = mint(cases.populated, catalog);
    const op = edit(widget as string, value);
    expect(applyOps(doc, [op], catalog).outcomes[0]?.outcome).toBe("applied");
    const node = project(doc, catalog).nodes[0]!;
    expect(node.widgets_values).toEqual(expected);
    expect(node["widgets_values_named"]).toMatchObject({ [widget as string]: value });
    const beforeRetry = Y.encodeStateAsUpdate(doc);
    applyOps(doc, [op], catalog);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(beforeRetry);
    doc.destroy();
  });

  it("reads defaults for newly shown rows without shifting the trailing widget", () => {
    const doc = mint(cases.empty, catalog);
    expect(applyOps(doc, [edit("loras", 1)], catalog).outcomes[0]?.outcome).toBe("applied");
    expect(project(doc, catalog).nodes[0]!.widgets_values).toEqual(["first", 1, "A.safetensors", 1, true, "last"]);
    doc.destroy();
  });

  it("keeps hidden row values when the count changes", () => {
    const doc = mint(cases.populated, catalog);
    applyOps(doc, [edit("loras", 0)], catalog);
    expect(project(doc, catalog).nodes[0]!.widgets_values).toEqual(["head", 0, "tail"]);
    applyOps(doc, [edit("loras", 2, 2)], catalog);
    expect(project(doc, catalog).nodes[0]!.widgets_values).toEqual(cases.populated.nodes[0]!.widgets_values);
    doc.destroy();
  });

  it("converges when the row count and a row value arrive in either order", () => {
    const seed = mint(cases.empty, catalog);
    const snapshot = Y.encodeStateAsUpdate(seed);
    const ops = [edit("loras", 1), edit("loras.0.strength", 0.7, 2)];
    for (const ordered of [ops, [...ops].reverse()]) {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, snapshot);
      expect(applyOps(doc, ordered, catalog).outcomes.map((o) => o.outcome)).toEqual(["applied", "applied"]);
      expect(project(doc, catalog).nodes[0]!.widgets_values).toEqual(["first", 1, "A.safetensors", 0.7, true, "last"]);
      doc.destroy();
    }
    seed.destroy();
  });

  it("keeps named values coherent when a row edit races with hiding that row", () => {
    const seed = mint(cases.populated, catalog);
    const snapshot = Y.encodeStateAsUpdate(seed);
    const ops = [edit("loras", 0), edit("loras.1.strength", 0.7, 2)];
    for (const ordered of [ops, [...ops].reverse()]) {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, snapshot);
      expect(applyOps(doc, ordered, catalog).outcomes.map((o) => o.outcome)).toEqual(["applied", "applied"]);
      applyOps(doc, [edit("loras", 2, 3)], catalog);
      const node = project(doc, catalog).nodes[0]!;
      expect(node.widgets_values).toEqual(["head", 2, "A.safetensors", 1, true, "C.safetensors", 0.7, false, "tail"]);
      expect(node["widgets_values_named"]).toMatchObject({ "loras.1.strength": 0.7 });
      doc.destroy();
    }
    seed.destroy();
  });

  it.each([-1, 1.5, "2", 1_000_000])("refuses unsafe row count %s before writing", (count) => {
    assertRejectedWithoutMutation(cases.populated, edit("loras", count), "malformed_op", catalog,
      edit("after", "must not run", 2));
  });

  it("refuses a malformed saved count before minting a misaligned document", () => {
    const workflow = structuredClone(cases.populated);
    (workflow.nodes[0]!.widgets_values as unknown[])[1] = -1;
    expect(() => mint(workflow, catalog)).toThrow(/row count/);
  });

  it.each([-1, 1.5, "2", 1_000_000])("refuses inactive named group count %s during mint", (count) => {
    const workflow = structuredClone(cases.empty);
    delete workflow.nodes[0]!["widgets_values_named"];
    workflow.nodes[0]!.widgets_values = { before: "first", mode: "off", loras: count, after: "last" };

    expect(() => mint(workflow, conditionalCatalog)).toThrow(/row count/);
  });

  it("keeps a valid inactive named group available when its option is selected", () => {
    const workflow = structuredClone(cases.empty);
    delete workflow.nodes[0]!["widgets_values_named"];
    workflow.nodes[0]!.widgets_values = { before: "first", mode: "off", loras: 2, after: "last" };
    const doc = mint(workflow, conditionalCatalog);

    expect(project(doc, conditionalCatalog).nodes[0]!.widgets_values).toEqual(["first", "off", "last"]);
    expect(applyOps(doc, [edit("mode", "on")], conditionalCatalog).outcomes[0]?.outcome).toBe("applied");
    expect(project(doc, conditionalCatalog).nodes[0]!.widgets_values).toEqual([
      "first", "on", 2, "A.safetensors", 1, true, "A.safetensors", 1, true, "last",
    ]);
    doc.destroy();
  });

  it.each(["mint", "interior_mint", "add_node", "insert_workflow"] as const)(
    "preserves declared-form residue independently of group metadata on %s",
    (path) => {
      const workflow = structuredClone(cases.empty);
      const node = workflow.nodes[0]!;
      delete node["widgets_values_named"];
      node.widgets_values = { before: "first", mode: "on", loras: -1, after: "last" };
      node.widgets_values_form = { order: ["before", "mode", "after"] };
      if (path === "mint") {
        const doc = mint(workflow, conditionalCatalog);
        expect(project(doc, conditionalCatalog).nodes[0]!.widgets_values).toEqual(node.widgets_values);
        expect(project(doc, conditionalCatalog).nodes[0]!.widgets_values_form).toEqual(node.widgets_values_form);
        doc.destroy();
      } else if (path === "interior_mint") {
        const doc = mint({
          nodes: [{ id: 9, type: "group-definition" }], links: [],
          definitions: { subgraphs: [{ id: "group-definition", nodes: [node], links: [] }] },
        }, conditionalCatalog);
        expect(project(doc, conditionalCatalog)).toMatchObject({ definitions: { subgraphs: [{ nodes: [{
          widgets_values: node.widgets_values, widgets_values_form: node.widgets_values_form,
        }] }] } });
        doc.destroy();
      } else {
        const envelope = {
          op_id: "a".repeat(32), actor: "agent:a", base_version: 1, stamp: [1, "agent:a"],
        } satisfies Pick<Op, "op_id" | "actor" | "base_version" | "stamp">;
        const op: Op = path === "add_node"
          ? { ...envelope, op: "add_node", node_id: node.id, class_type: node.type, pos: [0, 0], node }
          : { ...envelope, op: "insert_workflow", workflow };
        const doc = mint({ nodes: [], links: [] }, conditionalCatalog);
        expect(applyOps(doc, [op], conditionalCatalog).outcomes[0]?.outcome).toBe("applied");
        const restored = project(doc, conditionalCatalog).nodes.find((candidate) => candidate.type === node.type)!;
        expect(restored.widgets_values).toEqual(node.widgets_values);
        expect(restored.widgets_values_form).toEqual(node.widgets_values_form);
        doc.destroy();
      }
    },
  );

  it("preserves rows above a newer catalog's advertised maximum", () => {
    const smaller = structuredClone(catalog);
    smaller.types["DevToolsNodeWithDynamicGroup"]!.dynamic_groups!["loras"]!.max = 1;
    const doc = mint(cases.populated, smaller);
    expect(project(doc, smaller).nodes[0]!.widgets_values).toEqual(cases.populated.nodes[0]!.widgets_values);
    applyOps(doc, [edit("loras", 0)], smaller);
    expect(project(doc, smaller).nodes[0]!.widgets_values).toEqual(["head", 0, "tail"]);
    doc.destroy();
  });

  it("does not duplicate the default minimum rows in the catalog order", () => {
    const minimum = structuredClone(catalog);
    const entry = minimum.types["DevToolsNodeWithDynamicGroup"]!;
    entry.dynamic_groups!["loras"]!.min = 1;
    entry.widget_order = ["before", "loras", "loras.0.lora_name", "loras.0.strength", "loras.0.enabled", "after"];
    const doc = mint(cases.populated, minimum);
    expect(project(doc, minimum).nodes[0]!.widgets_values).toEqual(cases.populated.nodes[0]!.widgets_values);
    doc.destroy();
  });

  it("respects an explicit widget form and refuses to silently invalidate its order", () => {
    const workflow = structuredClone(cases.populated);
    workflow.nodes[0]!["widgets_values_form"] = { order: [
      "before", "loras", "loras.0.lora_name", "loras.0.strength", "loras.0.enabled",
      "loras.1.lora_name", "loras.1.strength", "loras.1.enabled", "after",
    ] };
    const doc = mint(workflow, catalog);
    expect(applyOps(doc, [edit("loras.1.strength", 0.7)], catalog).outcomes[0]?.outcome).toBe("applied");
    expect(project(doc, catalog).nodes[0]!.widgets_values).toEqual([
      "head", 2, "A.safetensors", 1, true, "C.safetensors", 0.7, false, "tail",
    ]);
    assertRejectedWithoutMutation(workflow, edit("loras", 0), "malformed_op", catalog,
      edit("after", "must not run", 2));
    doc.destroy();
  });

  it.each([0, -1])("refuses promoted count %s without invalidating the declared row form", (count) => {
    const workflow = structuredClone(cases.populated);
    workflow.nodes[0]!.widgets_values_form = { order: [
      "before", "loras", "loras.0.lora_name", "loras.0.strength", "loras.0.enabled",
      "loras.1.lora_name", "loras.1.strength", "loras.1.enabled", "after",
    ] };
    const op: TopLevelSetWidgetOp = {
      ...edit("loras", count),
      promoted: {
        value_index: 1, instance_path: ["1"],
        host_widgets_values: ["head", count, "A.safetensors", 1, true, "C.safetensors", 0.5, false, "tail"],
      },
    };
    assertRejectedWithoutMutation(workflow, op, "malformed_op", catalog,
      edit("after", "must not run", 2));
  });

  it("preserves promoted ordinary row field edits through the declared form", () => {
    const workflow = structuredClone(cases.populated);
    workflow.nodes[0]!.widgets_values_form = { order: [
      "before", "loras", "loras.0.lora_name", "loras.0.strength", "loras.0.enabled",
      "loras.1.lora_name", "loras.1.strength", "loras.1.enabled", "after",
    ] };
    const op: TopLevelSetWidgetOp = {
      ...edit("loras.1.strength", 0.7),
      promoted: {
        value_index: 6, instance_path: ["1"],
        host_widgets_values: ["head", 2, "A.safetensors", 1, true, "C.safetensors", 0.7, false, "tail"],
      },
    };
    const doc = mint(workflow, catalog);

    expect(applyOps(doc, [op], catalog).outcomes[0]?.outcome).toBe("applied");
    const node = project(doc, catalog).nodes[0]!;
    expect(node.widgets_values).toEqual(["head", 2, "A.safetensors", 1, true, "C.safetensors", 0.7, false, "tail"]);
    expect(node.widgets_values_form).toEqual(workflow.nodes[0]!.widgets_values_form);
    const beforeRetry = Y.encodeStateAsUpdate(doc);
    applyOps(doc, [op], catalog);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(beforeRetry);
    doc.destroy();
  });

  it("edits interior rows and rejects invalid interior counts without mutation", () => {
    const workflow: WorkflowJSON = {
      nodes: [{ id: 9, type: "group-definition" }], links: [],
      definitions: { subgraphs: [{ id: "group-definition", nodes: cases.populated.nodes, links: [] }] },
    };
    const op: Op = { ...edit("loras.1.strength", 0.7), path: ["9", "1"], inner_widget: "loras.1.strength" };
    const doc = mint(workflow, catalog);
    expect(applyOps(doc, [op], catalog).outcomes[0]?.outcome).toBe("applied");
    const definitions = project(doc, catalog)["definitions"] as { subgraphs: WorkflowJSON[] };
    expect(definitions.subgraphs[0]!.nodes[0]!.widgets_values).toEqual([
      "head", 2, "A.safetensors", 1, true, "C.safetensors", 0.7, false, "tail",
    ]);
    const invalid: Op = { ...edit("loras", -1), path: ["9", "1"], inner_widget: "loras" };
    assertRejectedWithoutMutation(workflow, invalid, "malformed_op", catalog, { ...op, op_id: "b".repeat(32) });
    doc.destroy();
  });
});
