import * as Y from "yjs";
import { applyOpsWithAdmission } from "./applier.js";
import { validateLamportCounter } from "./clock.js";
import { metaMap } from "./doc.js";
import { mint } from "./mint.js";
import {
  LAMPORT_ORDERING_VERSION,
  LAMPORT_SCHEMA_VERSION,
  OpRejectedError,
  type ApplyOutcome,
  type ApplyResult,
  type LamportOp,
  type Op,
  type WidgetCatalog,
  type WorkflowJSON,
} from "./types.js";

function unsupported(message: string): OpRejectedError {
  return new OpRejectedError("unsupported_ordering_version", message);
}

function validateLamportDocument(doc: Y.Doc): void {
  if (!doc.share.has("meta")) {
    throw unsupported("Lamport ops require a schema-v3, ordering-v2 Lamport lineage");
  }
  const meta = metaMap(doc);
  if (
    meta.get("schema_version") !== LAMPORT_SCHEMA_VERSION ||
    meta.get("ordering_version") !== LAMPORT_ORDERING_VERSION ||
    meta.get("clock_kind") !== "lamport"
  ) {
    throw unsupported("Lamport ops require a schema-v3, ordering-v2 Lamport lineage");
  }
  validateLamportCounter(meta.get("clock_max"), true);
}

function normalize(op: LamportOp): Op {
  const candidate = op as LamportOp & Record<string, unknown>;
  if (Object.hasOwn(candidate, "base_version") || Object.hasOwn(candidate, "stamp")) {
    throw unsupported("Lamport envelope must not carry legacy base_version or stamp fields");
  }
  if (
    typeof candidate.ordering !== "object" ||
    candidate.ordering === null ||
    candidate.ordering.kind !== "lamport"
  ) {
    throw unsupported("missing or unsupported Lamport ordering");
  }
  const counter = validateLamportCounter(candidate.ordering.counter);
  // The legacy applier's tuple-generic comparator remains the one comparison
  // implementation. This private adapter changes envelope representation only.
  const { ordering: _ordering, ...payload } = candidate;
  return {
    ...payload,
    base_version: counter,
    stamp: [counter, String(candidate.actor ?? "")],
  } as Op;
}

/** Mint the clean lineage required by DQ-10; legacy stamp history is never rewritten in place. */
export function mintLamport(
  workflow: WorkflowJSON,
  catalog: WidgetCatalog,
  catalogVersion = "",
): Y.Doc {
  const doc = mint(workflow, catalog, catalogVersion);
  doc.transact(() => {
    const meta = metaMap(doc);
    meta.set("schema_version", LAMPORT_SCHEMA_VERSION);
    meta.set("ordering_version", LAMPORT_ORDERING_VERSION);
    meta.set("clock_kind", "lamport");
    meta.set("clock_max", 0);
  });
  return doc;
}

/**
 * Apply native Lamport envelopes with valid-prefix/abort-remainder semantics.
 * Scalar `applyOps` remains unchanged for the frozen weekend path.
 */
export function applyLamportOps(
  doc: Y.Doc,
  ops: LamportOp[],
  catalog?: WidgetCatalog,
): ApplyResult {
  try {
    validateLamportDocument(doc);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      outcomes: ops.map((op) => ({
        op_id: typeof op?.op_id === "string" ? op.op_id : "",
        outcome: "rejected" as const,
        reason: { code: "unsupported_ordering_version", message },
      })),
      ops_seen: doc.share.get("__applied") instanceof Y.Map ? doc.getMap("__applied").size : 0,
    };
  }

  const normalized: Op[] = [];
  let incompatibleAt = -1;
  let incompatibility = "";
  for (let index = 0; index < ops.length; index++) {
    try {
      normalized.push(normalize(ops[index]!));
    } catch (error) {
      incompatibleAt = index;
      incompatibility = error instanceof Error ? error.message : String(error);
      break;
    }
  }

  const applied = applyOpsWithAdmission(doc, normalized, catalog, (target, admitted) => {
    const meta = metaMap(target);
    const current = validateLamportCounter(meta.get("clock_max"), true);
    if (admitted.base_version > current) meta.set("clock_max", admitted.base_version);
  });
  const outcomes: ApplyOutcome[] = [...applied.outcomes];
  if (incompatibleAt >= 0) {
    const op = ops[incompatibleAt]!;
    const earlierRejection = outcomes.findIndex((outcome) => outcome.outcome === "rejected");
    outcomes.push({
      op_id: typeof op?.op_id === "string" ? op.op_id : "",
      outcome: "rejected",
      reason: earlierRejection >= 0
        ? { code: "batch_aborted", message: `not processed because op at index ${earlierRejection} was rejected` }
        : { code: "unsupported_ordering_version", message: incompatibility },
    });
    for (const remainder of ops.slice(incompatibleAt + 1)) {
      outcomes.push({
        op_id: typeof remainder?.op_id === "string" ? remainder.op_id : "",
        outcome: "rejected",
        reason: {
          code: "batch_aborted",
          message: `not processed because op at index ${earlierRejection >= 0 ? earlierRejection : incompatibleAt} was rejected`,
        },
      });
    }
  }

  return { outcomes, ops_seen: applied.ops_seen };
}
