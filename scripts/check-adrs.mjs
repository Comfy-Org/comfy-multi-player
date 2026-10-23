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
    if (!contents.split(/\r?\n/, 1)[0]?.startsWith(`# ADR-${identifier}: `)) {
      throw new Error(
        `${filename}: expected heading "# ADR-${identifier}: Title"`,
      );
    }
    const dateMatch = /^Date: (\d{4})-(\d{2})-(\d{2})$/m.exec(contents);
    const statusIndex = contents.search(/^## Status[ \t]*$/m);
    if (!dateMatch || statusIndex < 0 || (dateMatch.index ?? 0) > statusIndex) {
      throw new Error(`${filename}: missing a valid Date field`);
    }
    const [, year, month, day] = dateMatch;
    const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    if (
      parsed.getUTCFullYear() !== Number(year) ||
      parsed.getUTCMonth() !== Number(month) - 1 ||
      parsed.getUTCDate() !== Number(day)
    ) {
      throw new Error(`${filename}: missing a valid Date field`);
    }
    if (
      !/^## Status[ \t]*\r?\n(?:[ \t]*\r?\n)*(Proposed|Accepted|Rejected|Deprecated|Superseded)[ \t]*$/m.test(
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
