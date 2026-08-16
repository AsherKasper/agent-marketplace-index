#!/usr/bin/env node
// Merge every schema generation into one time series.
//
//   node merge-history.mjs        # writes data/history.csv
//
// Why this exists: the schema guard archives `index.csv` to `index-vN.csv` whenever a column
// is added, so history never accumulates in one file. After eight schema changes the "daily
// series" was NINE files of ONE row each, while the README promised "one row per day, the
// whole history". The guard was right — appending mismatched rows would corrupt the data —
// but rotating without ever re-joining leaves the reader to do it, and most will not.
//
// The union is the honest join: every column that has ever existed, one row per date, EMPTY
// where a column did not exist on that day. Empty means "not collected", never zero.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DATA = join(dirname(fileURLToPath(import.meta.url)), "data");

// Split a CSV line on commas that are not inside double quotes.
const split = (line) => {
  const out = []; let cur = "", q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === "," && !q) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
};

const files = readdirSync(DATA).filter((f) => /^index(-v\d+)?\.csv$/.test(f));
if (!files.length) throw new Error("no index CSVs found — check DATA path");

const byDate = new Map();     // date -> { column: value }
const columns = [];           // union, in first-seen order
const seenCol = new Set();
let rowsRead = 0;

for (const f of files) {
  const lines = readFileSync(join(DATA, f), "utf8").trim().split(/\r?\n/);
  if (lines.length < 2) continue;
  const head = split(lines[0]);
  for (const c of head) if (!seenCol.has(c)) { seenCol.add(c); columns.push(c); }
  for (const line of lines.slice(1)) {
    const cells = split(line);
    const date = cells[0];
    if (!date) continue;
    rowsRead++;
    const row = byDate.get(date) ?? {};
    head.forEach((c, i) => {
      const v = cells[i] ?? "";
      // Later files win only where they actually carry a value, so a newer schema cannot
      // blank a column an older row legitimately filled.
      if (v !== "") row[c] = v;
      else if (!(c in row)) row[c] = "";
    });
    byDate.set(date, row);
  }
}

const dates = [...byDate.keys()].sort();
const body = [columns.join(",")]
  .concat(dates.map((d) => columns.map((c) => byDate.get(d)[c] ?? "").join(",")))
  .join("\n") + "\n";
writeFileSync(join(DATA, "history.csv"), body);

console.log(`merged ${files.length} file(s), ${rowsRead} row(s) read`);
console.log(`history.csv: ${dates.length} date(s) — ${dates[0]} … ${dates[dates.length - 1]}`);
console.log(`columns: ${columns.length} (union of every schema generation)`);
// A merge that silently loses a date is the failure this is meant to fix.
if (dates.length < rowsRead - files.length + 1)
  console.error("WARN: fewer dates than expected — check for duplicate dates across files");
