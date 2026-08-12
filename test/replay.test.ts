/**
 * Session replay runner: for every fixtures/<name>.session.jsonl, apply the
 * recorded ops to a fresh doc and assert the projection deep-equals the
 * recorded final workflow.
 *
 * SKIPPED until the applier lands: applyOps/project are NotImplemented stubs
 * in the V1-030 scaffold, and fixtures are delivered by the separate
 * fixtures + first-draft-applier spike. Flip APPLIER_LANDED when both exist.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, test } from "vitest";
import * as Y from "yjs";
import { applyOps, initDoc, project, type Op, type WorkflowJSON } from "../src/index.js";

const APPLIER_LANDED = false; // flip when applyOps/project are real (applier spike)

const fixturesDir = join(dirname(dirname(fileURLToPath(import.meta.url))), "fixtures");
const sessions = existsSync(fixturesDir)
  ? readdirSync(fixturesDir).filter((f) => f.endsWith(".session.jsonl"))
  : [];

interface SessionHeader {
  session: string;
  source: string;
  workflow_final: WorkflowJSON;
}

test.todo(
  "session replay — blocked on the applier spike: applyOps/project are stubs and fixtures/*.session.jsonl do not exist yet (format: fixtures/README.md)",
);

describe.runIf(APPLIER_LANDED)("session replay", () => {
  it("has at least one recorded session", () => {
    expect(sessions.length).toBeGreaterThan(0);
  });

  for (const file of sessions) {
    it(`replays ${file} to the recorded final workflow`, () => {
      const lines = readFileSync(join(fixturesDir, file), "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0);
      expect(lines.length, "header line + at least one op").toBeGreaterThanOrEqual(2);

      const header = JSON.parse(lines[0]!) as SessionHeader;
      expect(header.workflow_final, `${file} header missing workflow_final`).toBeDefined();
      const ops = lines.slice(1).map((l) => JSON.parse(l) as Op);

      const doc = initDoc(new Y.Doc());
      const result = applyOps(doc, ops, `replay:${header.session}`);
      expect(result.rejected).toEqual([]);

      expect(project(doc)).toEqual(header.workflow_final);
    });
  }
});
