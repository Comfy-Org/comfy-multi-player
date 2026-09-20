/**
 * Repro (now fixed at this package's consuming boundary) for the in-app Cloud
 * agent's "Get Template" tool failing on the Magnific Skin Enhancer partner
 * template (Slack #comfy-agent-user-feedback, reported by Jo Zhang). Traced to
 * a real, open contract gap between the PINNED widget catalog this package
 * receives and what a node's actual `widgets_values` carries for a
 * `COMFY_DYNAMICCOMBO_V3` selection other than the schema's first option key
 * (BE-9176), which surfaced here exactly the way BE-11611 describes
 * ("widgets_values has N entries but widget_order names only M").
 *
 * `MagnificImageSkinEnhancerNode` (comfy_api_nodes/nodes_magnific.py) has a
 * `mode` dynamic combo with three options:
 *   - "creative" (first key)  — 0 extra sub-widgets
 *   - "faithful"              — 1 extra sub-widget: `skin_detail`
 *   - "flexible"              — 1 extra sub-widget: `optimized_for`
 *
 * `comfy nodes widget-catalog` (comfy_cli/cql/widget_catalog.py `build_types`,
 * over `Graph.widget_order_default`) is what `services/agent/internal/loop/
 * widget_catalog.go` in `cloud` acquires ONCE PER PROCESS and hands to this
 * package as the `WidgetCatalog` the doc-host mints and applies against. That
 * catalog expands a dynamic combo at its FIRST key ONLY — by design, since a
 * catalog has no node and no selection (see that module's own docstring) — so
 * `MagnificImageSkinEnhancerNode`'s pinned `widget_order` is always
 * `["sharpen", "smart_grain", "mode"]`, three names, regardless of which mode
 * a real node carries:
 *
 *   Graph.widget_order_default("MagnificImageSkinEnhancerNode")
 *     == ["sharpen", "smart_grain", "mode"]                    # 3 names
 *   Graph.widget_order_for_node(..., ["0", "2", "faithful", 80])
 *     == ["sharpen", "smart_grain", "mode", "mode.skin_detail"] # 4, CLI-side
 *
 * Root cause lives in the catalog/consumer contract (BE-9176) — the pinned
 * catalog acquisition (a different repo, comfy-cli, on a different release
 * cycle) cannot itself become value-aware from here — so the fix lives at
 * this package's consuming boundary instead, in the two places that used to
 * trust the pinned `widget_order` as the sole truth:
 *
 *   - `createNodeMap` → `widgetsToYMap` (`src/doc.ts`) no longer throws when
 *     `widgets_values` overruns the pinned order. The overrun entries are
 *     named positionally (`overflowWidgetName`, e.g. `"_extra_3"`) instead of
 *     the whole node being lost, and `project()`'s `widgetsToPositional`
 *     reads the same shape back to its original index, so the mint/project
 *     round trip still holds.
 *   - `applySetWidget` → `validateWidgetName` (`src/applier.ts`) now accepts a
 *     dotted widget name (`"mode.skin_detail"`) as a plausible dynamic-combo
 *     sub-field write when its prefix (`"mode"`) IS a catalogued widget of the
 *     node's class, rather than rejecting every such write as `unknown_widget`.
 *
 * Both are deliberately narrow, documented deviations from the package's
 * usual "reject rather than guess" catalog posture (`docs/decisions/EXCEPTIONS.md`,
 * KA-12) — the pinned catalog still cannot say whether `skin_detail` is
 * REALLY faithful mode's sub-widget, only that `mode` is a real widget of this
 * class and that a dotted name naming it is more useful accepted than refused.
 */
import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import { rejectedOutcome } from "./apply-result-helpers.js";
import {
  applyOps,
  mint,
  project,
  type SetWidgetOp,
  type WidgetCatalog,
  type WorkflowJSON,
} from "../src/index.js";

// The catalog `comfy nodes widget-catalog` actually publishes for this class
// today: first-key ("creative") expansion only, 3 names.
const catalog: WidgetCatalog = {
  types: {
    MagnificImageSkinEnhancerNode: { widget_order: ["sharpen", "smart_grain", "mode"] },
  },
};

let seq = 0;
const opId = () => ("m" + String(seq++).padStart(4, "0")).padEnd(32, "0");
const envelope = (actor = "agent", baseVersion = 0) => ({
  op_id: opId(),
  actor,
  base_version: baseVersion,
  stamp: [baseVersion, actor] as [number, string],
});

/** A minimal one-node workflow around the published Magnific Skin Enhancer
 * template's node 3 (comfy-cloud-mcp-server fixture
 * `src/converter/test/fixtures/templates/api_magnific_skin_enhancer/workflow.json`),
 * parameterized by `widgets_values` so each mode can be minted. */
function magnificWorkflow(widgets_values: unknown[]): WorkflowJSON {
  return {
    nodes: [
      {
        id: 3,
        type: "MagnificImageSkinEnhancerNode",
        inputs: [{ name: "image", type: "IMAGE", link: 1 }],
        outputs: [{ name: "IMAGE", type: "IMAGE", links: [] }],
        widgets_values,
      },
    ],
    links: [],
    last_node_id: 3,
    last_link_id: 1,
  } as unknown as WorkflowJSON;
}

describe("Get Template materialization of Magnific Skin Enhancer (BE-9176 / BE-11611)", () => {
  it("mints fine at the template's default 'creative' mode (3 positional values == the catalog's 3 names)", () => {
    expect(() => mint(magnificWorkflow([0, 2, "creative"]), catalog)).not.toThrow();
  });

  it("mints 'faithful' mode without throwing, naming the overrun sub-widget positionally", () => {
    // sharpen=0, smart_grain=2, mode="faithful", mode.skin_detail=80 -> 4 positional values,
    // one more than the pinned catalog's 3-name widget_order.
    const doc = mint(magnificWorkflow([0, 2, "faithful", 80]), catalog);
    const node = doc.getMap("nodes").get("3") as Y.Map<unknown>;
    const widgets = node.get("widgets") as Y.Map<unknown>;
    expect(widgets.get("sharpen")).toBe(0);
    expect(widgets.get("smart_grain")).toBe(2);
    expect(widgets.get("mode")).toBe("faithful");
    // Named positionally (BE-9176 `overflowWidgetName`): the pinned catalog
    // cannot know this class's real sub-widget name for a non-default mode.
    expect(widgets.get("_extra_3")).toBe(80);
    // The round trip mint()'s own docstring promises still holds for the
    // overrun entry: project() reads it back to its original position.
    expect(project(doc, catalog)).toEqual(
      expect.objectContaining({ nodes: [expect.objectContaining({ widgets_values: [0, 2, "faithful", 80] })] }),
    );
  });

  it("mints 'flexible' mode without throwing, for the same reason", () => {
    const doc = mint(magnificWorkflow([0, 2, "flexible", "enhance_skin"]), catalog);
    expect(project(doc, catalog)).toEqual(
      expect.objectContaining({
        nodes: [expect.objectContaining({ widgets_values: [0, 2, "flexible", "enhance_skin"] })],
      }),
    );
  });

  it("set_widget can address the nested sub-setting too, so the agent's manual node-by-node fallback can set faithful mode's skin_detail", () => {
    // Build from the mode that DOES mint at its default (creative), then dial
    // the node into faithful mode's nested sub-setting the way the agent's
    // fallback (Apply ops / Set widget) attempted.
    const doc = mint(magnificWorkflow([0, 2, "creative"]), catalog);
    const setMode: SetWidgetOp = { op: "set_widget", ...envelope(), node_id: 3, widget: "mode", value: "faithful" };
    const setSkinDetail: SetWidgetOp = {
      op: "set_widget",
      ...envelope(),
      node_id: 3,
      widget: "mode.skin_detail",
      value: 80,
    };
    const res = applyOps(doc, [setMode, setSkinDetail], catalog);
    const rejected = rejectedOutcome(res);
    // Fixed: "mode.skin_detail" is now accepted as a plausible dynamic-combo
    // sub-field write, since its prefix "mode" IS a catalogued widget of this
    // class (`applier.ts`'s `isPlausibleDynamicComboSubfield`).
    expect(rejected).toBeUndefined();
    const node = doc.getMap("nodes").get("3") as Y.Map<unknown>;
    const widgets = node.get("widgets") as Y.Map<unknown>;
    expect(widgets.get("mode")).toBe("faithful");
    expect(widgets.get("mode.skin_detail")).toBe(80);
  });
});
