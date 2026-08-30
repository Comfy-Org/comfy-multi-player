const SCHEMA = "comfy.collab-replay/v1";
const OUTCOMES = new Set(["applied", "no-op", "lww-dropped", "rejected", "batch-aborted"]);

function fail(message) {
  throw new TypeError(`Invalid collaboration trace: ${message}`);
}

function object(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${path} must be an object`);
  return value;
}

function string(value, path) {
  if (typeof value !== "string" || value.length === 0) fail(`${path} must be a non-empty string`);
}

function projection(value, path) {
  object(value, path);
  if (!Array.isArray(value.nodes) || !Array.isArray(value.links)) fail(`${path} requires nodes and links arrays`);
}

function freeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freeze(child, seen);
  return Object.freeze(value);
}

/** Parse and deeply freeze a v1 trace. This function only validates captured facts. */
export function loadTrace(input) {
  let trace;
  try {
    trace = typeof input === "string" ? JSON.parse(input) : structuredClone(input);
  } catch (error) {
    fail(`JSON could not be parsed (${error instanceof Error ? error.message : String(error)})`);
  }
  object(trace, "trace");
  if (trace.schema !== SCHEMA) fail(`unsupported schema ${String(trace.schema)}`);
  object(trace.run, "run");
  string(trace.run.trace_id, "run.trace_id");
  string(trace.run.test, "run.test");
  if (!Array.isArray(trace.steps)) fail("steps must be an array");
  const ids = new Set();
  trace.steps.forEach((step, index) => {
    const path = `steps[${index}]`;
    object(step, path);
    string(step.step_id, `${path}.step_id`);
    if (ids.has(step.step_id)) fail(`${path}.step_id is duplicated`);
    ids.add(step.step_id);
    if (!Number.isInteger(step.arrival_index) || step.arrival_index < 0) fail(`${path}.arrival_index must be a non-negative integer`);
    if (step.kind === "semantic-op") {
      string(step.actor, `${path}.actor`);
      if (!/^[0-9a-f]{32}$/.test(step.op_id) || step.payload?.op_id !== step.op_id) fail(`${path}.op_id is not immutable`);
      string(step.verb, `${path}.verb`);
      if (!OUTCOMES.has(step.outcome)) fail(`${path}.outcome is unknown`);
      if (!Array.isArray(step.targets)) fail(`${path}.targets must be an array`);
      projection(step.before_projection, `${path}.before_projection`);
      projection(step.after_projection, `${path}.after_projection`);
    } else if (step.kind === "state-vector-replay") {
      if (step.same_document !== true || step.before_doc_id !== step.after_doc_id) fail(`${path} must preserve document identity`);
    } else if (step.kind === "doc-reset") {
      if (step.same_document !== false || step.before_doc_id === step.after_doc_id) fail(`${path} must replace document identity`);
    } else fail(`${path}.kind is unknown`);
  });
  return freeze(trace);
}

export function targetLabel(target) {
  return `${target.kind}:${target.path.map(String).join("/")}`;
}

export function filterOptions(trace) {
  const semantic = trace.steps.filter((step) => step.kind === "semantic-op");
  return {
    actors: [...new Set(semantic.map((step) => step.actor))].sort(),
    outcomes: [...new Set(semantic.map((step) => step.outcome))].sort(),
    targets: [...new Set(semantic.flatMap((step) => step.targets.map(targetLabel)))].sort(),
  };
}

export function filterSteps(trace, filters = {}) {
  const actors = new Set(filters.actors ?? []);
  const outcomes = new Set(filters.outcomes ?? []);
  const targets = new Set(filters.targets ?? []);
  return trace.steps.filter((step) => {
    if (step.kind !== "semantic-op") return actors.size + outcomes.size + targets.size === 0;
    return (!actors.size || actors.has(step.actor))
      && (!outcomes.size || outcomes.has(step.outcome))
      && (!targets.size || step.targets.some((target) => targets.has(targetLabel(target))));
  });
}
