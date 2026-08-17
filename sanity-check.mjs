#!/usr/bin/env node
// Sanity-check the merged series. Run after merge-history.mjs.
//
//   node sanity-check.mjs
//
// The collector already guards its INPUTS — it cross-checks array lengths against reported
// totals and refuses to publish a series with fewer than two rows. Nothing checked the
// OUTPUT for internal consistency across days, and some of these columns have a property
// that makes silent corruption detectable: **a lifetime cumulative figure cannot decrease.**
//
// If `em_paid_lifetime_usd` ever falls, one of three things is true and all of them matter:
// the platform restated history, the collector read a filtered subset, or a field was renamed
// under me. Each is worth a loud failure rather than a quietly wrong row in a paid dataset.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DATA = join(dirname(fileURLToPath(import.meta.url)), "data");

// Columns that are cumulative over the platform's whole life. They may stall; they may not fall.
const MONOTONIC = [
  "em_paid_lifetime_usd", "em_completed", "em_tasks_ever", "em_expired", "em_cancelled",
  "em_service_orders", "em_service_gross_usd",
  "toku_jobs_completed_lifetime", "toku_agents_with_completions", "toku_bids_placed",
  "dw_completed", "dw_agents", "dw_workers",
];
// Columns that are a snapshot of "right now" and may legitimately move either way.
// Listed so the absence of a check on them is deliberate rather than an oversight.
const SNAPSHOT = ["dw_listings", "dw_jobs", "toku_services", "toku_jobs", "ot_tasks",
  "em_published", "x402_calls_30d", "cantina_live"];

const lines = readFileSync(join(DATA, "history.csv"), "utf8").trim().split(/\r?\n/);
const head = lines[0].split(",");
const rows = lines.slice(1).map((l) => l.split(","));
if (rows.length < 2) { console.log("only one row — nothing to compare"); process.exit(0); }

let problems = 0, checked = 0;
for (const col of MONOTONIC) {
  const i = head.indexOf(col);
  if (i < 0) continue;
  let prev = null, prevDate = null;
  for (const r of rows) {
    const raw = r[i];
    if (raw === "" || raw === undefined) continue;   // not collected that day — not a fall
    const v = Number(raw);
    if (!Number.isFinite(v)) { console.error(`  BAD   ${col} on ${r[0]}: not a number (${raw})`); problems++; continue; }
    if (prev !== null) {
      checked++;
      if (v < prev) {
        console.error(`  FALL  ${col}: ${prev} on ${prevDate} → ${v} on ${r[0]}` +
          `\n        a lifetime cumulative figure decreased. Either the platform restated its` +
          `\n        history, or the collector read a filtered subset, or a field was renamed.`);
        problems++;
      }
    }
    prev = v; prevDate = r[0];
  }
}

// A date appearing twice would mean the merge stopped deduplicating — the bug that produced
// nine one-row files in the first place, in a new costume.
const dates = rows.map((r) => r[0]);
const dupes = dates.filter((d, i) => dates.indexOf(d) !== i);
if (dupes.length) { console.error(`  DUPE  repeated date(s): ${[...new Set(dupes)].join(", ")}`); problems++; }
if (dates.join() !== [...dates].sort().join()) { console.error("  ORDER rows are not sorted by date"); problems++; }

console.log(`${rows.length} row(s), ${MONOTONIC.length} cumulative column(s), ${checked} day-over-day comparison(s)`);
console.log(`snapshot columns deliberately NOT checked for direction: ${SNAPSHOT.length}`);
if (problems) { console.error(`\n${problems} problem(s) — the series contradicts itself.`); process.exit(1); }
console.log("\nseries is internally consistent");
