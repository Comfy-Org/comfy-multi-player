/**
 * Repro for the in-app Cloud agent's "Get Template" tool failing on the
 * Magnific Skin Enhancer partner template (Slack #comfy-agent-user-feedback,
 * reported by Jo Zhang). Traced to a real, open contract gap between the
 * PINNED widget catalog this package receives and what a node's actual
 * `widgets_values` carries for a `COMFY_DYNAMICCOMBO_V3` selection other than
 * the schema's first option key (BE-9176), which then surfaces here exactly
 * the way BE-11611 describes ("widgets_values has N entries but widget_order
 * names only M").
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
 * `mint()` (via `createNodeMap` → `widgetsToYMap` in `src/doc.ts`) has no
 * access to the value-aware CLI computation — it only has the pinned,
 * first-key catalog — so a "faithful" or "flexible" Magnific node's 4-element
 * `widgets_values` overruns the catalog's 3-name order and `widgetsToYMap`
 * throws. That throw is what the agent's "Get Template" tool call fails with.
 * The template's own *default* ("creative", 3 values) mints fine, which is
 * consistent with `List templates` / `List model picks` never showing the
 * problem — it appears once the template is actually used for a
 * faithful/flexible skin-preserving job, which is the ask "Magnific's skin
 * enhancer" was picked for.
 *
 * The agent's own fallback ("I'll build it directly with the same Magnific
 * skin enhancer node") also fails for the same reason: `set_widget` resolves
 * a widget name against this same pinned `widget_order`
 * (`applier.ts`'s `applySetWidget` → `entry.widget_order.includes(widget)`),
 * so the nested sub-setting (`mode.skin_detail` / `mode.optimized_for`) is
 * never in it and every attempt to set it directly is rejected
 * `unknown_widget` — matching the agent's own words, "faithful and flexible
 * modes each need a nested sub-setting that this session can't set
 * directly."
 *
 * Root cause lives in the catalog/consumer contract (BE-9176), not in this
 * package — `mint`/`applySetWidget` are doing exactly what a `WidgetCatalog`
 * with only a static `widget_order` can do. This file pins the resulting,
 * user-visible failure at the boundary this package owns, using `it.fails`
 * (this repo's own established idiom for a currently-true, not-yet-fixed
 * defect — see docs/multiplayer-schema.md's retired `it.fails` cycle pin):
 * once the catalog or its consumers become value-aware, these flip to
 * unexpectedly passing and should be converted to plain assertions.
 */
import { describe, expect, it } from "vitest";
import { rejectedOutcome } from "./apply-result-helpers.js";
import {
  applyOps,
  mint,
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

  it.fails(
    "mint() throws for 'faithful' mode — the exact class of error ('widgets_values has N entries but widget_order names only M') the agent's Get Template tool surfaces as a failure",
    () => {
      // sharpen=0, smart_grain=2, mode="faithful", mode.skin_detail=80 -> 4 positional values.
      mint(magnificWorkflow([0, 2, "faithful", 80]), catalog);
    },
  );

  it.fails("mint() throws for 'flexible' mode for the same reason", () => {
    mint(magnificWorkflow([0, 2, "flexible", "enhance_skin"]), catalog);
  });

  it.fails(
    "set_widget cannot address the nested sub-setting either, so the agent's manual node-by-node fallback also fails to set faithful mode's skin_detail",
    () => {
      // Build from the mode that DOES mint (creative), then try to dial the
      // node into faithful mode's nested sub-setting the way the agent's
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
      // Bug: today this IS rejected `unknown_widget` because "mode.skin_detail"
      // is not literally in the pinned, first-key-only widget_order. Once the
      // catalog/consumer becomes value-aware this assertion (and therefore the
      // `it.fails`) should start passing normally.
      expect(rejected).toBeUndefined();
    },
  );
});
