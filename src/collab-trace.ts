/**
 * Versioned evidence contract for collaboration replay tooling.
 *
 * A trace records facts observed around the real applier. It is not a mutation
 * format and intentionally exposes no replay, merge, comparator, Yjs, or mint
 * API. Consumers render captured decisions; they must never recompute them.
 */
import type { Op, StampKey } from "./types.js";

export const COLLAB_TRACE_SCHEMA = "comfy.collab-replay/v1" as const;
export type CollabTraceSchema = typeof COLLAB_TRACE_SCHEMA;

export interface TraceHash {
  algorithm: "sha256";
  encoding: "canonical-json-v1" | "yjs-state-vector" | "binary";
  value: string;
}

export interface TraceSource {
  cmp_sha: string;
  harness_sha: string;
  fixture_sha: string;
  catalog_sha: string;
  /** Optional adapters participating in this capture. */
  fe_sha?: string;
  cloud_sha?: string;
  dirty: boolean;
  node_version: string;
  yjs_version: string;
}

export interface TraceRun {
  trace_id: string;
  test: string;
  seed: number | string;
  source: TraceSource;
  workflow_id: string;
  lineage_id: string;
  ordering_scheme: string;
  projection_normalization: "workflow-projection/v1";
  counterexample_path?: readonly number[];
  input_hash?: TraceHash;
}

export type CausalKnowledge =
  | { status: "known"; parents: readonly CausalParent[] }
  | { status: "partial"; parents: readonly CausalParent[] }
  | { status: "unknown"; parents: readonly [] };

export interface CausalParent {
  op_id: string;
  relation: "observed-before" | "fixture-declared";
  evidence: "producer-observation" | "vector-reference" | "fixture";
}

export interface TraceTarget {
  kind: "conflict-register" | "affected-path" | "workflow";
  path: readonly (string | number)[];
  role: "conflict" | "effect" | "scope";
}

export type DecisionEvidence =
  | { kind: "lww-comparison"; winning_stamp: StampKey; losing_stamp: StampKey }
  | { kind: "dedupe"; original_op_id: string }
  | { kind: "rejection"; code: string; message: string; failing_index: number }
  | { kind: "none" };

export interface SemanticDiff {
  nodes_added: readonly (string | number)[];
  nodes_removed: readonly (string | number)[];
  nodes_changed: readonly (string | number)[];
  links_added: readonly (string | number)[];
  links_removed: readonly (string | number)[];
  links_changed: readonly (string | number)[];
}

export interface SemanticOpTraceStep {
  step_id: string;
  kind: "semantic-op";
  actor: string;
  op_id: string;
  /** Preserved verbatim. It must not be reconstructed from base_version. */
  stamp: readonly [number, string];
  base_version: number;
  arrival_index: number;
  causal: CausalKnowledge;
  observed_frontier?: Readonly<Record<string, number>>;
  verb: Op["op"];
  /** Complete mint-time payload, including defaults; never re-derived on replay. */
  payload: Op;
  before_projection_hash: TraceHash;
  after_projection_hash: TraceHash;
  semantic_diff: SemanticDiff;
  outcome: "applied" | "no-op" | "lww-dropped" | "rejected";
  reason_code: string;
  processed: boolean;
  consumed_op_id: boolean;
  targets: readonly TraceTarget[];
  decision_evidence: DecisionEvidence;
  batch?: { batch_id: string; index: number; size: number };
}

export interface RawUpdateDiagnostic {
  direction: "host-to-follower";
  byte_length: number;
  hash: TraceHash;
  attachment_ref?: string;
}

interface LifecycleBase {
  step_id: string;
  arrival_index: number;
  workflow_id: string;
  before_lineage_id: string;
  after_lineage_id: string;
  before_doc_id: string;
  after_doc_id: string;
  before_state_vector_hash: TraceHash;
  after_state_vector_hash: TraceHash;
  diagnostic?: RawUpdateDiagnostic;
}

export interface StateVectorReplayTraceStep extends LifecycleBase {
  kind: "state-vector-replay";
  same_document: true;
  reason: "seq-gap" | "reconnect";
  requested_from_seq?: number;
  resumed_at_seq?: number;
}

export interface DocResetTraceStep extends LifecycleBase {
  kind: "doc-reset";
  same_document: false;
  reset_seq: number;
  projectors_notified_before_replace: boolean;
}

export type CollabTraceStep = SemanticOpTraceStep | StateVectorReplayTraceStep | DocResetTraceStep;

export interface CollabReplayTraceV1 {
  schema: CollabTraceSchema;
  run: TraceRun;
  steps: readonly CollabTraceStep[];
  assertions: {
    converged: boolean;
    final_projection_hash: TraceHash;
    final_applied_op_ids_hash: TraceHash;
    failure_step_id: string | null;
  };
}

/** Fail closed at the schema-major boundary before a viewer reads a trace. */
export function assertCollabReplayTraceV1(value: unknown): asserts value is CollabReplayTraceV1 {
  if (typeof value !== "object" || value === null) throw new TypeError("collaboration trace must be an object");
  const trace = value as Partial<CollabReplayTraceV1>;
  if (trace.schema !== COLLAB_TRACE_SCHEMA) throw new TypeError(`unsupported collaboration trace schema: ${String(trace.schema)}`);
  if (typeof trace.run !== "object" || trace.run === null || !Array.isArray(trace.steps)) {
    throw new TypeError("collaboration trace requires run metadata and steps");
  }
  for (const [index, step] of trace.steps.entries()) {
    if (typeof step !== "object" || step === null || !("kind" in step)) throw new TypeError(`trace step ${index} is malformed`);
    if (step.kind === "semantic-op") {
      if (!/^[0-9a-f]{32}$/.test(step.op_id) || step.payload.op_id !== step.op_id) throw new TypeError(`trace step ${index} has an invalid immutable op_id`);
      if (!Array.isArray(step.stamp) || step.stamp.length !== 2 || step.base_version !== step.payload.base_version) throw new TypeError(`trace step ${index} does not preserve stamp/base metadata`);
      if (step.causal.status === "unknown" && step.causal.parents.length !== 0) throw new TypeError(`trace step ${index} claims unknown causality with parents`);
    } else if (step.kind === "state-vector-replay") {
      if (!step.same_document || step.before_doc_id !== step.after_doc_id || step.before_lineage_id !== step.after_lineage_id) throw new TypeError(`trace step ${index} violates same-document replay`);
    } else if (step.kind === "doc-reset") {
      if (step.same_document || step.before_doc_id === step.after_doc_id || step.before_lineage_id === step.after_lineage_id) throw new TypeError(`trace step ${index} does not describe a lineage replacement`);
    } else {
      throw new TypeError(`trace step ${index} has an unknown kind`);
    }
  }
}
