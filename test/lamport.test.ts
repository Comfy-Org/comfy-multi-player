import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import {
  LAMPORT_SCHEMA_VERSION,
  MAX_LAMPORT_COUNTER,
  applyLamportOps,
  freezeLamportEnvelope,
  mintLamport,
  observeLamport,
  persistLamportTick,
  projectLamport,
  tickLamport,
  type LamportClockStore,
  type LamportOp,
} from "../src/index.js";
import { loadCatalog } from "./helpers.js";

const catalog = loadCatalog();
const workflow = {
  nodes: [{ id: 1, type: "KSampler", widgets_values: ["seed"] }],
  links: [],
};

function write(id: string, counter: number, actor: string, value: string): LamportOp {
  return {
    op: "set_widget",
    op_id: id.repeat(32),
    actor,
    ordering: { kind: "lamport", counter },
    node_id: 1,
    node_incarnation: "0",
    widget: "seed",
    value,
  };
}

describe("native Lamport lineage", () => {
  it("converges by counter, actor, and op-id while preserving DQ-11 target identity", () => {
    const snapshot = Y.encodeStateAsUpdate(mintLamport(workflow, catalog));
    const a = new Y.Doc();
    const b = new Y.Doc();
    Y.applyUpdate(a, snapshot);
    Y.applyUpdate(b, snapshot);
    const low = write("a", 7, "human:a", "low");
    const high = write("b", 7, "human:b", "high");
    expect(applyLamportOps(a, [low, high], catalog).outcomes.every((o) => o.outcome !== "rejected")).toBe(true);
    expect(applyLamportOps(b, [high, low], catalog).outcomes.every((o) => o.outcome !== "rejected")).toBe(true);
    expect(projectLamport(a, catalog)).toEqual(projectLamport(b, catalog));
    expect(projectLamport(a, catalog).nodes[0]!.widgets_values).toEqual(["high"]);
    expect(a.getMap("meta").get("clock_max")).toBe(7);
  });

  it("advances clock_max for an admitted LWW drop and semantic no-op", () => {
    const doc = mintLamport(workflow, catalog);
    applyLamportOps(doc, [write("a", 10, "z", "winner")], catalog);
    const dropped = write("b", 11, "a", "causally-later");
    // Counter wins even though actor is lower.
    expect(applyLamportOps(doc, [dropped], catalog).outcomes[0]!.outcome).toBe("applied");
    const missing = { ...write("c", 12, "a", "missing"), node_id: 999 };
    expect(applyLamportOps(doc, [missing], catalog).outcomes[0]!.outcome).toBe("no-op");
    expect(doc.getMap("meta").get("clock_max")).toBe(12);
  });

  it("commits the semantic mutation, clock floor, and dedupe record in one update", () => {
    const doc = mintLamport(workflow, catalog);
    const bootstrap = Y.encodeStateAsUpdate(doc);
    const updates: Uint8Array[] = [];
    doc.on("update", (update) => updates.push(update));
    applyLamportOps(doc, [write("a", 5, "a", "atomic")], catalog);
    expect(updates).toHaveLength(1);
    const replica = new Y.Doc();
    Y.applyUpdate(replica, bootstrap);
    Y.applyUpdate(replica, updates[0]!);
    expect(replica.getMap("meta").get("clock_max")).toBe(5);
    expect(replica.getMap("__applied").has("a".repeat(32))).toBe(true);
    expect(projectLamport(replica, catalog).nodes[0]!.widgets_values).toEqual(["atomic"]);
  });

  it("rejects legacy, mixed, zero, overflow, and wrong-lineage envelopes before mutation", () => {
    const cases: unknown[] = [
      { ...write("a", 1, "a", "x"), base_version: 1 },
      { ...write("b", 1, "a", "x"), stamp: [1, "a"] },
      { ...write("c", 0, "a", "x") },
      { ...write("d", MAX_LAMPORT_COUNTER + 1, "a", "x") },
    ];
    for (const candidate of cases) {
      const doc = mintLamport(workflow, catalog);
      const before = Y.encodeStateAsUpdate(doc);
      const outcome = applyLamportOps(doc, [candidate as LamportOp], catalog).outcomes[0]!;
      expect(outcome.outcome).toBe("rejected");
      if (outcome.outcome === "rejected") expect(outcome.reason.code).toBe("unsupported_ordering_version");
      expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    }
    const legacyDoc = new Y.Doc();
    const legacyRoots = [...legacyDoc.share.keys()];
    const legacyBytes = Y.encodeStateAsUpdate(legacyDoc);
    expect(applyLamportOps(legacyDoc, [write("e", 1, "a", "x")], catalog).outcomes[0]!.outcome).toBe("rejected");
    expect([...legacyDoc.share.keys()]).toEqual(legacyRoots);
    expect(Y.encodeStateAsUpdate(legacyDoc)).toEqual(legacyBytes);
  });

  it("uses valid-prefix/abort-remainder and does not advance for rejected events", () => {
    const doc = mintLamport(workflow, catalog);
    const mixed = { ...write("b", 9, "a", "bad"), stamp: [9, "a"] } as unknown as LamportOp;
    const result = applyLamportOps(doc, [write("a", 3, "a", "ok"), mixed, write("c", 20, "a", "never")], catalog);
    expect(result.outcomes.map((o) => o.outcome)).toEqual(["applied", "rejected", "rejected"]);
    expect(doc.getMap("meta").get("clock_max")).toBe(3);
  });

  it("keeps retry identity frozen and byte-identical", () => {
    const doc = mintLamport(workflow, catalog);
    const op = freezeLamportEnvelope(
      { op: "set_widget" as const, node_id: 1, node_incarnation: "0", widget: "seed", value: "once" },
      "agent:t:1",
      "a".repeat(32),
      { kind: "lamport", counter: 4 },
    ) as LamportOp;
    applyLamportOps(doc, [op], catalog);
    const before = Y.encodeStateAsUpdate(doc);
    expect(applyLamportOps(doc, [op], catalog).outcomes[0]!.outcome).toBe("no-op");
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it("pins the clean-lineage schema", () => {
    expect(mintLamport(workflow, catalog).getMap("meta").get("schema_version")).toBe(LAMPORT_SCHEMA_VERSION);
  });
});

describe("durable producer clock", () => {
  it("observes, ticks, refuses overflow, and persists before returning", async () => {
    expect(observeLamport(2, 9, 4)).toBe(9);
    expect(tickLamport(2, 9, 4)).toBe(10);
    expect(() => tickLamport(MAX_LAMPORT_COUNTER)).toThrow(/exhausted/);

    let durable: number | undefined;
    const store: LamportClockStore = {
      async transaction(_identity, update) {
        const result = await update(durable);
        durable = result.counter;
        return result.value;
      },
    };
    const identity = { workflow_id: "w", lineage_id: "l", producer_id: "p" };
    await expect(persistLamportTick(store, identity, [12])).resolves.toEqual({ kind: "lamport", counter: 13 });
    expect(durable).toBe(13);
    await expect(persistLamportTick(store, identity, [2])).resolves.toEqual({ kind: "lamport", counter: 14 });
    const emptyStore: LamportClockStore = {
      async transaction(_identity, update) {
        const result = await update(undefined);
        return result.value;
      },
    };
    await expect(persistLamportTick(emptyStore, identity, [], { requireSeed: true })).rejects.toThrow(/unseeded/);
    await expect(persistLamportTick(emptyStore, identity, [14], { requireSeed: true })).resolves.toEqual({
      kind: "lamport",
      counter: 15,
    });
  });
});
