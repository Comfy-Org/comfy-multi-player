#!/usr/bin/env node
/**
 * Generator + drift gate for `.coderabbit.yaml`'s `reviews.path_instructions`.
 *
 * WHY THIS EXISTS. `path_instructions` is a machine-consumed restatement of the
 * prose profiles in `.agents/checks/`. It was hand-written, and it drifted: the
 * `test/**` block and `.agents/checks/test-quality.md` were born in one commit
 * (#43, `7c454eb`) carrying the same wrong rejection oracle, and each of the two
 * later PRs that set out to fix it fixed only the copy it could see — neither
 * copy was greppable from the other, and the YAML one is the copy that actually
 * runs on every PR. Substring tripwires (`npm run check:profile-claims`) can
 * detect that divergence after the fact; they cannot prevent it. This makes the
 * YAML a build product of the profiles, so there is one editable copy.
 *
 * SOURCE OF TRUTH. Each entry is authored inside the profile that owns it, in a
 * delimited block:
 *
 *   <!-- coderabbit-instructions: test/** -->
 *   ```text
 *   ...the instruction the bot receives, verbatim...
 *   ```
 *   <!-- /coderabbit-instructions -->
 *
 * The block body is whitespace-normalized to a single paragraph and emitted as a
 * YAML folded scalar (`>-`), so authoring line breaks are free.
 *
 * COEXISTENCE. The generator owns exactly the region between the two sentinel
 * comment lines in `.coderabbit.yaml` and splices; every other key in that file
 * is hand-written and preserved byte-for-byte. A generated file that could not
 * carry hand-written config would be a worse trade than the drift it prevents.
 *
 * USAGE
 *   node scripts/gen-coderabbit-config.mjs            check for drift (CI)
 *   node scripts/gen-coderabbit-config.mjs --write    regenerate the file
 *
 * Exit codes (`.agents/checks/README.md` gate convention):
 *   0  PASS   — the file on disk matches what the profiles generate
 *   1  FAIL   — drift; run `npm run gen:coderabbit`
 *   2  INCONCLUSIVE — it could not run over a meaningful unit of work: the
 *      sentinels are missing, or fewer than MIN_BLOCKS source blocks were found
 *      (which would let a deleted block look like a clean regeneration)
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// CODERABBIT_GEN_ROOT lets the test drive the generator over a fixture tree.
const root = process.env.CODERABBIT_GEN_ROOT || dirname(dirname(fileURLToPath(import.meta.url)));
const checksDir = join(root, ".agents", "checks");
const configPath = join(root, ".coderabbit.yaml");

// Floor on the unit of work. Raise it when a block is added; never lower it to
// make a run pass — the whole point is that a silently-dropped block must not
// regenerate to a smaller, still-valid config. Mirrors MIN_MODULES in
// scripts/check-import-graph.mjs.
const MIN_BLOCKS = 5;

const BEGIN = "  # BEGIN GENERATED path_instructions";
const END = "  # END GENERATED path_instructions";

// Total line width of an emitted instruction line, indent included.
const WIDTH = 79;
const INDENT = " ".repeat(8);

// Anchored at column 0 (`^` with `m`), so an *indented* copy of the syntax is a
// documentation example rather than a source block — which is how
// .agents/checks/README.md can show the marker while also hosting three real
// blocks. OPEN_RE then catches a real block whose body is malformed: a marker at
// column 0 that produced no block is a dropped instruction, and silence there
// would regenerate a smaller config that still parses.
const BLOCK_RE =
  /^<!--\s*coderabbit-instructions:\s*(.+?)\s*-->\r?\n```text\r?\n([\s\S]*?)\r?\n```\r?\n<!--\s*\/coderabbit-instructions\s*-->/gm;
const OPEN_RE = /^<!--\s*coderabbit-instructions:/gm;

const fail = (message, code) => {
  console.error(message);
  process.exit(code);
};

/** One paragraph, single-spaced. Authoring line breaks carry no meaning. */
const normalize = (body) => body.trim().split(/\s+/).join(" ");

/** Greedy wrap. Deterministic, so regeneration is a fixpoint. */
function wrap(text) {
  const lines = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line === "") line = word;
    else if (INDENT.length + line.length + 1 + word.length <= WIDTH) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}

/**
 * Read a YAML folded scalar back. Used to prove the emission is lossless rather
 * than assuming it: a folded scalar joins its lines with single spaces, so
 * unfolding an emitted block must return the normalized body exactly.
 */
const unfold = (lines) => lines.join(" ");

function collectBlocks() {
  const blocks = [];
  const names = readdirSync(checksDir)
    .filter((name) => name.endsWith(".md"))
    .sort();
  for (const name of names) {
    const text = readFileSync(join(checksDir, name), "utf8");
    const opened = [...text.matchAll(OPEN_RE)].length;
    const matched = [...text.matchAll(BLOCK_RE)].length;
    if (opened !== matched) {
      fail(
        `coderabbit-config: ${name} has ${opened} instruction marker(s) at column 0 but ` +
          `${matched} well-formed block(s).\n` +
          "A block is the opening marker, a ```text fence, and the closing marker, each on its\n" +
          "own line at column 0. Indent the whole thing to make it a documentation example.",
        1,
      );
    }
    for (const match of text.matchAll(BLOCK_RE)) {
      const path = match[1];
      const body = normalize(match[2]);
      if (path.includes('"')) {
        fail(
          `coderabbit-config: path glob contains a double quote, which the emitter cannot quote: ${path}`,
          1,
        );
      }
      if (body === "") {
        fail(`coderabbit-config: empty instruction block for ${path} in ${name}`, 1);
      }
      blocks.push({ path, body, source: `.agents/checks/${name}` });
    }
  }
  return blocks;
}

function render(blocks) {
  const out = [
    BEGIN,
    "  #",
    "  # Generated by `npm run gen:coderabbit` from the",
    "  # <!-- coderabbit-instructions: <glob> --> blocks in .agents/checks/*.md.",
    "  # Do not edit between the sentinels; edit the block in the profile that owns",
    "  # the glob and regenerate. `npm run check:coderabbit` fails CI on drift.",
    "  #",
    "  # This list is the copy of the profiles that actually runs on every PR. When",
    "  # it was hand-written it diverged from them silently and stayed wrong through",
    "  # two PRs that each fixed only the copy they could see.",
    "  #",
    "  # Everything outside the sentinels in this file is hand-written and is",
    "  # preserved by the generator.",
    "  path_instructions:",
  ];
  for (const block of blocks) {
    const lines = wrap(block.body);
    if (unfold(lines) !== block.body) {
      fail(
        `coderabbit-config: emission is not lossless for ${block.path} — refusing to write.\n` +
          "A word longer than the line budget, or a folding artifact, changed the text.",
        1,
      );
    }
    out.push(`    - path: "${block.path}"`);
    out.push(`      # source: ${block.source}`);
    out.push("      instructions: >-");
    for (const line of lines) out.push(INDENT + line);
  }
  out.push(END);
  return out.join("\n");
}

const blocks = collectBlocks();
if (blocks.length < MIN_BLOCKS) {
  fail(
    `coderabbit-config check INCONCLUSIVE — found ${blocks.length} instruction block(s) in ` +
      `.agents/checks/*.md, below the floor of ${MIN_BLOCKS}.\n` +
      "A dropped block would otherwise regenerate to a smaller config that still parses.",
    2,
  );
}

const duplicate = blocks.map((b) => b.path).find((p, i, all) => all.indexOf(p) !== i);
if (duplicate) {
  fail(`coderabbit-config: two instruction blocks claim the same glob: ${duplicate}`, 1);
}

const current = readFileSync(configPath, "utf8");
const lines = current.split("\n");
const begin = lines.indexOf(BEGIN);
const end = lines.indexOf(END);
if (begin === -1 || end === -1 || end < begin) {
  fail(
    "coderabbit-config check INCONCLUSIVE — .coderabbit.yaml has no generated region.\n" +
      `Expected the sentinel lines:\n${BEGIN}\n${END}`,
    2,
  );
}

const expected = [...lines.slice(0, begin), render(blocks), ...lines.slice(end + 1)].join("\n");

if (process.argv.includes("--write")) {
  writeFileSync(configPath, expected);
  console.log(
    `coderabbit-config written — ${blocks.length} instruction block(s) from ` +
      `${new Set(blocks.map((b) => b.source)).size} profile(s).`,
  );
  process.exit(0);
}

if (expected !== current) {
  const a = expected.split("\n");
  const b = current.split("\n");
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  console.error(
    "coderabbit-config check FAILED — .coderabbit.yaml does not match the profiles.\n\n" +
      `  first difference at line ${i + 1}:\n` +
      `    profiles generate: ${JSON.stringify(a[i] ?? "<end of file>")}\n` +
      `    .coderabbit.yaml:  ${JSON.stringify(b[i] ?? "<end of file>")}\n\n` +
      "Edit the <!-- coderabbit-instructions --> block in the owning profile, then run\n" +
      "`npm run gen:coderabbit`. Do not edit the generated region directly.",
  );
  process.exit(1);
}

console.log(
  `coderabbit-config check PASSED (${blocks.length} instruction block(s) from ` +
    `${new Set(blocks.map((b) => b.source)).size} profile(s) match .coderabbit.yaml)`,
);
