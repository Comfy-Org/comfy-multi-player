/**
 * Session replay runner: for every fixtures/<name>.session.jsonl, mint a doc
 * from the session's base_workflow, apply the recorded ops, and assert the
 * canonicalized projection deep-equals the recorded final workflow
 * (canonical = nodes/links sorted by id — docs/multiplayer-schema.md §7; the
 * fixture's workflow_final keeps Python insertion order, so both sides are
 * canonicalized before comparing).
 *
 * SKIPPED until the applier lands: applyOps/project/mint are NotImplemented
 * stubs. The fixture corpus itself is real (graduated from the V1-007 spike);
 * flip APPLIER_LANDED when the applier ticket lands.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, test } from "vitest";
import {
  applyOps,
  mint,
  project,
  type Op,
  type WidgetCatalog,
  type WorkflowJSON,
  type WorkflowNode,
} from "../src/index.js";

const APPLIER_LANDED = false; // flip when applyOps/project/mint are real (applier ticket)

const fixturesDir = join(dirname(dirname(fileURLToPath(import.meta.url))), "fixtures");
const sessions = existsSync(fixturesDir)
  ? readdirSync(fixturesDir).filter((f) => f.endsWith(".session.jsonl"))
  : [];

interface SessionHeader {
  session: string;
  /** How the session was authored (e.g. "team"). Never production data. */
  authored_by: string;
  /** The workflow the ops were minted against — replay starts here, not empty. */
  base_workflow: WorkflowJSON;
  /** The workflow after all ops — the (canonicalized) deep-equal target. */
  workflow_final: WorkflowJSON;
}

/** Schema §7 rule 1: sorted-by-id node/link order is canonical. */
function canonicalize(wf: WorkflowJSON): WorkflowJSON {
  const byId = (a: { id: unknown }, b: { id: unknown }) =>
    String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
  const linkId = (l: unknown) => String((l as unknown[])[0]);
  return {
    ...wf,
    nodes: [...wf.nodes].sort(byId) as WorkflowNode[],
    links: [...wf.links].sort((a, b) => (linkId(a) < linkId(b) ? -1 : linkId(a) > linkId(b) ? 1 : 0)),
  };
}

function loadCatalog(): WidgetCatalog {
  return JSON.parse(readFileSync(join(fixturesDir, "catalog.json"), "utf8")) as WidgetCatalog;
}

test.todo(
  "session replay — blocked on the applier ticket: applyOps/project/mint are stubs; fixtures/*.session.jsonl are already in place (format: fixtures/README.md)",
);

describe("fixture corpus", () => {
  it("ships the three spike sessions with base + final workflows", () => {
    expect(sessions.length).toBeGreaterThanOrEqual(3);
    for (const file of sessions) {
      const firstLine = readFileSync(join(fixturesDir, file), "utf8").split("\n", 1)[0]!;
      const header = JSON.parse(firstLine) as SessionHeader;
      expect(header.session, `${file} header`).toBeTruthy();
      expect(header.base_workflow?.nodes, `${file} base_workflow`).toBeDefined();
      expect(header.workflow_final?.nodes, `${file} workflow_final`).toBeDefined();
    }
  });

  it("ships the pinned catalog the projection depends on", () => {
    const catalog = loadCatalog();
    expect(Object.keys(catalog.types).length).toBeGreaterThan(0);
    expect(catalog.types["KSampler"]?.widget_order).toContain("steps");
  });
});

describe.runIf(APPLIER_LANDED)("session replay", () => {
  const catalog = loadCatalog();

  for (const file of sessions) {
    it(`replays ${file} from base_workflow to the recorded final workflow`, () => {
      const lines = readFileSync(join(fixturesDir, file), "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0);
      expect(lines.length, "header line + at least one op").toBeGreaterThanOrEqual(2);

      const header = JSON.parse(lines[0]!) as SessionHeader;
      const ops = lines.slice(1).map((l) => JSON.parse(l) as Op);

      const doc = mint(header.base_workflow, catalog);
      const result = applyOps(doc, ops, `replay:${header.session}`, catalog);
      expect(result.rejected).toEqual([]);

      expect(canonicalize(project(doc, catalog))).toEqual(canonicalize(header.workflow_final));
    });
  }
});
