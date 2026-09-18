import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import { linksMap, nodesMap } from "../src/doc.js";
import { mint } from "../src/index.js";
import type { WorkflowJSON } from "../src/index.js";
import { checkGraphInvariants } from "./graph-invariant-oracle.js";

const catalog = { types: {} };
const workflow: WorkflowJSON = {
  nodes: [
    { id: 1, type: "Source", inputs: [], outputs: [{ name: "OUT", type: "X", links: [10] }], widgets_values: [] },
    { id: 2, type: "Destination", inputs: [{ name: "IN", type: "X", link: 10 }], outputs: [], widgets_values: [] },
  ],
  links: [[10, 1, 0, 2, 0, "X"]],
};

function freshDoc(): Y.Doc {
  return mint(workflow, catalog);
}

describe("checkGraphInvariants test oracle", () => {
  it("accepts a graph satisfying I1 through I5 without changing the doc", () => {
    const doc = freshDoc();
    const before = Y.encodeStateAsUpdate(doc);

    expect(checkGraphInvariants(doc)).toEqual([]);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it("reports unresolved input and output references", () => {
    const doc = freshDoc();
    const source = nodesMap(doc).get("1")!;
    const destination = nodesMap(doc).get("2")!;
    const outputLinks = (source.get("outputs") as Y.Array<Y.Map<unknown>>).get(0)!.get("links") as Y.Array<unknown>;
    const input = (destination.get("inputs") as Y.Array<Y.Map<unknown>>).get(0)!;
    outputLinks.push([99]);
    input.set("link", 98);

    expect(checkGraphInvariants(doc).map((item) => item.invariant)).toEqual(["I1", "I2", "I4"]);
  });

  it("reports missing tuple endpoints", () => {
    const doc = freshDoc();
    linksMap(doc).set("11", [11, 404, 0, 405, 0, "X"]);

    expect(checkGraphInvariants(doc).filter((item) => item.invariant === "I3")).toHaveLength(2);
  });

  it("reports a short link tuple as I3 without changing the doc", () => {
    const doc = freshDoc();
    linksMap(doc).set("short", ["short", 1, 0, 2]);
    const before = Y.encodeStateAsUpdate(doc);

    expect(checkGraphInvariants(doc).filter((item) => item.invariant === "I3")).toEqual([
      {
        invariant: "I3",
        path: 'links["short"]',
        message: "link entry is not a tuple with node endpoints",
      },
    ]);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it("reports negative source and destination slots as I4 without changing the doc", () => {
    const doc = freshDoc();
    const links = linksMap(doc);
    links.delete("10");
    links.set("negative", ["negative", 1, -1, 2, -2, "X"]);
    const before = Y.encodeStateAsUpdate(doc);

    expect(checkGraphInvariants(doc).filter((item) => item.invariant === "I4")).toEqual([
      {
        invariant: "I4",
        path: 'links["negative"][2]',
        message: "source output (1, -1) does not advertise link negative",
      },
      {
        invariant: "I4",
        path: 'links["negative"][4]',
        message: "destination input (2, -2) does not carry link negative",
      },
    ]);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it("reports links-to-slots disagreement", () => {
    const doc = freshDoc();
    const source = nodesMap(doc).get("1")!;
    const destination = nodesMap(doc).get("2")!;
    const outputLinks = (source.get("outputs") as Y.Array<Y.Map<unknown>>).get(0)!.get("links") as Y.Array<unknown>;
    const input = (destination.get("inputs") as Y.Array<Y.Map<unknown>>).get(0)!;
    outputLinks.delete(0);
    input.set("link", null);

    expect(checkGraphInvariants(doc).filter((item) => item.invariant === "I4")).toHaveLength(2);
  });

  it("reports two tuples claiming one input register", () => {
    const doc = freshDoc();
    linksMap(doc).set("11", [11, 1, 0, 2, 0, "X"]);

    expect(checkGraphInvariants(doc).map((item) => item.invariant)).toContain("I5");
  });

  it("reports exact I5 diagnostics independently of link insertion order", () => {
    const diagnosticsFor = (keys: string[]) => {
      const doc = freshDoc();
      const links = linksMap(doc);
      links.delete("10");
      for (const key of keys) links.set(key, [key, 1, 0, 2, 0, "X"]);

      return checkGraphInvariants(doc).filter((item) => item.invariant === "I5");
    };
    const expected = [
      {
        invariant: "I5",
        path: 'links["11"]',
        message: "input register (2, 0) is also claimed by link 100",
      },
      {
        invariant: "I5",
        path: 'links["2"]',
        message: "input register (2, 0) is also claimed by link 100",
      },
    ];

    expect(diagnosticsFor(["100", "11", "2"])).toEqual(expected);
    expect(diagnosticsFor(["2", "11", "100"])).toEqual(expected);
  });
});
