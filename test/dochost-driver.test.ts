import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { applyOps, mint, project, type Op, type WidgetCatalog, type WorkflowJSON } from "../src/index.js";

type Body = Record<string, unknown>;
const servers: ReturnType<typeof createServer>[] = [];

async function run(mode = "match", packageRoot = resolve(".")) {
  const requests: { path: string; body: Body }[] = [];
  let applyNumber = 0;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as Body : {};
    requests.push({ path: req.url!, body });
    res.setHeader("content-type", "application/json");
    if (req.url === "/health") return res.end('{"ok":true,"fixture":"loopback-not-cloud"}');
    if (req.url === "/mint") {
      const doc = mint(body.workflow as WorkflowJSON, body.catalog as WidgetCatalog);
      return res.end(JSON.stringify({ snapshot_b64: Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64") }));
    }
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Buffer.from(body.snapshot_b64 as string, "base64"));
    for (const update of body.updates_b64 as string[]) Y.applyUpdate(doc, Buffer.from(update, "base64"));
    if (req.url === "/project") return res.end(JSON.stringify({ projection: project(doc, body.catalog as WidgetCatalog) }));
    const before = Y.encodeStateVector(doc);
    let apply_result: Body = applyOps(doc, body.ops as Op[], body.catalog as WidgetCatalog) as unknown as Body;
    const projectionResult = project(doc, body.catalog as WidgetCatalog);
    applyNumber++;
    if (mode === "legacy" && applyNumber === 1) apply_result = { applied: [(body.ops as Op[])[0]!.op_id] };
    if (mode === "outcome" && applyNumber === 1) {
      apply_result = structuredClone(apply_result);
      (apply_result.outcomes as { outcome: string }[])[0]!.outcome = "no-op";
    }
    if (mode === "order" && applyNumber === 2) {
      apply_result = structuredClone(apply_result);
      (apply_result.outcomes as unknown[]).reverse();
    }
    if (mode === "count" && applyNumber === 1) apply_result = { ...apply_result, ops_seen: (apply_result.ops_seen as number) + 1 };
    if (mode === "reason" && applyNumber === 3) {
      apply_result = structuredClone(apply_result);
      ((apply_result.outcomes as Body[])[0]!.reason as Body).code = "different_code";
      ((apply_result.outcomes as Body[])[0]!.reason as Body).message = "message changes are deliberately ignored";
    }
    if (mode === "message" && applyNumber === 3) {
      apply_result = structuredClone(apply_result);
      ((apply_result.outcomes as Body[])[0]!.reason as Body).message = "different volatile prose";
    }
    const projection = mode === "projection" && applyNumber === 1 ? { ...projectionResult, extra: true } : projectionResult;
    res.end(JSON.stringify({ apply_result, projection, update_b64: Buffer.from(Y.encodeStateAsUpdate(doc, before)).toString("base64") }));
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing loopback address");
  const child = spawn(process.execPath, [resolve("examples/dochost-poc/dochost-driver.mjs")], {
    cwd: resolve("."),
    env: { ...process.env, DOC_HOST: `http://127.0.0.1:${address.port}`, CMP_PIN: packageRoot },
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const code = await new Promise<number | null>((done) => child.on("close", done));
  return { code, output, requests };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
});

describe("dochost driver executable-package oracle (tiny loopback fixture, not cloud)", () => {
  it("matches outcomes/projections and forks every comparison from one bootstrap", async () => {
    const result = await run();
    expect(result.code, result.output).toBe(0);
    expect(result.requests.filter((request) => request.path === "/mint")).toHaveLength(1);
    const applies = result.requests.filter((request) => request.path === "/apply");
    expect(applies).toHaveLength(3);
    expect(applies.map(({ body }) => (body.updates_b64 as string[]).length)).toEqual([0, 1, 2]);
    const hostUpdates = applies.map(({ body }) => body.updates_b64 as string[]).flat();
    expect(hostUpdates).toHaveLength(3);
    expect(result.output).toContain("host: agent link present");
  });

  it("ignores volatile rejection message prose", async () => {
    const result = await run("message");
    expect(result.code, result.output).toBe(0);
  });

  it("imports the executable package from a path containing spaces and URL delimiters", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cmp-driver-"));
    const checkout = join(directory, "checkout # with spaces");
    try {
      symlinkSync(resolve("."), checkout, "dir");
      const result = await run("match", checkout);
      expect(result.code, result.output).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ["outcome", "FAIL  human ApplyResult matches local executable package"],
    ["order", "FAIL  agent ApplyResult matches local executable package"],
    ["count", "FAIL  human ApplyResult matches local executable package"],
    ["reason", "FAIL  rejected ApplyResult and stable reason code match local executable package"],
    ["legacy", "sidecar returned legacy/invalid ApplyResult"],
    ["projection", "FAIL  human projection matches local executable package"],
  ])(
    "fails closed for %s drift even when other sidecar data matches",
    async (mode, expectedFailure) => {
      const result = await run(mode);
      expect(result.code, result.output).toBe(1);
      expect(result.output).toContain(expectedFailure);
    },
  );
});
