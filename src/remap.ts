import type { WorkflowJSON, WorkflowNode } from "./types.js";

export interface RemapWorkflowIdsOptions {
  nodeIdStart: number;
  linkIdStart: number;
}

/** Remap only the top-level graph namespace; definition interiors are independent graphs. */
export function remapWorkflowIds(wf: WorkflowJSON, opts: RemapWorkflowIdsOptions): WorkflowJSON {
  const out = structuredClone(wf);
  const nodeIds = new Map<unknown, number>();
  const linkIds = new Map<unknown, number>();

  out.nodes.forEach((node, index) => nodeIds.set(node.id, opts.nodeIdStart + index));
  out.links.forEach((link, index) => {
    if (Array.isArray(link)) linkIds.set(link[0], opts.linkIdStart + index);
  });

  out.nodes = out.nodes.map((node): WorkflowNode => {
    const remapped = node as WorkflowNode;
    remapped.id = nodeIds.get(node.id)!;
    if (Array.isArray(remapped.inputs)) {
      for (const input of remapped.inputs) {
        if (typeof input === "object" && input !== null && "link" in input) {
          const record = input as { link?: unknown };
          if (linkIds.has(record.link)) record.link = linkIds.get(record.link);
        }
      }
    }
    if (Array.isArray(remapped.outputs)) {
      for (const output of remapped.outputs) {
        if (typeof output === "object" && output !== null && Array.isArray((output as { links?: unknown }).links)) {
          const record = output as { links: unknown[] };
          record.links = record.links.map((id) => linkIds.get(id) ?? id);
        }
      }
    }
    return remapped;
  });

  out.links = out.links.map((link) => {
    if (!Array.isArray(link)) return link;
    link[0] = linkIds.get(link[0]) ?? link[0];
    link[1] = nodeIds.get(link[1]) ?? link[1];
    link[3] = nodeIds.get(link[3]) ?? link[3];
    return link;
  });
  return out;
}
