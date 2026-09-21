/**
 * REPRO ONLY — this test is expected to FAIL until `remapGraph` rewrites a
 * subgraph definition's own top-level `inputs[].linkIds`. No fix is included.
 *
 * `remapInsertedWorkflowIds` derives new ids for everything an insertion op
 * carries, and `remapGraph` rewrites interior `nodes[].inputs[].link`,
 * `nodes[].outputs[].links[]`, the `links` entries' own ids, and `groups` ids.
 * It never touches `graph["inputs"]` — a subgraph DEFINITION's own promoted
 * (exposed-widget) declarations, each of which carries a `linkIds` array
 * naming the interior links that feed that promoted input. `mintDefinition`
 * stores the `inputs` array verbatim, so after an `insert_workflow` the
 * definition lands in the document with `links` keyed by the NEW derived ids
 * while `inputs[].linkIds` still names the OLD pre-remap ids.
 *
 * Downstream (ComfyUI_frontend, `agentSubgraphHostSlots.ts`)
 * `promotedWidgetNames()` resolves each `inputs[].linkIds` entry against the
 * definition's own `links` and silently treats a miss as "not promoted", so
 * every declared input reports as unpromoted and the definition promotes 0
 * widgets while the host node's opaque `widgets_values` still carries the
 * blueprint's N values. That mismatch is what the staging telemetry reports as
 * "... carries 13 opaque widget values but its definition promotes 0".
 */
import { describe, expect, it } from "vitest";

import { remapInsertedWorkflowIds } from "../src/remap.js";
import type { WorkflowJSON } from "../src/index.js";

const DEF = "promoted-text-def";
/** The interior link that feeds the promoted `text` widget. */
const INTERIOR_LINK_ID = 34;

type RemappedDefinition = {
  id: unknown;
  inputs: Array<{ name: string; linkIds: unknown[] }>;
  nodes: Array<{ id: unknown; inputs?: Array<{ link: unknown }>; outputs?: Array<{ links: unknown[] }> }>;
  links: Array<{ id: unknown }>;
};

/**
 * One subgraph definition with one promoted input, wired by one interior link
 * whose endpoints are both interior nodes (so the link survives the
 * dangling-link drop and the only thing under test is the id rewrite).
 */
function promotedBlueprint(): WorkflowJSON {
  return {
    last_node_id: 100,
    last_link_id: INTERIOR_LINK_ID,
    nodes: [
      {
        id: 100,
        type: DEF,
        inputs: [{ name: "text", type: "STRING", link: null, widget: { name: "text" } }],
        outputs: [],
        widgets_values: ["a prompt from the blueprint"],
      },
    ],
    links: [],
    definitions: {
      subgraphs: [
        {
          id: DEF,
          name: "Promoted text",
          inputs: [{ name: "text", type: "STRING", linkIds: [INTERIOR_LINK_ID] }],
          outputs: [],
          nodes: [
            { id: 10, type: "PrimitiveString", inputs: [], outputs: [{ name: "STRING", type: "STRING", links: [INTERIOR_LINK_ID] }] },
            {
              id: 11,
              type: "CLIPTextEncode",
              inputs: [{ name: "text", type: "STRING", link: INTERIOR_LINK_ID, widget: { name: "text" } }],
              outputs: [],
            },
          ],
          links: [{ id: INTERIOR_LINK_ID, origin_id: 10, origin_slot: 0, target_id: 11, target_slot: 0, type: "STRING" }],
        },
      ],
    },
  } as unknown as WorkflowJSON;
}

function remappedDefinition(opId: string): RemappedDefinition {
  const remapped = remapInsertedWorkflowIds(promotedBlueprint(), opId) as unknown as {
    definitions: { subgraphs: RemappedDefinition[] };
  };
  return remapped.definitions.subgraphs[0]!;
}

describe("insert_workflow remap keeps a definition's promoted inputs wired", () => {
  it("rewrites inputs[].linkIds to the remapped interior link ids", () => {
    const definition = remappedDefinition("promoted-linkids-op".padEnd(32, "0"));

    // Preconditions: the interior link survived and was given a new derived id.
    expect(definition.links).toHaveLength(1);
    expect(definition.links[0]!.id).not.toBe(INTERIOR_LINK_ID);
    expect(definition.nodes[1]!.inputs![0]!.link).toBe(definition.links[0]!.id);

    // The defect: the promoted input still names the pre-remap link id, so it
    // resolves against nothing in the definition's own remapped `links`.
    const remappedLinkIds = new Set(definition.links.map((link) => String(link.id)));
    expect(definition.inputs[0]!.linkIds.map(String)).toEqual([String(definition.links[0]!.id)]);
    for (const linkId of definition.inputs[0]!.linkIds) {
      expect(remappedLinkIds.has(String(linkId))).toBe(true);
    }
  });
});
