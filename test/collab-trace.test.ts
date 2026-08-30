import { createHash } from "node:crypto";
import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import {
  COLLAB_TRACE_SCHEMA,
  applyOps,
  appliedOpIds,
  assertCollabReplayTraceV1,
  mint,
  project,
  readStamps,
  stampKey,
  stampTargetKey,
  writeTarget,
  type CollabReplayTraceV1,
  type Op,
  type SemanticDiff,
  type SemanticOpTraceStep,
  type WorkflowJSON,
} from "../src/index.js";
import { loadCatalog } from "./helpers.js";

const catalog = loadCatalog();
const opId = (label: string) => createHash("sha256").update(label).digest("hex").slice(0, 32);

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

function hash(value: unknown) {
  return { algorithm: "sha256" as const, encoding: "canonical-json-v1" as const, value: createHash("sha256").update(canonical(value)).digest("hex") };
}

function normalized(doc: Y.Doc): WorkflowJSON {
  const value = structuredClone(project(doc, catalog));
  value.nodes.sort((a, b) => String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0);
  value.links.sort((left, right) => {
    const a = left as unknown[];
    const b = right as unknown[];
    return String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0;
  });
  return value;
}

function ids(value: WorkflowJSON, kind: "nodes" | "links"): Map<string, unknown> {
  const entries: readonly unknown[] = kind === "nodes" ? value.nodes : value.links;
  return new Map(entries.map((entry) => [String(kind === "nodes" ? (entry as { id: unknown }).id : (entry as unknown[])[0]), entry]));
}

function diff(before: WorkflowJSON, after: WorkflowJSON): SemanticDiff {
  const compare = (kind: "nodes" | "links") => {
    const left = ids(before, kind), right = ids(after, kind);
    return {
      added: [...right.keys()].filter((id) => !left.has(id)),
      removed: [...left.keys()].filter((id) => !right.has(id)),
      changed: [...right.keys()].filter((id) => left.has(id) && canonical(left.get(id)) !== canonical(right.get(id))),
    };
  };
  const nodes = compare("nodes"), links = compare("links");
  return { nodes_added: nodes.added, nodes_removed: nodes.removed, nodes_changed: nodes.changed, links_added: links.added, links_removed: links.removed, links_changed: links.changed };
}

/** Fixture emitter: observes one real applyOps admission and never replays policy. */
function capture(doc: Y.Doc, op: Op, arrival_index: number, parents: SemanticOpTraceStep["causal"]): SemanticOpTraceStep {
  const before = normalized(doc);
  const beforeStamps = readStamps(doc);
  const result = applyOps(doc, [op], catalog).outcomes[0]!;
  const after = normalized(doc);
  const afterStamps = readStamps(doc);
  const targetKey = stampTargetKey(op);
  const winner = afterStamps[targetKey];
  const incoming = stampKey(op);
  const evidence = result.outcome === "lww-dropped" && Array.isArray(winner)
    ? { kind: "lww-comparison" as const, winning_stamp: winner as [number, string, string], losing_stamp: incoming }
    : result.outcome === "no-op" && beforeStamps[targetKey] === afterStamps[targetKey]
      ? { kind: "dedupe" as const, original_op_id: op.op_id }
      : result.outcome === "rejected"
        ? { kind: "rejection" as const, code: result.reason.code, message: result.reason.message, failing_index: 0 }
        : { kind: "none" as const };
  return {
    step_id: `s-${arrival_index}`,
    kind: "semantic-op",
    actor: op.actor,
    op_id: op.op_id,
    stamp: op.stamp,
    base_version: op.base_version,
    arrival_index,
    causal: parents,
    verb: op.op,
    payload: structuredClone(op),
    before_projection_hash: hash(before),
    after_projection_hash: hash(after),
    before_projection: structuredClone(before),
    after_projection: structuredClone(after),
    semantic_diff: diff(before, after),
    outcome: result.outcome,
    reason_code: result.outcome === "rejected" ? result.reason.code : result.outcome,
    processed: true,
    consumed_op_id: result.outcome !== "rejected",
    targets: [{ kind: "conflict-register", path: writeTarget(op) as (string | number)[], role: "conflict" }],
    decision_evidence: evidence,
  };
}

const workflow: WorkflowJSON = { nodes: [{ id: 1, type: "KSampler", inputs: [], outputs: [], widgets_values: [1, "fixed", 20, 7, "euler", "normal", 1] }], links: [], groups: [], extra: {}, last_node_id: 1, last_link_id: 0, version: 0.4 };
const edit = (label: string, value: number, base_version: number, stampCounter = base_version): Op => ({ op: "set_widget", op_id: opId(label), actor: `human:${label}`, base_version, stamp: [stampCounter, `human:${label}`], node_id: 1, node_incarnation: "0", widget: "steps", value });

function fixture(): CollabReplayTraceV1 {
  const doc = mint(workflow, catalog);
  const first = edit("winner", 25, 4, 40);
  const second = edit("loser", 10, 99, 3);
  const steps = [capture(doc, first, 0, { status: "known", parents: [] }), capture(doc, second, 1, { status: "known", parents: [{ op_id: first.op_id, relation: "fixture-declared", evidence: "fixture" }] })];
  return {
    schema: COLLAB_TRACE_SCHEMA,
    run: { trace_id: hash(steps).value, test: "lww-evidence-fixture", seed: 1592594695, source: { cmp_sha: "c543d947e3cb6ddf7570709e88a9eae2de031553", harness_sha: "fixture", fixture_sha: hash(workflow).value, catalog_sha: "fixture-catalog", dirty: false, node_version: process.version, yjs_version: "13.6.27" }, workflow_id: "wf-fixture", lineage_id: "lineage-1", ordering_scheme: "explicit-stamp", projection_normalization: "workflow-projection/v1" },
    steps,
    assertions: { converged: true, final_projection_hash: hash(normalized(doc)), final_applied_op_ids_hash: hash([...appliedOpIds(doc)].sort()), failure_step_id: null },
  };
}

describe("collaboration trace v1 contract and fixture emitter", () => {
  it("emits deterministic facts from the real applier and preserves stamp separately from base_version", () => {
    const a = fixture(), b = fixture();
    expect(canonical(a)).toBe(canonical(b));
    expect(a.steps[0]).toMatchObject({ base_version: 4, stamp: [40, "human:winner"], outcome: "applied" });
    expect(a.steps[1]).toMatchObject({ outcome: "lww-dropped", consumed_op_id: true, decision_evidence: { kind: "lww-comparison" } });
    assertCollabReplayTraceV1(a);
  });

  it("hashes object keys canonically", () => expect(hash({ b: 2, a: 1 })).toEqual(hash({ a: 1, b: 2 })));

  it("fails closed on unknown schema majors and invalid op identity", () => {
    expect(() => assertCollabReplayTraceV1({ ...fixture(), schema: "comfy.collab-replay/v2" })).toThrow(/unsupported/);
    const bad = structuredClone(fixture());
    if (bad.steps[0]?.kind === "semantic-op") bad.steps[0].op_id = "regenerated";
    expect(() => assertCollabReplayTraceV1(bad)).toThrow(/immutable op_id/);
  });

  it("keeps state-vector replay and doc reset as distinct lifecycle events", () => {
    const base = fixture();
    const stateVectorHash = { algorithm: "sha256" as const, encoding: "yjs-state-vector" as const, value: "a".repeat(64) };
    const trace: CollabReplayTraceV1 = { ...base, steps: [
      { step_id: "life-1", kind: "state-vector-replay", arrival_index: 0, workflow_id: "wf-fixture", before_lineage_id: "lineage-1", after_lineage_id: "lineage-1", before_doc_id: "doc-1", after_doc_id: "doc-1", before_state_vector_hash: stateVectorHash, after_state_vector_hash: stateVectorHash, same_document: true, reason: "reconnect" },
      { step_id: "life-2", kind: "doc-reset", arrival_index: 1, workflow_id: "wf-fixture", before_lineage_id: "lineage-1", after_lineage_id: "lineage-2", before_doc_id: "doc-1", after_doc_id: "doc-2", before_state_vector_hash: stateVectorHash, after_state_vector_hash: stateVectorHash, same_document: false, reset_seq: 9, projectors_notified_before_replace: true },
    ] };
    expect(() => assertCollabReplayTraceV1(trace)).not.toThrow();
  });
});
