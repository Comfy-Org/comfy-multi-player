/**
 * Schema §11 — the bounded-writes ceiling is a LIVE gate, and the accounting
 * under it is pinned.
 *
 * `test/applier.test.ts` "bounded writes (schema §11)" compares
 * `_getMutationCount()` against a ceiling for every op in the fixture corpus.
 * MUT-GLOB-KA4-1 found that `mutations++` in `apush`/`mdel`/`adel` could be
 * flipped to `mutations--` with the suite green, and PR #58 pinned the
 * DIRECTION of each helper in `test/doc-mint-mutation-survivors.test.ts`.
 *
 * Direction is necessary and not sufficient. A stated bound is only a bound if
 * some reachable input can violate it and if the number being compared tracks
 * the work actually done. Two things were still unheld:
 *
 *  1. **That the gate can fire at all.** The corpus's worst measured op is 7
 *     against a ceiling of 12, so every green run is green with headroom, and
 *     nothing demonstrated that any input pushes the count past a fixed
 *     ceiling. The tests below show the count is UNBOUNDED in the size of the
 *     op's blast radius — `delete_node` costs `2·degree + 2` Y-writes — so any
 *     fixed ceiling K is exceeded at degree > K/2. That is a proof rather than
 *     a second copy of the constant, which is why no ceiling value appears
 *     here: the ceiling lives in `test/applier.test.ts` and is deliberately
 *     NOT touched by this file (see `reports/audit/mut-gaps-rcdf.md` §R-F).
 *
 *  2. **That the count is the applier's real write count.** If a future
 *     refactor wrote through raw `m.set(…)` instead of `mset(…)`, the count
 *     would fall, the ceiling would still pass, and the gate would be measuring
 *     nothing. `set_widget` has an exact, schema-stated cost (§1.2: one widget
 *     `set` plus one `__stamps` set; §4: one `__applied` set) and is pinned to
 *     it here, so a bypassed or an extra write both show up as a number.
 *
 * These are deliberately expressed as EXACT counts and as growth, not as
 * `toBeGreaterThan(0)`: an op-count assertion that only checks non-zero passes
 * for any implementation that writes at least once, which is the "surface too
 * coarse to express the property" shape in `reports/vacuous-verification.md`.
 */
import { describe, expect, it } from "vitest";
import {
  applyOps,
  mint,
  type DeleteNodeOp,
  type SetWidgetOp,
  type WidgetCatalog,
  type WorkflowJSON,
} from "../src/index.js";
import { _getMutationCount, _resetMutationCount } from "../src/doc.js";

const catalog: WidgetCatalog = { types: { Hub: { widget_order: ["text"] }, Peer: { widget_order: [] } } };

let seq = 0;
const env = () => {
  const op_id = ("b" + String(seq++).padStart(4, "0")).padEnd(32, "0");
  return { op_id, actor: "a", base_version: 1, stamp: [1, "a"] as [number, string] };
};

/**
 * Node 1 ("the hub") fans out to `degree` peers over `degree` links. Deleting
 * the hub costs one `mdel` for the node, one per severed link, and one `mset`
 * per peer input slot whose `link` is scrubbed to null — so the write count is
 * a function of the hub's DEGREE, which is caller-controlled and unbounded.
 */
function hubWorkflow(degree: number): WorkflowJSON {
  const nodes: unknown[] = [
    {
      id: 1,
      type: "Hub",
      inputs: [],
      outputs: [{ name: "out", type: "X", links: Array.from({ length: degree }, (_, i) => i + 1) }],
      widgets_values: ["t"],
    },
  ];
  const links: unknown[] = [];
  for (let i = 1; i <= degree; i++) {
    nodes.push({ id: i + 1, type: "Peer", inputs: [{ name: "in", type: "X", link: i }], outputs: [] });
    links.push([i, 1, 0, i + 1, 0, "X"]);
  }
  return { nodes, links } as unknown as WorkflowJSON;
}

/** Y-writes performed by deleting the hub of a `degree`-wide fan-out. */
function deleteHubCost(degree: number): number {
  const doc = mint(hubWorkflow(degree), catalog);
  const op: DeleteNodeOp = {
    op: "delete_node",
    ...env(),
    node_id: 1,
    removed_links: Array.from({ length: degree }, (_, i) => i + 1),
  };
  _resetMutationCount();
  const res = applyOps(doc, [op], catalog);
  expect(res.failed, `delete_node at degree ${degree} must succeed`).toBeNull();
  return _getMutationCount();
}

describe("schema §11: the bounded-writes count grows with the op's blast radius", () => {
  it("is strictly increasing in the deleted node's degree", () => {
    // Varying cardinality is the point. A single-degree fixture would report
    // one number that any monotone-or-not implementation reproduces; the
    // sequence is what makes the assertion sensitive to the ACCOUNTING and not
    // just to the fact that something was counted.
    const degrees = [1, 2, 4, 16, 32];
    const costs = degrees.map(deleteHubCost);
    for (let i = 1; i < costs.length; i++) {
      expect(costs[i]!, `degree ${degrees[i]} must cost more than degree ${degrees[i - 1]}`).toBeGreaterThan(
        costs[i - 1]!,
      );
    }
    // The exact law, so a change to the write pattern is a visible diff rather
    // than a still-passing inequality: one node delete, one delete per severed
    // link, one scrub per peer input slot.
    expect(costs).toEqual(degrees.map((d) => 2 * d + 2));
  });

  it("exceeds ANY fixed ceiling at a large enough degree, so the §11 gate can fire", () => {
    // The gate in `test/applier.test.ts` asserts `count <= LIMIT` for a fixed
    // LIMIT. This does not restate LIMIT — it shows the quantity is unbounded,
    // which is what makes that assertion a bound rather than a formality.
    const small = deleteHubCost(2);
    const large = deleteHubCost(64);
    expect(large).toBeGreaterThan(small * 10);
    expect(large).toBeGreaterThan(64);
  });
});

describe("schema §11: the counter measures the applier's real writes", () => {
  it("charges a top-level set_widget exactly three Y-writes (§1.2 widget + §4 stamp + §4 applied)", () => {
    // Schema §1.2: "A set_widget apply is one map `set` (plus one `__stamps`
    // set)". §4 adds the `__applied` idempotency set. Anything that writes
    // through raw Y instead of `mset` would drop below three; anything that
    // writes more would rise above it. Both are the gate losing its meaning.
    const doc = mint(hubWorkflow(1), catalog);
    const op = { op: "set_widget", ...env(), node_id: 1, widget: "text", value: "z" } as SetWidgetOp;
    _resetMutationCount();
    expect(applyOps(doc, [op], catalog).failed).toBeNull();
    expect(_getMutationCount()).toBe(3);
  });

  it("accumulates across ops without a reset, and never runs backwards", () => {
    // The aggregate view of the direction pin: with `mutations--` anywhere on
    // this path the running total falls instead of stepping up by three.
    const doc = mint(hubWorkflow(1), catalog);
    _resetMutationCount();
    const running: number[] = [];
    for (let i = 0; i < 4; i++) {
      const op = { op: "set_widget", ...env(), node_id: 1, widget: "text", value: "v" + String(i) } as SetWidgetOp;
      expect(applyOps(doc, [op], catalog).failed).toBeNull();
      running.push(_getMutationCount());
    }
    expect(running).toEqual([3, 6, 9, 12]);
  });

  it("charges a de-duplicated replay nothing, so the ceiling is not padded by idempotent retries (KA-4)", () => {
    // §4: a second delivery of the same op_id is skipped. It must therefore
    // cost zero Y-writes — if a skipped op still wrote, the ceiling would be
    // absorbing work that the idempotency gate is supposed to have removed.
    const doc = mint(hubWorkflow(1), catalog);
    const op = { op: "set_widget", ...env(), node_id: 1, widget: "text", value: "z" } as SetWidgetOp;
    expect(applyOps(doc, [op], catalog).failed).toBeNull();
    _resetMutationCount();
    const replay = applyOps(doc, [op], catalog);
    expect(replay.failed).toBeNull();
    expect(_getMutationCount()).toBe(0);
  });
});
