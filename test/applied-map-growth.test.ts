/**
 * CLD-5 evidence — what the `__applied` ledger costs a document that is never
 * compacted.
 *
 * Schema §4 records the idempotency ledger as an unbounded map: every consumed
 * `op_id` keeps a row (`op_id` → `sha256(canonicalOp(op))`) for the life of the
 * document, because per-actor watermark compaction needs host-assigned
 * contiguous `seq` numbers that no host assigns yet (`src/doc.ts`
 * `appliedMap`'s FOLLOW-UP note), and snapshot compaction (§4 rule 2) is
 * host-owned. Nothing in this package caps the map, and nothing in the suite
 * said what the absence costs.
 *
 * This file MEASURES that, and only that. One deterministic sequence of valid,
 * unique, stamped ops is consumed against a minimal minted document, and
 * `__applied` cardinality plus `Y.encodeStateAsUpdate(doc).byteLength` are
 * recorded at 0, 100, 1,000 and 10,000 consumed ops. The checkpoint table is
 * printed for the growth-ceiling model that consumes it.
 *
 * DELIBERATELY NOT HERE: any cap, any compaction algorithm, any retention
 * policy. Choosing one is an owner's decision that needs this number first, and
 * a test that encoded a cap would pin the decision rather than measure its
 * input.
 *
 * WHAT THE NUMBER IS, stated so it is not over-read. The sequence is a
 * homogeneous stream of top-level `set_widget` ops against ONE widget register,
 * each with a strictly increasing stamp so every op wins its LWW gate and is
 * applied rather than dropped. Per consumed op the document therefore retains:
 * one `__applied` row (a 32-char key and a 64-hex digest — ~96 bytes of
 * payload before Yjs struct overhead), one overwritten widget value, and one
 * rewritten `__stamps` row. The ledger row is the part that is retained
 * FOREVER by construction; the other two are the ordinary cost of a write that
 * a snapshot could in principle collapse. The measurement is an upper bound on
 * the ledger's own share and a lower bound on a real session's per-op cost,
 * whose ops carry larger payloads (an `add_node` canonicalizes to hundreds of
 * bytes, not tens).
 */
import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import { applyOps, hasAppliedOp, mint, type Op, type WidgetCatalog, type WorkflowJSON } from "../src/index.js";
import { appliedMap } from "../src/doc.js";
import { MAX_OPS_PER_BATCH } from "../src/limits.js";

/** Consumed-op counts the table reports. `0` is the minted document itself. */
const CHECKPOINTS = [0, 100, 1_000, 10_000] as const;

/** The last checkpoint — the full length of the sequence. */
const TOTAL_OPS: number = CHECKPOINTS[CHECKPOINTS.length - 1]!;

const ACTOR = "agent:growth";

const catalog: WidgetCatalog = { types: { Hub: { widget_order: ["text"] } } };

/** One node, one name-addressable widget — the smallest doc a `set_widget` stream can run against. */
function baseWorkflow(): WorkflowJSON {
  return {
    nodes: [{ id: 1, type: "Hub", pos: [0, 0], inputs: [], outputs: [], widgets_values: ["v000000"] }],
    links: [],
    last_node_id: 1,
    last_link_id: 0,
  } as unknown as WorkflowJSON;
}

/**
 * The op at index `i` of the sequence: unique `op_id`, strictly increasing
 * stamp so it wins the LWW gate, fixed-width value so every op canonicalizes
 * to the same byte length and the per-op deltas are comparable.
 */
function opAt(i: number): Op {
  const op_id = ("g" + String(i).padStart(10, "0")).padEnd(32, "0");
  const version = i + 1;
  return {
    op: "set_widget",
    op_id,
    actor: ACTOR,
    base_version: version,
    stamp: [version, ACTOR] as [number, string],
    node_id: 1,
    widget: "text",
    value: "v" + String(i).padStart(6, "0"),
  };
}

interface Checkpoint {
  /** Ops consumed by the document when this row was taken. */
  consumed: number;
  /** `__applied` cardinality — one row per consumed `op_id` (schema §4). */
  entries: number;
  /** `Y.encodeStateAsUpdate(doc).byteLength` — what a catch-up/persist carries. */
  bytes: number;
}

interface Characterization {
  doc: Y.Doc;
  checkpoints: Checkpoint[];
}

/** Apply `ops` in `MAX_OPS_PER_BATCH`-sized batches, asserting nothing is rejected or dropped. */
function consume(doc: Y.Doc, ops: Op[], what: string): void {
  for (let start = 0; start < ops.length; start += MAX_OPS_PER_BATCH) {
    const batch = ops.slice(start, start + MAX_OPS_PER_BATCH);
    const result = applyOps(doc, batch, catalog);
    expect(
      result.outcomes.filter((o) => o.outcome !== "applied"),
      `${what}: every op in the batch at ${String(start)} must be applied, not rejected, dropped or de-duplicated`,
    ).toEqual([]);
  }
}

function snapshot(doc: Y.Doc, consumed: number): Checkpoint {
  return {
    consumed,
    entries: appliedMap(doc).size,
    bytes: Y.encodeStateAsUpdate(doc).byteLength,
  };
}

/**
 * Consume the sequence once, recording a checkpoint at each threshold. Memoized
 * because 10,000 ops each carry a canonicalization and a SHA-256, and every
 * assertion below reads the same run.
 */
let cached: Characterization | null = null;
function characterize(): Characterization {
  if (cached !== null) return cached;
  const doc = mint(baseWorkflow(), catalog);
  const checkpoints: Checkpoint[] = [];
  let consumed = 0;
  for (const target of CHECKPOINTS) {
    if (target > consumed) {
      const ops: Op[] = [];
      for (let i = consumed; i < target; i++) ops.push(opAt(i));
      consume(doc, ops, `checkpoint ${String(target)}`);
      consumed = target;
    }
    checkpoints.push(snapshot(doc, consumed));
  }
  cached = { doc, checkpoints };
  return cached;
}

/** The compact checkpoint table CLD-5 consumes. */
function printTable(checkpoints: readonly Checkpoint[]): void {
  const cell = (value: string, width: number) => value.padStart(width);
  const lines = [
    "CLD-5 __applied ledger growth — deterministic set_widget stream, minimal minted doc",
    "  consumed  __applied      bytes    Δ bytes   bytes/op",
  ];
  checkpoints.forEach((cp, i) => {
    const prev = checkpoints[i - 1];
    const deltaOps = prev ? cp.consumed - prev.consumed : 0;
    const deltaBytes = prev ? cp.bytes - prev.bytes : 0;
    lines.push(
      [
        cell(String(cp.consumed), 10),
        cell(String(cp.entries), 11),
        cell(String(cp.bytes), 11),
        cell(prev ? String(deltaBytes) : "-", 11),
        cell(prev ? (deltaBytes / deltaOps).toFixed(1) : "-", 11),
      ].join(""),
    );
  });
  console.log(lines.join("\n"));
}

describe("schema §4: the __applied ledger is unbounded in consumed ops (CLD-5)", () => {
  it("records __applied cardinality and encoded size at 0, 100, 1k and 10k consumed ops", { timeout: 300_000 }, () => {
    const { checkpoints } = characterize();
    printTable(checkpoints);

    // The table is evidence, so its shape is asserted rather than assumed: one
    // row per checkpoint, and a ledger cardinality that IS the consumed count.
    expect(checkpoints.map((cp) => cp.consumed)).toEqual([...CHECKPOINTS]);
    expect(checkpoints.map((cp) => cp.entries)).toEqual([...CHECKPOINTS]);
  });

  it("keeps every unique op represented — no eviction, no collapse", { timeout: 300_000 }, () => {
    // (a) The property a cap would break. `size === n` alone is satisfied by a
    // ledger that evicted one row and admitted a different one, so every op_id
    // of the sequence is looked up individually.
    const { doc } = characterize();
    for (let i = 0; i < TOTAL_OPS; i++) {
      const { op_id } = opAt(i);
      expect(hasAppliedOp(doc, op_id), `op ${String(i)} (${op_id}) must still be represented`).toBe(true);
    }
    expect(appliedMap(doc).size).toBe(TOTAL_OPS);
  });

  it("charges a full replay of the same ops zero entries and zero bytes", { timeout: 300_000 }, () => {
    // (b) The ledger's reason for existing: re-delivering the whole sequence is
    // a byte-level no-op. Byte identity, not just an unchanged length — a
    // re-applied write that happened to encode to the same size would pass a
    // length check and would still be a duplicate apply.
    const { doc } = characterize();
    const before = Y.encodeStateAsUpdate(doc);
    const entriesBefore = appliedMap(doc).size;

    for (let start = 0; start < TOTAL_OPS; start += MAX_OPS_PER_BATCH) {
      const batch: Op[] = [];
      for (let i = start; i < Math.min(start + MAX_OPS_PER_BATCH, TOTAL_OPS); i++) batch.push(opAt(i));
      const result = applyOps(doc, batch, catalog);
      // Asserting the OUTCOME, not merely the absence of a rejection: a replay
      // that silently re-applied would also report no failure.
      expect(
        result.outcomes.filter((o) => o.outcome !== "no-op"),
        `every op in the replayed batch at ${String(start)} must be de-duplicated`,
      ).toEqual([]);
    }

    expect(appliedMap(doc).size, "a replay adds no ledger entries").toBe(entriesBefore);
    expect(Y.encodeStateAsUpdate(doc), "a replay adds no bytes").toEqual(before);
  });

  it("grows the encoded document from every checkpoint to the next", { timeout: 300_000 }, () => {
    // (c) Nothing in the package reclaims the ledger, so the encoded size a
    // catch-up or a persist must carry is monotonically increasing in consumed
    // ops. Stated as strict growth at each step rather than as a single
    // start-to-end comparison, which a document that grew once and then
    // plateaued would also satisfy.
    const { checkpoints } = characterize();
    for (let i = 1; i < checkpoints.length; i++) {
      const prev = checkpoints[i - 1]!;
      const cur = checkpoints[i]!;
      expect(
        cur.bytes,
        `encoded size at ${String(cur.consumed)} ops must exceed ${String(prev.consumed)} ops`,
      ).toBeGreaterThan(prev.bytes);
    }
  });
});
