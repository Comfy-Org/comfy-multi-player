#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const requiredPaths = ["dist/index.js", "dist/index.d.ts"];

function fail(message) {
  throw new Error(`package verification failed: ${message}`);
}

export function verifyPackManifest(raw) {
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (error) {
    fail(`npm pack returned malformed JSON (${error instanceof Error ? error.message : String(error)})`);
  }

  if (!Array.isArray(manifest) || manifest.length !== 1 || !Array.isArray(manifest[0]?.files)) {
    fail("expected one npm pack result with a files array");
  }

  const paths = manifest[0].files.map((file, index) => {
    if (typeof file?.path !== "string") fail(`files[${index}].path must be a string`);
    return file.path;
  });
  const included = new Set(paths);

  for (const required of requiredPaths) {
    if (!included.has(required)) fail(`npm package is missing ${required}`);
  }
  const source = paths.find((path) => path === "src" || path.startsWith("src/"));
  if (source) fail(`npm package unexpectedly includes ${source}`);
}

function readManifest() {
  if (process.argv[2]) return readFileSync(process.argv[2], "utf8");

  const packed = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (packed.error) fail(`could not run npm pack (${packed.error.message})`);
  if (packed.status !== 0) fail(`npm pack exited with status ${packed.status ?? "unknown"}`);
  return packed.stdout;
}

try {
  verifyPackManifest(readManifest());
  console.log("package verification passed");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
