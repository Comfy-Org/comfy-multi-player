/**
 * The KA-11 read gate: schema-version discipline enforced ON READ.
 *
 * KA-11's rule is "fail closed on unreadable schema and provide a `migrate()`
 * path". `migrate()` is the *provided path*; it is not the gate, because
 * nothing forces a caller through it. `project()` is what actually turns a
 * document into the graph every consumer reads, so the gate has to live there
 * too — a guard a low-context caller can skip is documentation, not
 * enforcement (issue #38).
 *
 * This module holds the ONE definition of "what schema version does this
 * document claim, and may this package read it", so the read path and the
 * migration path cannot drift into two conventions.
 */

import type * as Y from "yjs";
import { SCHEMA_VERSION, SchemaVersionError } from "./types.js";

/**
 * The `meta` root's name. Spelled literally rather than reached through
 * `doc.ts`'s `metaMap()` on purpose: `Y.Doc#getMap` CREATES an absent root and
 * registers it in `doc.share`, which would turn this inspection into a repair.
 * See {@link readSchemaVersion}.
 */
const META_ROOT = "meta";

/**
 * The document's OWN claim about its layout version, read without
 * materializing anything, or `undefined` when there is no readable claim.
 *
 * "Unreadable" is three cases, and all three are fail-closed for a reader
 * (never a default to fill in):
 *
 *   1. the `meta` root is absent — a root type appears in `doc.share` only
 *      once it carries content, so `doc.share.has()` is precisely the question
 *      "does this document carry a readable meta map", and asking it does not
 *      create one;
 *   2. `meta` carries no `schema_version`;
 *   3. `schema_version` is not a positive integer (a string `"1"`, `null`, a
 *      float, `0`, …) — a value that is not a version cannot be compared to
 *      one.
 *
 * Typing a root that is ALREADY present (Yjs `AbstractType` → `Y.Map`, which
 * is how a replica's roots arrive from `Y.applyUpdate`) creates no struct and
 * no new share key, so this read stays byte-exact under
 * `encodeStateAsUpdate`.
 *
 * Exported from the entrypoint because a host has the same question to answer
 * BEFORE it reads: the doc host's `/project` endpoint already refuses a
 * catalog-pin mismatch by comparing `meta.catalog_version` and returning a
 * structured `catalog_mismatch` body, rather than by catching a throw, and a
 * schema mismatch wants the same shape. The gate below is the backstop for a
 * caller that does not pre-check.
 */
export function readSchemaVersion(doc: Y.Doc): number | undefined {
  if (!doc.share.has(META_ROOT)) return undefined;
  const stored = doc.getMap<unknown>(META_ROOT).get("schema_version");
  if (typeof stored !== "number" || !Number.isInteger(stored) || stored < 1) return undefined;
  return stored;
}

/**
 * {@link assertReadableSchema} against an explicit reader version.
 *
 * NOT re-exported from the entrypoint, deliberately: a caller free to choose
 * `expected` could pass the document's own version and switch the gate off.
 * It is exported from this module so the "document is OLDER than the reader"
 * arm is reachable by test today — at `SCHEMA_VERSION = 1` no older version
 * exists to construct, and an arm no test can turn red is dead code, which is
 * the vacuous-coverage trap this repo keeps hitting.
 */
export function assertSchemaVersionAgainst(doc: Y.Doc, context: string, expected: number): void {
  const stored = readSchemaVersion(doc);
  if (stored === undefined) {
    throw new SchemaVersionError(
      `${context}: doc has no readable meta.schema_version — refusing to read (fail-closed, schema §10)`,
    );
  }
  if (stored > expected) {
    throw new SchemaVersionError(
      `${context}: doc schema v${stored} is newer than this package's v${expected} — refusing to read (fail-closed, schema §10)`,
    );
  }
  if (stored < expected) {
    throw new SchemaVersionError(
      `${context}: doc schema v${stored} is older than this package's v${expected} — call migrate(doc, ${stored}) first, then read (fail-closed, schema §10)`,
    );
  }
}

/**
 * Refuse to read a document whose layout this package cannot describe
 * (KA-11). `context` names the read entrypoint for the message.
 *
 * WHY AN OLDER DOCUMENT IS REFUSED RATHER THAN MIGRATED IN PLACE. `project()`
 * is a pure read: it takes a `Y.Doc`, returns JSON, and every replica —
 * browser follower included — calls it. Migrating inside it would make a read
 * WRITE the shared document, which breaks two rules at once. Schema §10 makes
 * migration host-only (followers receive the migrated document via the struct
 * stream or a new epoch), so a follower that self-migrated would produce an
 * independently edited document and open the FC-1 struct-divergence path. And
 * an in-place upgrade hidden inside a read is unstamped (KA-2) and invisible
 * to the op log (KA-1). So the version transition stays where it can be
 * audited: the caller runs `migrate(doc, storedVersion)` on the host, and only
 * then reads. Projecting an older layout as-is is not an option either — that
 * IS the mis-projection KA-11 names.
 *
 * Consistent with `migrate()` by construction: same failure type
 * (`SchemaVersionError`), same notion of unreadable, same wording for a
 * too-new document, and the same refusal to materialize a root on the failure
 * path — a rejected read leaves `encodeStateAsUpdate(doc)` byte-identical and
 * `doc.share` untouched.
 */
export function assertReadableSchema(doc: Y.Doc, context: string): void {
  assertSchemaVersionAgainst(doc, context, SCHEMA_VERSION);
}
