#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ADR_FILE_PATTERN =
  /^([A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)?-\d{4})-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;

export function validateAdrDirectory(directory) {
  const entries = readdirSync(directory, { withFileTypes: true });
  const markdownFiles = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  const invalidFiles = markdownFiles.filter(
    (filename) => !ADR_FILE_PATTERN.test(filename),
  );
  if (invalidFiles.length > 0) {
    throw new Error(`Invalid ADR filenames: ${invalidFiles.join(", ")}`);
  }

  const identifiers = [];
  for (const filename of markdownFiles) {
    const identifier = ADR_FILE_PATTERN.exec(filename)?.[1];
    if (!identifier) throw new Error(`Invalid ADR filename: ${filename}`);
    identifiers.push(identifier);

    const contents = readFileSync(join(directory, filename), "utf8");
    if (!new RegExp(`^# ADR-${identifier}: .+$`, "m").test(contents)) {
      throw new Error(
        `${filename}: expected heading "# ADR-${identifier}: Title"`,
      );
    }
    if (!/^Date: \d{4}-\d{2}-\d{2}$/m.test(contents)) {
      throw new Error(`${filename}: missing a valid Date field`);
    }
    if (
      !/^## Status\s+\n+(?:\s*\n)*(Proposed|Accepted|Rejected|Deprecated|Superseded)\b/m.test(
        contents,
      )
    ) {
      throw new Error(`${filename}: missing a valid Status value`);
    }
  }

  const duplicates = identifiers.filter(
    (identifier, index) => identifiers.indexOf(identifier) !== index,
  );
  if (duplicates.length > 0) {
    throw new Error(
      `Duplicate ADR identifiers: ${[...new Set(duplicates)].join(", ")}`,
    );
  }

  for (const companion of entries.filter((entry) => entry.isDirectory())) {
    if (!markdownFiles.includes(`${companion.name}.md`)) {
      throw new Error(
        `ADR companion directory has no matching ADR: ${companion.name}`,
      );
    }
  }
}

if (process.argv[1] && existsSync(process.argv[1])) {
  validateAdrDirectory(join(process.cwd(), "docs", "adr"));
  process.stdout.write("ADR validation passed\n");
}
