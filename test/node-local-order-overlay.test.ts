/**
 * H1 portable node-local order overlay.
 *
 * Failure sentence (vacuity P0): these checks go red when a declared ARRAY
 * form returns before the dynamic catalog overlay, observed as the
 * child-first arrival rejecting `mode.b` or the selector-first arrival
 * projecting the stale option-A order.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import {
  SCHEMA_VERSION as SCHEMA_VERSION_0310,
  project as project0310,
} from "comfy-multi-player-v0310";

import {
  SCHEMA_VERSION,
  applyOps,
  compact,
  hasAppliedOp,
  mint,
  project,
  type Op,
  type SetWidgetOp,
  type WidgetCatalog,
  type WorkflowJSON,
} from "../src/index.js";
import { appliedMap, stampsMap } from "../src/doc.js";
import { canonicalize, fixturesDir } from "./helpers.js";

interface OverlayVector {
  format_version: number;
  catalog: WidgetCatalog;
  base_workflow: WorkflowJSON;
  ops: Record<"child" | "selector", SetWidgetOp>;
  arrival_orders: Array<Array<"child" | "selector">>;
  workflow_final: WorkflowJSON;
  unrelated_name_rejection: { op: SetWidgetOp; code: string };
}

interface ConformanceManifest {
  node_local_order_overlay: string;
}

const manifestPath = resolve(fixturesDir, "golden-vectors", "conformance.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ConformanceManifest;
const vector = JSON.parse(
  readFileSync(resolve(dirname(manifestPath), manifest.node_local_order_overlay), "utf8"),
) as OverlayVector;

const snapshot = Y.encodeStateAsUpdate(mint(vector.base_workflow, vector.catalog));

function fork(): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, snapshot);
  return doc;
}

function projected(doc: Y.Doc): WorkflowJSON {
  return canonicalize(project(doc, vector.catalog)) as WorkflowJSON;
}

describe("H1: node-local array order overlays pinned dynamic-combo order", () => {
  it("runs the language-neutral vector in both arrival orders and consumes every accepted op_id", () => {
    expect(vector.format_version).toBe(1);
    expect(vector.arrival_orders).toEqual([
      ["child", "selector"],
      ["selector", "child"],
    ]);

    for (const arrival of vector.arrival_orders) {
      const doc = fork();
      const ops = arrival.map((name) => structuredClone(vector.ops[name]));
      const result = applyOps(doc, ops, vector.catalog);

      expect(result.outcomes.map((outcome) => outcome.outcome), arrival.join(" -> ")).toEqual([
        "applied",
        "applied",
      ]);
      expect(projected(doc), arrival.join(" -> ")).toEqual(canonicalize(vector.workflow_final));
      for (const op of ops) expect(hasAppliedOp(doc, op.op_id), op.op_id).toBe(true);

      // Accepted replay consumes no new structs: duplicate op_ids are true
      // byte-identical no-ops (KA-4), not only projection-equivalent.
      const beforeReplay = Buffer.from(Y.encodeStateAsUpdate(doc));
      expect(applyOps(doc, ops, vector.catalog).outcomes.map((outcome) => outcome.outcome)).toEqual([
        "no-op",
        "no-op",
      ]);
      expect(Buffer.from(Y.encodeStateAsUpdate(doc)).equals(beforeReplay)).toBe(true);
    }
  });

  it("preserves the realized option-B order and value through compaction", () => {
    const doc = fork();
    applyOps(doc, [vector.ops.child, vector.ops.selector], vector.catalog);

    const compacted = compact(doc, vector.catalog);
    expect(projected(compacted)).toEqual(canonicalize(vector.workflow_final));
    expect(project(compacted, vector.catalog).nodes[0]?.widgets_values_form).toEqual(
      vector.workflow_final.nodes[0]?.widgets_values_form,
    );
  });

  it("keeps the winning selector's realized order when a lower-stamped selector arrives later", () => {
    const doc = fork();
    const winner = structuredClone(vector.ops.selector);
    const loser = {
      ...structuredClone(winner),
      op_id: "40000000000000000000000000000004",
      actor: "agent:selector-old",
      base_version: 10,
      stamp: [10, "agent:selector-old"],
      value: "a",
    } as SetWidgetOp;

    expect(applyOps(doc, [winner, loser], vector.catalog).outcomes.map((outcome) => outcome.outcome)).toEqual([
      "applied",
      "lww-dropped",
    ]);
    expect(project(doc, vector.catalog).nodes[0]?.widgets_values_form).toEqual(
      vector.workflow_final.nodes[0]?.widgets_values_form,
    );
    expect(hasAppliedOp(doc, winner.op_id)).toBe(true);
    expect(hasAppliedOp(doc, loser.op_id)).toBe(true);
  });

  it("rejects an unrelated name before mutation and leaves its op_id unconsumed", () => {
    const doc = fork();
    const bad = vector.unrelated_name_rejection.op;
    // Materialize the applier's empty bookkeeping roots before the before/
    // after observation; empty Yjs roots do not encode bytes but are visible
    // through `doc.share`, so the rejection itself must not be blamed for the
    // applier entrypoint's pre-existing root access.
    appliedMap(doc);
    stampsMap(doc);
    const rootsBefore = [...doc.share.keys()].sort();
    const bytesBefore = Buffer.from(Y.encodeStateAsUpdate(doc));

    const result = applyOps(doc, [bad], vector.catalog);

    expect(result.outcomes[0]).toMatchObject({
      outcome: "rejected",
      reason: { code: vector.unrelated_name_rejection.code },
    });
    expect(Buffer.from(Y.encodeStateAsUpdate(doc)).equals(bytesBefore)).toBe(true);
    expect([...doc.share.keys()].sort()).toEqual(rootsBefore);
    expect(hasAppliedOp(doc, bad.op_id)).toBe(false);
  });

  it("keeps object/custom-serializer forms closed to catalog-owned dynamic children", () => {
    const source = structuredClone(vector.base_workflow);
    const node = source.nodes[0]!;
    const order = (node.widgets_values_form as { order: string[] }).order;
    node.widgets_values = Object.fromEntries(order.map((name, index) => [name, (node.widgets_values as unknown[])[index]]));
    const doc = mint(source, vector.catalog);
    const child = structuredClone(vector.ops.child);
    const before = Buffer.from(Y.encodeStateAsUpdate(doc));

    expect(applyOps(doc, [child], vector.catalog).outcomes[0]).toMatchObject({
      outcome: "rejected",
      reason: { code: "unknown_widget" },
    });
    expect(Buffer.from(Y.encodeStateAsUpdate(doc)).equals(before)).toBe(true);
    expect(hasAppliedOp(doc, child.op_id)).toBe(false);
  });

  it("keeps schema v5 because a real 0.3.10 reader projects every overlay transition identically", () => {
    expect(SCHEMA_VERSION).toBe(5);
    expect(SCHEMA_VERSION_0310).toBe(SCHEMA_VERSION);
    const doc = fork();
    const transitions: Op[][] = [
      [],
      [vector.ops.child],
      [vector.ops.selector],
      [{
        ...structuredClone(vector.ops.selector),
        op_id: "50000000000000000000000000000005",
        actor: "agent:selector-new",
        base_version: 50,
        stamp: [50, "agent:selector-new"],
        value: "a",
      } as SetWidgetOp],
    ];

    for (const ops of transitions) {
      if (ops.length > 0) applyOps(doc, ops, vector.catalog);
      expect(canonicalize(project0310(doc, vector.catalog))).toEqual(canonicalize(project(doc, vector.catalog)));
    }
  });
});
