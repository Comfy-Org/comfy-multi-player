import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  SCHEMA_VERSION,
  createNodeMap,
  initDoc,
  linksMap,
  metaMap,
  nodesMap,
} from "../src/index.js";

describe("schema", () => {
  it("pins SCHEMA_VERSION at 1", () => {
    expect(SCHEMA_VERSION).toBe(1);
  });

  it("initDoc creates the v1 layout: nodes/links/meta with seeded meta", () => {
    const doc = initDoc(new Y.Doc());
    expect(nodesMap(doc)).toBeInstanceOf(Y.Map);
    expect(linksMap(doc)).toBeInstanceOf(Y.Map);
    const meta = metaMap(doc);
    expect(meta.get("schema_version")).toBe(SCHEMA_VERSION);
    expect(meta.get("last_node_id")).toBe(0);
    expect(meta.get("last_link_id")).toBe(0);
    expect(meta.get("extra")).toBeInstanceOf(Y.Map);
  });

  it("initDoc is idempotent", () => {
    const doc = initDoc(new Y.Doc());
    metaMap(doc).set("last_node_id", 7);
    initDoc(doc);
    expect(metaMap(doc).get("last_node_id")).toBe(7);
  });

  it("createNodeMap builds the per-node map with widgets_values as Y.Array", () => {
    const doc = initDoc(new Y.Doc());
    const node = createNodeMap({
      id: "57:3",
      type: "KSampler",
      pos: [420, 180],
      flags: { collapsed: false },
      widgets_values: [123, "euler", 20],
    });
    nodesMap(doc).set("57:3", node);

    const stored = nodesMap(doc).get("57:3")!;
    expect(stored.get("type")).toBe("KSampler");
    expect(stored.get("pos")).toEqual([420, 180]);
    expect(stored.get("flags")).toBeInstanceOf(Y.Map);
    const widgets = stored.get("widgets_values") as Y.Array<unknown>;
    expect(widgets).toBeInstanceOf(Y.Array);
    expect(widgets.toArray()).toEqual([123, "euler", 20]);
  });
});
