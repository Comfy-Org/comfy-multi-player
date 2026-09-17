import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import {
  LEGACY_NODE_INCARNATION,
  NODE_INCARNATION_KEY,
  applyOps,
  mint,
  migrate,
  project,
  readStamps,
  type Op,
  type WorkflowJSON,
  type WorkflowNode,
} from "../src/index.js";
import { loadCatalog } from "./helpers.js";
import { rejectedOutcome } from "./apply-result-helpers.js";

const catalog = loadCatalog();
const id = (tag: string) => (tag + "0".repeat(32)).slice(0, 32);

function base(): WorkflowJSON {
  return {
    nodes: [{ id: 1, type: "CLIPTextEncode", pos: [0, 0], inputs: [], outputs: [], widgets_values: ["life-1"] }],
    links: [],
    last_node_id: 1,
    last_link_id: 0,
  };
}

function envelope(tag: string, actor: string, version: number) {
  return { op_id: id(tag), actor, base_version: version, stamp: [version, actor] as [number, string] };
}

function setWidget(tag: string, value: string, version: number, incarnation: string): Op {
  return {
    op: "set_widget",
    ...envelope(tag, `human:${tag}`, version),
    node_id: 1,
    widget: "text",
    value,
    node_incarnation: incarnation,
  };
}

function remove(): Op {
  return { op: "delete_node", ...envelope("delete", "agent:a", 10), node_id: 1, removed_links: [] };
}

function readd(): Op {
  return {
    op: "add_node",
    ...envelope("readd", "agent:a", 20),
    node_incarnation: id("readd"),
    node_id: 1,
    class_type: "CLIPTextEncode",
    pos: [0, 0],
    node: { ...base().nodes[0], widgets_values: ["life-2"] } as WorkflowNode,
  };
}

function fork(): Y.Doc {
  const source = mint(base(), catalog);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(source));
  source.destroy();
  return doc;
}

describe("incarnation-namespaced widget stamps (DQ-11)", () => {
  it("converges when a life-1 write arrives before or after delete/re-add", () => {
    const replacement = readd();
    const stale = setWidget("stale", "stale", 100, LEGACY_NODE_INCARNATION);
    const fresh = setWidget("fresh", "fresh", 30, replacement.op_id);
    const first = fork();
    const second = fork();

    expect(rejectedOutcome(applyOps(first, [stale, remove(), replacement, fresh], catalog))).toBeUndefined();
    expect(rejectedOutcome(applyOps(second, [remove(), stale, replacement, fresh], catalog))).toBeUndefined();
    expect(project(first, catalog)).toEqual(project(second, catalog));
    expect(project(first, catalog).nodes[0]?.widgets_values).toEqual(["fresh"]);
    expect(readStamps(first)[JSON.stringify(["widget", "1", replacement.op_id, "text"])])
      .toEqual([30, "human:fresh", fresh.op_id]);
    expect(readStamps(first)[JSON.stringify(["widget", "1", LEGACY_NODE_INCARNATION, "text"])])
      .toBeUndefined();
  });

  it("migrates v1 node lifetimes and widget stamp keys to legacy life 0", () => {
    const doc = mint(base(), catalog);
    const node = doc.getMap<Y.Map<unknown>>("nodes").get("1")!;
    node.delete(NODE_INCARNATION_KEY);
    const stamps = doc.getMap<unknown>("__stamps");
    const oldKey = JSON.stringify(["widget", "1", "text"]);
    stamps.set(oldKey, [7, "human:a", id("old")]);
    doc.getMap("meta").set("schema_version", 1);

    migrate(doc, 1);

    expect(doc.getMap("meta").get("schema_version")).toBe(2);
    expect(node.get(NODE_INCARNATION_KEY)).toBe(LEGACY_NODE_INCARNATION);
    expect(stamps.get(JSON.stringify(["widget", "1", LEGACY_NODE_INCARNATION, "text"]))).toEqual([
      7,
      "human:a",
      id("old"),
    ]);
    expect(stamps.has(oldKey)).toBe(false);
  });

  for (const legacyOrder of ["numeric-first", "string-first"] as const) {
    for (const winnerForm of ["numeric", "string"] as const) {
      it(`normalizes colliding numeric/string widget targets and keeps the ${winnerForm} LWW winner (${legacyOrder})`, () => {
        const doc = mint(base(), catalog);
        const stamps = doc.getMap<unknown>("__stamps");
        const numericKey = JSON.stringify(["widget", 1, "text"]);
        const stringKey = JSON.stringify(["widget", "1", "text"]);
        const migratedKey = JSON.stringify(["widget", "1", LEGACY_NODE_INCARNATION, "text"]);
        const winner = [8, "human:b", id("winner")] as const;
        const loser = [7, "human:a", id("loser")] as const;
        const entries = legacyOrder === "numeric-first"
          ? [[numericKey, winnerForm === "numeric" ? winner : loser], [stringKey, winnerForm === "string" ? winner : loser]] as const
          : [[stringKey, winnerForm === "string" ? winner : loser], [numericKey, winnerForm === "numeric" ? winner : loser]] as const;
        for (const [key, stamp] of entries) stamps.set(key, stamp);
        doc.getMap("meta").set("schema_version", 1);

        migrate(doc, 1);

        expect(stamps.get(migratedKey)).toEqual(winner);
        expect(stamps.has(numericKey)).toBe(false);
        expect(stamps.has(stringKey)).toBe(false);
      });
    }
  }

  for (const insertionOrder of ["legacy-first", "incumbent-first"] as const) {
    it.each([
      ["counter", [9, "human:a", id("aaa")], [8, "human:z", id("zzz")]],
      ["actor", [8, "human:z", id("aaa")], [8, "human:a", id("zzz")]],
      ["op_id", [8, "human:a", id("zzz")], [8, "human:a", id("aaa")]],
      ["counter (legacy wins)", [8, "human:z", id("zzz")], [9, "human:a", id("aaa")]],
      ["actor (legacy wins)", [8, "human:a", id("zzz")], [8, "human:z", id("aaa")]],
      ["op_id (legacy wins)", [8, "human:a", id("aaa")], [8, "human:a", id("zzz")]],
    ] as const)(`preserves the greater stamp against a normalized incumbent at the %s tier (${insertionOrder})`, (tier, incumbent, legacy) => {
      const doc = mint(base(), catalog);
      const stamps = doc.getMap<unknown>("__stamps");
      const oldKey = JSON.stringify(["widget", 1, "text"]);
      const migratedKey = JSON.stringify(["widget", "1", LEGACY_NODE_INCARNATION, "text"]);
      const entries = insertionOrder === "legacy-first"
        ? [[oldKey, legacy], [migratedKey, incumbent]] as const
        : [[migratedKey, incumbent], [oldKey, legacy]] as const;
      for (const [key, stamp] of entries) stamps.set(key, stamp);
      doc.getMap("meta").set("schema_version", 1);

      migrate(doc, 1);

      expect(stamps.get(migratedKey)).toEqual(tier.endsWith("(legacy wins)") ? legacy : incumbent);
      expect(stamps.has(oldKey)).toBe(false);
    });
  }

  it.each([
    ["null node id", ["widget", null, "text"]],
    ["boolean node id", ["widget", true, "text"]],
    ["object node id", ["widget", { id: 1 }, "text"]],
    ["non-string widget name", ["widget", 1, false]],
  ])("does not normalize a malformed legacy widget key with %s", (_label, target) => {
    const doc = mint(base(), catalog);
    const stamps = doc.getMap<unknown>("__stamps");
    const malformedKey = JSON.stringify(target);
    const value = [9, "human:z", id("malformed")] as const;
    stamps.set(malformedKey, value);
    doc.getMap("meta").set("schema_version", 1);

    migrate(doc, 1);

    expect(stamps.get(malformedKey)).toEqual(value);
    expect(stamps.has(JSON.stringify(["widget", String(target[1]), LEGACY_NODE_INCARNATION, target[2]]))).toBe(false);
  });

  it("keeps a malformed legacy stamp at its original key instead of comparing or deleting it", () => {
    const doc = mint(base(), catalog);
    const stamps = doc.getMap<unknown>("__stamps");
    const oldKey = JSON.stringify(["widget", 1, "text"]);
    stamps.set(oldKey, ["not-a-counter", "human:a", id("malformed")]);
    doc.getMap("meta").set("schema_version", 1);

    migrate(doc, 1);

    expect(stamps.get(oldKey)).toEqual(["not-a-counter", "human:a", id("malformed")]);
    expect(stamps.has(JSON.stringify(["widget", "1", LEGACY_NODE_INCARNATION, "text"]))).toBe(false);
  });

  it("replaces a malformed colliding target with a valid legacy stamp", () => {
    const doc = mint(base(), catalog);
    const stamps = doc.getMap<unknown>("__stamps");
    const oldKey = JSON.stringify(["widget", 1, "text"]);
    const migratedKey = JSON.stringify(["widget", "1", LEGACY_NODE_INCARNATION, "text"]);
    const valid = [8, "human:b", id("valid")] as const;
    stamps.set(migratedKey, ["not-a-counter"]);
    stamps.set(oldKey, valid);
    doc.getMap("meta").set("schema_version", 1);

    migrate(doc, 1);

    expect(stamps.get(migratedKey)).toEqual(valid);
    expect(stamps.has(oldKey)).toBe(false);
  });
});
