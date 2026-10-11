import * as Y from "yjs";
import { OPAQUE_WIDGETS_KEY, ROOT_DEFINITIONS, ROOT_LINK_STATE, ROOT_NODES, nodeIncarnation } from "./doc.js";
import { DYNAMIC_GROUP_SLOT_KEY, DYNAMIC_GROUP_STATE_KEY, type WorkflowJSON, type WorkflowNode } from "./types.js";
import { activeRowGroups, rowInputProjection, rowSlot, type RowInputProjection, type RowInputMarker } from "./dynamic-row-state.js";
import { dynamicGroupRowsOf } from "./dynamic-group-rows.js";

interface InputChange { name: string; widget?: string | null; index: number | null }
export interface DefinitionRowView {
  original: Record<string, unknown>[];
  changes: InputChange[];
  widget_indices: number[];
  proxy_names: Map<string, string | null>;
}

interface LinkFields { id: unknown; from: unknown; fromSlot: number; to: unknown; toSlot: number }

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function linkFields(value: unknown): LinkFields | null {
  if (Array.isArray(value)) return { id: value[0], from: value[1], fromSlot: value[2] as number, to: value[3], toSlot: value[4] as number };
  const data = record(value);
  return data ? { id: data["id"], from: data["origin_id"], fromSlot: data["origin_slot"] as number, to: data["target_id"], toSlot: data["target_slot"] as number } : null;
}

function updateLink(value: unknown, fromSlot: number, toSlot: number): unknown {
  if (Array.isArray(value)) {
    const result = [...value]; result[2] = fromSlot; result[4] = toSlot; return result;
  }
  return { ...record(value), origin_slot: fromSlot, target_slot: toSlot };
}

function root(doc: Y.Doc, key: string): Y.Map<unknown> | undefined {
  return doc.share.has(key) ? doc.getMap(key) : undefined;
}

function rawInputs(node: Y.Map<unknown>): unknown[] {
  const inputs = node.get("inputs");
  return inputs instanceof Y.Array ? inputs.toArray().map((slot) => {
    const data = slot instanceof Y.Map ? slot.toJSON() as Record<string, unknown> : slot;
    const marker = record(data)?.[DYNAMIC_GROUP_SLOT_KEY] as RowInputMarker | undefined;
    if (!marker) return data;
    return rowSlot(activeRowGroups(node).get(marker.group)?.records.get(marker.row_id), marker.field)?.data;
  }) : [];
}

function allDefinitions(doc: Y.Doc): Map<string, Y.Map<unknown>> {
  const definitions = new Map<string, Y.Map<unknown>>();
  function visit(value: unknown): void {
    if (!(value instanceof Y.Map)) return;
    const id = String(value.get("id"));
    if (definitions.has(id)) return;
    definitions.set(id, value);
    const nested = value.get("definitions");
    const children = nested instanceof Y.Map ? nested.get("subgraphs") : undefined;
    if (children instanceof Y.Map) children.forEach(visit);
  }
  root(doc, ROOT_DEFINITIONS)?.forEach(visit);
  return definitions;
}

function projectedDefinitions(workflow: WorkflowJSON): Map<string, Record<string, unknown>> {
  const result = new Map<string, Record<string, unknown>>();
  function visit(value: unknown): void {
    const definition = record(value);
    if (!definition) return;
    result.set(String(definition["id"]), definition);
    const children = record(definition["definitions"])?.["subgraphs"];
    if (Array.isArray(children)) children.forEach(visit);
  }
  workflow.definitions?.subgraphs?.forEach(visit);
  return result;
}

function matchingInput(input: Record<string, unknown>, view: DefinitionRowView): number {
  const byId = input["id"] === undefined ? -1 : view.original.findIndex((slot) => slot["id"] === input["id"]);
  if (byId >= 0) return byId;
  const matches = view.original.map((slot, index) => slot["name"] === input["name"] ? index : -1).filter((index) => index >= 0);
  if (matches.length > 1) throw new TypeError("DynamicGroup: ambiguous promoted input name");
  return matches[0] ?? -1;
}

function hostWidgetValues(node: WorkflowNode, view: DefinitionRowView): void {
  if (!Array.isArray(node.widgets_values) || node.widgets_values.length === 0) return;
  const proxies = record(node["properties"])?.["proxyWidgets"];
  if (Array.isArray(proxies) && proxies.length === node.widgets_values.length) {
    node.widgets_values = node.widgets_values.filter((_value, index) => {
      const pair = proxies[index] as unknown;
      return !Array.isArray(pair) || view.proxy_names.get(JSON.stringify(pair.map(String))) !== null;
    });
    return;
  }
  const order = node.widgets_values.length === view.original.length ? view.original.map((_slot, index) => index) : view.widget_indices;
  node.widgets_values = node.widgets_values.filter((_value, index) => {
    const slot = order[index];
    return slot === undefined || view.changes[slot]?.index !== null;
  });
}

/** Project row-aware topology from stable addresses without changing stored indices. */
export function projectRowTopology(doc: Y.Doc, workflow: WorkflowJSON): WorkflowJSON {
  const defs = allDefinitions(doc);
  const sources = [root(doc, ROOT_NODES), ...[...defs.values()].map((definition) => definition.get("nodes"))];
  if (!sources.some((nodes) => nodes instanceof Y.Map && [...nodes.values()].some((node) => node instanceof Y.Map && node.has(DYNAMIC_GROUP_STATE_KEY)))) return workflow;
  const projected = projectedDefinitions(workflow);
  const views = new Map<string, DefinitionRowView>();
  const visiting = new Set<string>();

  function definitionFor(type: unknown): Y.Map<unknown> | undefined {
    const direct = defs.get(String(type));
    if (direct) return direct;
    const byName = [...defs.values()].filter((definition) => definition.get("name") === type);
    return byName.length === 1 ? byName[0] : undefined;
  }

  function processDefinition(definition: Y.Map<unknown>): DefinitionRowView {
    const id = String(definition.get("id"));
    const cached = views.get(id);
    if (cached) return cached;
    const raw = definition.get("inputs");
    const original = Array.isArray(raw) ? raw.map((slot) => record(slot) ?? {}) : [];
    const empty: DefinitionRowView = { original, changes: original.map((slot, index) => ({ name: String(slot["name"] ?? ""), index })), widget_indices: [], proxy_names: new Map() };
    if (visiting.has(id)) return empty;
    visiting.add(id);
    const output = projected.get(id);
    if (!output) { views.set(id, empty); visiting.delete(id); return empty; }
    const sourceNodes = definition.get("nodes") as Y.Map<Y.Map<unknown>>;
    const sourceLinks = definition.get("links") as Y.Map<unknown>;
    const nodeViews = processNodes(sourceNodes, output["nodes"] as WorkflowNode[] ?? []);
    const inputNode = record(definition.get("inputNode"));
    const boundary = inputNode?.["id"] ?? -10;
    const oldLinks = [...sourceLinks.values()];
    const affected = new Set<string>();
    const oldWidgetNames = new Map<number, string>();
    for (const value of oldLinks) {
      const link = linkFields(value);
      if (!link || String(link.from) !== String(boundary)) continue;
      const target = sourceNodes.get(String(link.to));
      const input = target ? record(rawInputs(target)[link.toSlot]) : null;
      const widget = record(input?.["widget"]);
      if (typeof widget?.["name"] === "string") oldWidgetNames.set(link.fromSlot, widget["name"]);
    }
    const first = rewriteLinks(output["links"] as unknown[] ?? [], nodeViews, affected, sourceNodes, definition.get(ROOT_LINK_STATE) as Y.Map<unknown> | undefined);
    const dropped = new Set(oldLinks.filter((value) => {
      const id = linkFields(value)?.id;
      return String(linkFields(value)?.from) === String(boundary) && !first.some((candidate) => String(linkFields(candidate)?.id) === String(id));
    }).map((value) => linkFields(value)!.fromSlot));
    const hasBacking = new Set(first.filter((value) => String(linkFields(value)?.from) === String(boundary)).map((value) => linkFields(value)!.fromSlot));
    const changes: InputChange[] = [];
    const nextInputs: Record<string, unknown>[] = [];
    original.forEach((slot, index) => {
      const name = String(slot["name"] ?? "");
      if (dropped.has(index) && !hasBacking.has(index)) {
        changes.push({ name, index: null, widget: null });
        return;
      }
      let widget: string | undefined;
      for (const value of oldLinks) {
        const link = linkFields(value);
        if (!link || String(link.from) !== String(boundary) || link.fromSlot !== index) continue;
        const before = oldWidgetNames.get(index);
        const view = nodeViews.get(String(link.to));
        if (before && view?.renames.has(before)) widget = view.renames.get(before) ?? undefined;
      }
      const renamed = widget && name === oldWidgetNames.get(index) ? widget : name;
      const links = first.filter((value) => { const link = linkFields(value); return link && String(link.from) === String(boundary) && link.fromSlot === index; });
      const next = structuredClone(slot);
      next["name"] = renamed;
      if (Array.isArray(slot["linkIds"])) next["linkIds"] = links.map((value) => linkFields(value)!.id);
      changes.push({ name: renamed, index: nextInputs.length, ...(widget ? { widget } : {}) });
      nextInputs.push(next);
    });
    const finalLinks = first.flatMap((value) => {
      const link = linkFields(value)!;
      if (String(link.from) !== String(boundary)) return [value];
      const index = changes[link.fromSlot]?.index;
      if (index === null) { affected.add(String(link.id)); return []; }
      return [updateLink(value, index ?? link.fromSlot, link.toSlot)];
    });
    if (Array.isArray(output["inputs"])) output["inputs"] = nextInputs;
    output["links"] = finalLinks;
    transformExposures(output, nodeViews);
    synchronizeRefs(output["nodes"] as WorkflowNode[] ?? [], finalLinks, affected, nodeViews);
    const proxyNames = new Map<string, string | null>();
    for (const [nodeId, view] of nodeViews) for (const [name, next] of view.renames) proxyNames.set(JSON.stringify([nodeId, name]), next);
    const view = { original, changes, widget_indices: [...oldWidgetNames.keys()].sort((a, b) => a - b), proxy_names: proxyNames };
    views.set(id, view);
    visiting.delete(id);
    return view;
  }

  function processNodes(source: Y.Map<Y.Map<unknown>>, nodes: WorkflowNode[]): Map<string, RowInputProjection> {
    const result = new Map<string, RowInputProjection>();
    for (const output of nodes) {
      const input = source.get(String(output.id));
      if (!input) continue;
      const base = rowInputProjection(input);
      const definition = definitionFor(input.get("type"));
      if (definition) {
        const child = processDefinition(definition);
        const raw = rawInputs(input);
        const next: unknown[] = [];
        const indices = new Map<number, number>();
        raw.forEach((value, index) => {
          const slot = record(value);
          if (!slot) { indices.set(index, next.length); next.push(value); return; }
          const oldIndex = matchingInput(slot, child);
          const change = child.changes[oldIndex];
          if (change?.index === null) {
            const oldWidget = record(slot["widget"])?.["name"];
            if (typeof oldWidget === "string") base.renames.set(oldWidget, null);
            return;
          }
          const updated = structuredClone(slot);
          if (change) {
            updated["name"] = change.name;
            if (change.widget && record(updated["widget"])) updated["widget"] = { ...record(updated["widget"]), name: change.widget };
            const oldWidget = record(slot["widget"])?.["name"];
            if (typeof oldWidget === "string" && change.widget) base.renames.set(oldWidget, change.widget);
          }
          indices.set(index, next.length);
          next.push(updated);
        });
        base.inputs = next;
        base.indices = indices;
        hostWidgetValues(output, child);
        const properties = record(output["properties"]);
        if (Array.isArray(properties?.["proxyWidgets"])) properties["proxyWidgets"] = (properties["proxyWidgets"] as unknown[]).flatMap((pair) => {
          if (!Array.isArray(pair)) return [pair];
          const key = JSON.stringify(pair.map(String));
          if (!child.proxy_names.has(key)) return [pair];
          const name = child.proxy_names.get(key);
          return name === null ? [] : [[pair[0], name]];
        });
      }
      if (output.inputs !== undefined) output.inputs = base.inputs;
      result.set(String(output.id), base);
    }
    for (const output of nodes) {
      const properties = record(output["properties"]);
      if (!properties || !Array.isArray(properties["proxyWidgets"])) continue;
      properties["proxyWidgets"] = (properties["proxyWidgets"] as unknown[]).flatMap((pair) => {
        if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[1] !== "string") return [pair];
        const names = result.get(String(pair[0]))?.renames;
        if (!names?.has(pair[1])) return [pair];
        const name = names.get(pair[1]);
        return name === null ? [] : [[pair[0], name]];
      });
    }
    return result;
  }

  function transformExposures(graph: Record<string, unknown>, nodes: Map<string, RowInputProjection>): void {
    if (!Array.isArray(graph["widgets"])) return;
    graph["widgets"] = (graph["widgets"] as unknown[]).flatMap((value) => {
      const exposed = record(value);
      if (!exposed || typeof exposed["name"] !== "string") return [value];
      const names = nodes.get(String(exposed["id"]))?.renames;
      if (!names?.has(exposed["name"])) return [value];
      const name = names.get(exposed["name"]);
      return name === null ? [] : [{ ...exposed, name }];
    });
  }

  function rewriteLinks(links: unknown[], nodes: Map<string, RowInputProjection>, affected: Set<string>, source: Y.Map<Y.Map<unknown>>, states?: Y.Map<unknown>): unknown[] {
    return links.flatMap((value) => {
      const link = linkFields(value);
      if (!link) return [value];
      const view = nodes.get(String(link.to));
      if (!view) return [value];
      const state = record(states?.get(String(link.id)));
      const destination = record(state?.["destination"]);
      const row = destination?.["kind"] === "dynamic_group";
      const target = source.get(String(link.to));
      if (row && target && nodeIncarnation(target) !== destination["node_incarnation"]) { affected.add(String(link.id)); return []; }
      const index = row ? view.rows.get(JSON.stringify([destination["group"], destination["row_id"], destination["field"]])) : view.indices.get(link.toSlot);
      const original = source.get(String(link.to));
      const originalCount = original ? rawInputs(original).length : 0;
      if (index === undefined && !row && (link.toSlot >= originalCount || link.toSlot < 0)) return [value];
      if (index === undefined) { affected.add(String(link.id)); return []; }
      return [updateLink(value, link.fromSlot, index)];
    });
  }

  function synchronizeRefs(nodes: WorkflowNode[], links: unknown[], affected: Set<string>, views: Map<string, RowInputProjection>): void {
    const live = new Set(links.map((value) => String(linkFields(value)?.id)));
    for (const node of nodes) {
      synchronizeInputs(node, links, live, affected, views.get(String(node.id)));
      synchronizeOutputs(node, live, affected);
    }
  }
  function synchronizeInputs(node: WorkflowNode, links: unknown[], live: Set<string>, affected: Set<string>, view?: RowInputProjection): void {
    if (!Array.isArray(node.inputs)) return;
    for (const value of node.inputs) {
      const slot = record(value);
      if (slot && affected.has(String(slot["link"])) && !live.has(String(slot["link"]))) slot["link"] = null;
    }
    for (const index of view?.rows.values() ?? []) {
      const slot = record(node.inputs[index]);
      const occupant = links.map(linkFields).find((link) => link && String(link.to) === String(node.id) && link.toSlot === index);
      if (slot) slot["link"] = occupant?.id ?? null;
    }
  }
  function synchronizeOutputs(node: WorkflowNode, live: Set<string>, affected: Set<string>): void {
    if (!Array.isArray(node.outputs)) return;
    for (const value of node.outputs) {
      const slot = record(value);
      if (Array.isArray(slot?.["links"])) slot["links"] = (slot["links"] as unknown[]).filter((id) => !affected.has(String(id)) || live.has(String(id)));
    }
  }

  const nodes = root(doc, ROOT_NODES) as Y.Map<Y.Map<unknown>> | undefined;
  if (nodes) {
    const nodeViews = processNodes(nodes, workflow.nodes);
    const affected = new Set<string>();
    workflow.links = rewriteLinks(workflow.links, nodeViews, affected, nodes, root(doc, ROOT_LINK_STATE));
    synchronizeRefs(workflow.nodes, workflow.links, affected, nodeViews);
  }
  for (const definition of defs.values()) processDefinition(definition);
  return workflow;
}

/** Minimal topology source for the catalog-free follower snapshot. */
export function rowTopologySnapshot(doc: Y.Doc): WorkflowJSON | null {
  if (![...doc.store.clients.values()].some((structs) => structs.length > 0)) return null;
  const definitions = allDefinitions(doc);
  const graphs = [root(doc, ROOT_NODES), ...[...definitions.values()].map((definition) => definition.get("nodes"))];
  if (!graphs.some((nodes) => nodes instanceof Y.Map && [...nodes.values()].some((node) => node instanceof Y.Map && node.has(DYNAMIC_GROUP_STATE_KEY)))) return null;
  function nodeData(node: Y.Map<unknown>, id: string): WorkflowNode {
    const data: WorkflowNode = { id, type: String(node.get("type")) };
    for (const key of ["inputs", "outputs"]) {
      const values = node.get(key);
      if (values instanceof Y.Array) data[key] = values.toArray().map((value) => value instanceof Y.Map ? structuredClone(value.toJSON()) : structuredClone(value));
    }
    if (node.has("properties")) data["properties"] = structuredClone(node.get("properties"));
    if (node.has(OPAQUE_WIDGETS_KEY)) data.widgets_values = structuredClone(node.get(OPAQUE_WIDGETS_KEY)) as unknown[];
    return data;
  }
  function graphData(nodes: unknown, links: unknown): WorkflowJSON {
    const result: WorkflowJSON = { nodes: [], links: [] };
    if (nodes instanceof Y.Map) nodes.forEach((node, id) => { if (node instanceof Y.Map) result.nodes.push(nodeData(node, id)); });
    if (links instanceof Y.Map) result.links = [...links.values()].map((link) => structuredClone(link));
    return result;
  }
  const result = graphData(root(doc, ROOT_NODES), root(doc, "links"));
  result.definitions = { subgraphs: [...definitions.values()].map((definition) => {
    const graph = graphData(definition.get("nodes"), definition.get("links"));
    return { ...graph, id: definition.get("id"), inputNode: structuredClone(definition.get("inputNode")), inputs: structuredClone(definition.get("inputs")), widgets: structuredClone(definition.get("widgets")) };
  }) };
  return projectRowTopology(doc, result);
}

/** Baseline host inputs whose backing address depends on a DynamicGroup row. */
export function rowControlledHostInputs(doc: Y.Doc, host: Y.Map<unknown>): number[] {
  const definitions = allDefinitions(doc);
  const visiting = new Set<Y.Map<unknown>>();
  function controlled(node: Y.Map<unknown>, index: number): boolean {
    const inputs = node.get("inputs");
    const raw = inputs instanceof Y.Array ? inputs.get(index) : undefined;
    const slot = raw instanceof Y.Map ? raw.toJSON() as Record<string, unknown> : record(raw);
    if (slot?.[DYNAMIC_GROUP_SLOT_KEY]) return true;
    const name = record(slot?.["widget"])?.["name"];
    const rows = dynamicGroupRowsOf(node.get("properties"));
    if (rows && typeof name === "string" && Object.keys(rows).some((group) => name.startsWith(`${group}.`) && /^(0|[1-9]\d*)\./.test(name.slice(group.length + 1)))) return true;
    const child = definitions.get(String(node.get("type")));
    const declared = child?.get("inputs");
    if (!child || !Array.isArray(declared)) return false;
    return declared.some((input, ordinal) => record(input)?.["name"] === slot?.["name"] && fromDefinition(child, ordinal));
  }
  function fromDefinition(definition: Y.Map<unknown>, index: number): boolean {
    if (visiting.has(definition)) return false;
    visiting.add(definition);
    try {
      const nodes = definition.get("nodes");
      const links = definition.get("links");
      const boundary = record(definition.get("inputNode"))?.["id"] ?? -10;
      if (!(nodes instanceof Y.Map) || !(links instanceof Y.Map)) return false;
      return [...links.values()].some((value) => {
        const link = linkFields(value);
        const node = link ? nodes.get(String(link.to)) : undefined;
        return link && String(link.from) === String(boundary) && link.fromSlot === index && node instanceof Y.Map && controlled(node, link.toSlot);
      });
    } finally { visiting.delete(definition); }
  }
  const definition = definitions.get(String(host.get("type")));
  const inputs = definition?.get("inputs");
  return definition && Array.isArray(inputs) ? inputs.map((_input, index) => index).filter((index) => fromDefinition(definition, index)) : [];
}

/** Resolve a promoted field to its immutable baseline host-value position. */
export function promotedRowValueIndex(doc: Y.Doc, host: Y.Map<unknown>, target: Y.Map<unknown>, group: string, rowId: string, field: string): number | null {
  const definitions = allDefinitions(doc);
  const visiting = new Set<Y.Map<unknown>>();
  function matches(node: Y.Map<unknown>, inputIndex: number): boolean {
    if (node === target) {
      const source = node.get("inputs");
      const slot = source instanceof Y.Array ? source.get(inputIndex) : undefined;
      const data = slot instanceof Y.Map ? slot.toJSON() as Record<string, unknown> : record(slot);
      const marker = data?.[DYNAMIC_GROUP_SLOT_KEY] as RowInputMarker | undefined;
      if (marker) return marker.group === group && marker.row_id === rowId && marker.field === field;
      const ids = record(node.get("properties"))?.["dynamicGroupRows"];
      const list = record(ids)?.[group];
      const index = Array.isArray(list) ? list.indexOf(rowId) : -1;
      return index >= 0 && record(data?.["widget"])?.["name"] === `${group}.${String(index)}.${field}`;
    }
    const definition = definitions.get(String(node.get("type")));
    if (!definition || visiting.has(definition)) return false;
    const inputs = rawInputs(node);
    const name = record(inputs[inputIndex])?.["name"];
    const declared = definition.get("inputs");
    const indices = Array.isArray(declared) ? declared.map((value, index) => record(value)?.["name"] === name ? index : -1).filter((index) => index >= 0) : [];
    return indices.some((index) => fromDefinition(definition, index));
  }
  function fromDefinition(definition: Y.Map<unknown>, index: number): boolean {
    visiting.add(definition);
    try {
      const nodes = definition.get("nodes");
      const links = definition.get("links");
      if (!(nodes instanceof Y.Map) || !(links instanceof Y.Map)) return false;
      const boundary = record(definition.get("inputNode"))?.["id"] ?? -10;
      return [...links.values()].some((value) => {
        const link = linkFields(value);
        const child = link ? nodes.get(String(link.to)) : undefined;
        return link && String(link.from) === String(boundary) && link.fromSlot === index && child instanceof Y.Map && matches(child, link.toSlot);
      });
    } finally { visiting.delete(definition); }
  }
  const definition = definitions.get(String(host.get("type")));
  const declared = definition?.get("inputs");
  if (!definition || !Array.isArray(declared)) return null;
  const proxies = record(host.get("properties"))?.["proxyWidgets"];
  const values = host.get(OPAQUE_WIDGETS_KEY);
  if (Array.isArray(proxies) && Array.isArray(values) && proxies.length === values.length) {
    return promotedProxyIndex(definition, proxies, matches);
  }
  const indices = declared.map((_input, index) => index).filter((index) => fromDefinition(definition, index));
  if (indices.length > 1) throw new TypeError("DynamicGroup: promoted row field has ambiguous host bindings");
  const index = indices[0];
  if (index === undefined) return null;
  if (Array.isArray(values) && values.length === declared.length) return index;
  const rank = widgetBackedPortIndices(definition).indexOf(index);
  return rank < 0 ? null : rank;
}

function widgetBackedPortIndices(definition: Y.Map<unknown>): number[] {
  const nodes = definition.get("nodes");
  const links = definition.get("links");
  if (!(nodes instanceof Y.Map) || !(links instanceof Y.Map)) return [];
  const boundary = record(definition.get("inputNode"))?.["id"] ?? -10;
  const backed = new Set<number>();
  for (const value of links.values()) {
    const link = linkFields(value);
    const child = link ? nodes.get(String(link.to)) : undefined;
    if (!link || String(link.from) !== String(boundary) || !(child instanceof Y.Map)) continue;
    const input = record(rawInputs(child)[link.toSlot]);
    if (record(input?.["widget"])) backed.add(link.fromSlot);
  }
  return [...backed].sort((a, b) => a - b);
}

function promotedProxyIndex(definition: Y.Map<unknown>, proxies: unknown[], matches: (node: Y.Map<unknown>, index: number) => boolean): number | null {
  const nodes = definition.get("nodes");
  if (!(nodes instanceof Y.Map)) return null;
  const bound = proxies.map((pair, ordinal) => {
    if (!Array.isArray(pair)) return -1;
    const child = nodes.get(String(pair[0]));
    if (!(child instanceof Y.Map)) return -1;
    return rawInputs(child).some((input, index) => record(input)?.["name"] === pair[1] && matches(child, index)) ? ordinal : -1;
  }).filter((index) => index >= 0);
  return bound.length === 1 ? bound[0]! : null;
}
