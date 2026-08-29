import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  CMP_EVENT_SCHEMA_VERSION,
  MAX_OPS_PER_BATCH,
  appliedOpIds,
  applyOps,
  mint,
  readGraph,
  type CmpEvent,
  type Op,
} from "../src/index.js";

const malformed = {
  op: "not_a_real_op",
  op_id: "00000000000000000000000000000001",
  actor: "agent:event-test",
  base_version: 1,
  stamp: [1, "agent:event-test"],
} as unknown as Op;

const validClear = {
  op: "clear", op_id: "00000000000000000000000000000002",
  actor: "agent:event-test", base_version: 2, stamp: [2, "agent:event-test"], removed_nodes: [],
} as unknown as Op;

describe("caller-owned cmp event sink", () => {
  it("isolates a throwing sink from applier results and document bytes", () => {
    const baselineDoc = mint({ nodes: [], links: [] });
    const observedDoc = new Y.Doc();
    Y.applyUpdate(observedDoc, Y.encodeStateAsUpdate(baselineDoc));

    const baseline = applyOps(baselineDoc, [malformed]);
    const withThrowingSink = applyOps(observedDoc, [malformed], undefined, {
      eventSink: () => { throw new Error("host telemetry is down"); },
    });

    expect(withThrowingSink).toEqual(baseline);
    expect(Y.encodeStateAsUpdate(observedDoc)).toEqual(Y.encodeStateAsUpdate(baselineDoc));
  });

  it("emits a versioned JSON-serializable rejection without Error instances", () => {
    const events: CmpEvent[] = [];
    applyOps(mint({ nodes: [], links: [] }), [malformed], undefined, { eventSink: (event) => { events.push(event); } });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      schema_version: CMP_EVENT_SCHEMA_VERSION,
      type: "op_rejected",
      source: "applyOps",
      code: "unknown_op",
      error_name: "OpRejectedError",
      op_id: malformed.op_id,
      batch_index: 0,
    });
    expect(JSON.parse(JSON.stringify(events[0]))).toEqual(events[0]);
    expect(Object.values(events[0]!).some((value) => value instanceof Error)).toBe(false);
  });

  it("reports the existing batch limit once without changing its result", () => {
    const sink = vi.fn((_event: CmpEvent): undefined => undefined);
    const ops = Array.from({ length: MAX_OPS_PER_BATCH + 1 }, () => malformed);
    const result = applyOps(mint({ nodes: [], links: [] }), ops, undefined, { eventSink: sink });

    expect(sink).toHaveBeenCalledOnce();
    expect(sink).toHaveBeenCalledWith(expect.objectContaining({
      schema_version: 1,
      type: "limit_violation",
      code: "max_ops_per_batch",
    }));
    expect(result.outcomes).toHaveLength(ops.length);
    expect(result.outcomes.every((outcome) => outcome.outcome === "rejected")).toBe(true);
    expect(JSON.parse(JSON.stringify(sink.mock.calls[0]![0]))).toEqual(sink.mock.calls[0]![0]);
  });

  it("isolates a throwing sink after an applied prefix and abort remainder are fixed", () => {
    const baselineDoc = mint({ nodes: [], links: [] });
    const observedDoc = new Y.Doc();
    Y.applyUpdate(observedDoc, Y.encodeStateAsUpdate(baselineDoc));
    const ops = [validClear, malformed, validClear];
    const baseline = applyOps(baselineDoc, ops);
    const observed = applyOps(observedDoc, ops, undefined, {
      eventSink: () => { throw new Error("host telemetry is down"); },
    });
    expect(observed).toEqual(baseline);
    expect(observed.outcomes.map((outcome) => outcome.outcome)).toEqual(["no-op", "rejected", "rejected"]);
    expect(readGraph(observedDoc)).toEqual(readGraph(baselineDoc));
    expect(appliedOpIds(observedDoc)).toEqual(appliedOpIds(baselineDoc));
  });
});
