/**
 * Baseline cost of the two hot write/read paths: `applyOps` and `project`.
 *
 * WHY A BASELINE AND NOT A THRESHOLD. There is no measured budget to assert
 * against yet, and a threshold invented here would be a number someone later
 * treats as a requirement. This file exists to produce the first honest
 * numbers, so a budget can be argued from data. It therefore asserts NOTHING
 * about timing and is deliberately kept out of the unit suite — `vitest.config.ts`
 * includes only `test/**\/*.test.ts`, so `npm test` never picks this up. Run it
 * on purpose:
 *
 *   npm run build && npm run bench
 *
 * WHAT IS TIMED. Only the call under measurement. Every document, catalog and
 * op batch is built in `setup()` outside the timed region, because building a
 * 200-node workflow costs more than projecting one and would otherwise
 * dominate the sample.
 *
 * DETERMINISM. Both documents come from one fixed seed (`SEED`) through a
 * small LCG, so the 20-node and 200-node cases are byte-identical between runs
 * and between machines. `Math.random()` is never called: a benchmark whose
 * input changes per run cannot be compared to its own history, which is the
 * only comparison a baseline is for.
 *
 * THE FRAME FIGURE. Results print as a percentage of a 16.6 ms frame — the
 * budget for one 60 Hz frame. `applyOps` and `project` run on the follower's
 * frame path, so "2% of a frame" is the number a reader actually needs; raw
 * ms/op invites comparison against nothing. It is context, not a pass mark.
 *
 * PUBLIC API ONLY. `mint`, `applyOps` and `project` are imported from the
 * package entry point, so this measures what consumers call. It does not reach
 * into `src/` internals, and it changes no public surface.
 *
 * ENVIRONMENT. `reportEnvironment()` prints the Node version, V8 version,
 * platform/arch, CPU model and logical core count, and whether the process
 * looks contended, once per run. A timing number without that metadata is not
 * reproducible — the same case on the same commit moved by more than 3x
 * between an idle and a loaded host while this file was being written.
 */
import { cpus, loadavg } from "node:os";
import { bench, describe } from "vitest";

import { applyOps, mint, project, type Op, type WidgetCatalog, type WorkflowJSON } from "../src/index.js";

/** One 60 Hz frame, in milliseconds. Printed against, never asserted on. */
const FRAME_MS = 16.6;

/** Fixed so both documents are reproducible run to run, host to host. */
const SEED = 0x5eed_5eed;

/**
 * A 32-bit linear congruential generator (Numerical Recipes constants).
 * Deliberately not `Math.random()`: see DETERMINISM above. Small and
 * self-contained so the benchmark adds no dependency.
 */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const catalog: WidgetCatalog = {
  types: {
    KSampler: { widget_order: ["seed", "steps", "cfg", "sampler_name", "scheduler", "denoise"] },
    CheckpointLoaderSimple: { widget_order: ["ckpt_name"] },
    Note: { widget_order: ["text"] },
  },
};

const TYPES = ["KSampler", "CheckpointLoaderSimple", "Note"] as const;

/** Per-type widget values, split out of `seededWorkflow` so the seeded stream stays readable. */
function widgetValuesFor(type: (typeof TYPES)[number], rand: () => number): unknown[] {
  switch (type) {
    case "KSampler":
      return [Math.floor(rand() * 1e6), 20 + Math.floor(rand() * 30), 8, "euler", "normal", 1];
    case "CheckpointLoaderSimple":
      return [`model-${Math.floor(rand() * 20)}.safetensors`];
    default:
      return [`note ${Math.floor(rand() * 1000)}`];
  }
}

/**
 * A populated workflow of `n` nodes, chained so links are realistic rather
 * than absent: node i+1 takes a link from node i. Widget values vary with the
 * seeded stream so the document is not `n` copies of one node, which would let
 * a structural-sharing optimisation flatter the projection.
 */
function seededWorkflow(n: number): WorkflowJSON {
  const rand = lcg(SEED);
  const nodes = [];
  const links = [];
  for (let i = 1; i <= n; i++) {
    const type = TYPES[Math.floor(rand() * TYPES.length)];
    const widgets_values = widgetValuesFor(type, rand);
    nodes.push({
      id: i,
      type,
      pos: [Math.floor(rand() * 4000), Math.floor(rand() * 4000)],
      size: [315, 262],
      order: i,
      mode: 0,
      widgets_values,
    });
    if (i > 1) links.push([i - 1, i - 1, 0, i, 0, "MODEL"]);
  }
  return { nodes, links } as unknown as WorkflowJSON;
}

/**
 * A batch of valid `set_widget` ops against KSampler nodes that exist in the
 * document. Valid on purpose: a rejected op short-circuits before the write
 * path, so a batch full of rejections would measure the guard, not the apply.
 * `op_id`s are minted from the seeded stream's index, never regenerated, so a
 * re-run submits the same identities.
 */
function seededOps(wf: WorkflowJSON, count: number): Op[] {
  const rand = lcg(SEED ^ 0x9e37);
  const ksamplers = (wf.nodes as { id: number; type: string }[]).filter((node) => node.type === "KSampler");
  const ops: Op[] = [];
  for (let i = 0; i < count; i++) {
    const target = ksamplers[i % ksamplers.length];
    ops.push({
      op: "set_widget",
      op_id: `b${String(i).padStart(4, "0")}`.padEnd(32, "0"),
      actor: "bench",
      base_version: 1,
      stamp: [1, "bench"],
      node_id: target.id,
      widget: "steps",
      value: 1 + Math.floor(rand() * 150),
    } as unknown as Op);
  }
  return ops;
}

/**
 * Printed once per run. Without it a number in a PR body cannot be compared to
 * a number from another machine, and a reader cannot tell a real regression
 * from a busier runner.
 */
function reportEnvironment(): void {
  const cores = cpus();
  const [oneMinute] = loadavg();
  console.log(
    [
      `\nbench env: node ${process.version} (v8 ${process.versions.v8})`,
      `  platform:  ${process.platform}/${process.arch}`,
      `  cpu:       ${cores[0]?.model?.trim() ?? "unknown"} x${cores.length} logical`,
      `  load1:     ${oneMinute.toFixed(2)}${oneMinute > cores.length ? "  ** host is oversubscribed; treat these numbers as an upper bound **" : ""}`,
      `  frame:     ${FRAME_MS} ms (60 Hz); results below are a share of one frame`,
      "",
    ].join("\n"),
  );
}

reportEnvironment();

/**
 * 20 nodes is a hand-built graph; 200 is the large end of what users actually
 * open, and the size `scripts/bench-read.mjs` already probes the read path at,
 * so the two measurements are comparable.
 */
const SIZES = [20, 200] as const;

for (const size of SIZES) {
  describe(`${size} nodes (share of a ${FRAME_MS} ms frame)`, () => {
    const workflow = seededWorkflow(size);

    // One op per KSampler in the document, so the batch scales with the
    // document instead of being a fixed 10 ops that get cheaper per node as
    // the graph grows.
    const opCount = Math.max(1, Math.round(size / 4));

    bench(`applyOps — ${opCount} valid set_widget ops`, () => {
      applyOps(applyDoc, ops, catalog);
    }, {
      setup: () => {
        // Fresh document per iteration set: `op_id`s are idempotency keys, so
        // replaying the same batch into the same doc after the first pass
        // would measure the duplicate-op_id fast path, not an apply.
        applyDoc = mint(workflow, catalog);
        ops = seededOps(workflow, opCount);
      },
    });

    bench("project — full document to WorkflowJSON", () => {
      project(projectDoc, catalog);
    }, {
      setup: () => {
        projectDoc = mint(workflow, catalog);
      },
    });

  });
}

// Hoisted so `setup` can rebuild them without the timed closure capturing a
// stale binding.
let applyDoc: ReturnType<typeof mint>;
let projectDoc: ReturnType<typeof mint>;
let ops: Op[];
