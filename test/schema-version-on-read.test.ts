import { describe, expect, it } from "vitest";
import {
  SCHEMA_VERSION,
  SchemaVersionError,
  metaMap,
  migrate,
  mint,
} from "../src/index.js";
import { loadCatalog } from "./helpers.js";

describe("schema version on read", () => {
  it("fails closed when the stored schema is newer than this reader", () => {
    const doc = mint({ nodes: [], links: [] }, loadCatalog());
    metaMap(doc).set("schema_version", SCHEMA_VERSION + 1);

    // project() currently has no schema-version guard. migrate() is therefore
    // the intended fail-closed read entrypoint hosts must call before project().
    expect(() => migrate(doc, SCHEMA_VERSION)).toThrow(SchemaVersionError);
    expect(() => migrate(doc, SCHEMA_VERSION)).toThrow(/schema_version/);
  });
});
