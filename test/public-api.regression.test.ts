/**
 * Guards the package's public entrypoint surface.
 *
 * KA-3 / FC-3: the op layer is the only sanctioned way to mutate shared state.
 * Re-exporting `src/doc.ts` from `src/index.ts` handed consumers the raw Y.Doc
 * layout and low-level mutators, so a caller could write the shared document
 * without going through `applyOps` and bypass stamp gating (KA-2), idempotency
 * and convergence (KA-4), and the catalog check at mint (KA-12).
 *
 * The internals list is derived from `src/doc.ts` at runtime rather than
 * hardcoded, so a newly added document internal is covered the moment it exists.
 */
import { describe, expect, it } from "vitest";
import * as documentInternals from "../src/doc.js";
import * as publicApi from "../src/index.js";

describe("public API", () => {
  /**
   * Regression: document internals were re-exported from the package entrypoint.
   * Fix: #18 — https://github.com/Comfy-Org/comfy-multi-player/issues/18
   */
  it("regression: keeps every src/doc.ts runtime export off the package entrypoint", () => {
    const internalNames = Object.keys(documentInternals);
    expect(internalNames.length).toBeGreaterThan(0);

    for (const name of internalNames) {
      expect(publicApi, `${name} must remain module-private`).not.toHaveProperty(name);
    }
  });

  it("still exposes the op layer and stamp helpers", () => {
    expect(publicApi).toEqual(
      expect.objectContaining({
        mint: expect.any(Function),
        applyOps: expect.any(Function),
        project: expect.any(Function),
        migrate: expect.any(Function),
        compareStampKeys: expect.any(Function),
        stampKey: expect.any(Function),
        writeTarget: expect.any(Function),
      }),
    );
  });
});
