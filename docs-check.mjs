#!/usr/bin/env node
// docs-check — does the README still describe the data that actually exists?
//
//   node docs-check.mjs        # exits 1 if the docs and the CSV disagree
//
// Why this exists: in a single day I shipped three READMEs describing a schema that had
// already changed — a 12-column table for a 33-column file, then a 33-column claim for a
// 39-column file whose six most important columns were undocumented. Each time the code
// moved and the prose did not.
//
// Numbers get corrected when someone re-runs them. Stale prose just quietly misinforms
// until a reader notices, which is worse and slower. This is the verifier for the words.
//
// Written by an autonomous AI agent (Claude Code). MIT.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const csvPath = join(HERE, "data", "index.csv");
const readmePath = join(HERE, "README.md");

if (!existsSync(csvPath) || !existsSync(readmePath)) {
  console.error("missing data/index.csv or README.md");
  process.exitCode = 2;
} else {
  const header = readFileSync(csvPath, "utf8").split(/\r?\n/)[0].split(",").map((s) => s.trim());
  const readme = readFileSync(readmePath, "utf8");

  let problems = 0;
  const fail = (msg) => { console.log(`FAIL  ${msg}`); problems++; };
  const pass = (msg) => console.log(`PASS  ${msg}`);

  // 1. Every column must appear somewhere in the README, in backticks.
  //    A column nobody documented is a column nobody can use.
  const undocumented = header.filter((c) => c !== "date" && !readme.includes("`" + c + "`"));
  if (undocumented.length) fail(`${undocumented.length} undocumented column(s): ${undocumented.join(", ")}`);
  else pass(`all ${header.length} columns documented`);

  // 2. The README must not describe columns that no longer exist. Removals are allowed
  //    ONLY if explicitly marked, so historical readers of archived CSVs are not stranded.
  const mentioned = [...readme.matchAll(/`([a-z0-9_]{3,})`/g)].map((m) => m[1]);
  const looksLikeColumn = (s) => /_/.test(s) && !/\.(mjs|csv|json|md)$/.test(s);
  const ghost = [...new Set(mentioned)]
    .filter(looksLikeColumn)
    .filter((c) => !header.includes(c))
    // A removal note must name the column near the word "Removed" — in EITHER order on the
    // same line. The original pattern only matched "Removed ... `col`", which a Markdown
    // table can never satisfy: the column name is always in the first cell, so the note
    // reads "| `col` | **Removed** …". That made a correctly-documented removal fail, which
    // is the same class of bug as a checker that silently passes — the check was testing my
    // sentence order rather than whether the removal was documented.
    .filter((c) => !new RegExp(`(Removed[^\\n]*\`${c}\`|\`${c}\`[^\\n]*Removed)`, "i").test(readme));
  if (ghost.length) fail(`README documents ${ghost.length} column(s) that no longer exist and are not marked Removed: ${ghost.join(", ")}`);
  else pass("no undead columns");

  // 3. Any stated column count must match reality.
  // Tolerate punctuation inside the bold ("**39 columns.**") — the first version of this
  // regex missed exactly that and silently SKIPped, which is the failure mode this whole
  // script exists to prevent.
  const claimed = [...readme.matchAll(/\*\*(\d+)\s+columns[.,:]?\*\*/g)].map((m) => Number(m[1]));
  if (!claimed.length) console.log("SKIP  README states no column count");
  else if (claimed.every((n) => n === header.length)) pass(`stated column count ${header.length} matches`);
  else fail(`README claims ${claimed.join("/")} columns; the file has ${header.length}`);

  console.log(problems ? `\n${problems} problem(s) — the docs and the data disagree.`
                       : "\nREADME matches the data.");
  process.exitCode = problems ? 1 : 0;
}
