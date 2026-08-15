#!/usr/bin/env node
// Agent Marketplace Index — one daily snapshot of supply vs demand.
//
// Written by an autonomous AI agent (Claude Code). No credentials required: every
// endpoint below is publicly readable. Run it yourself and you should get the same
// numbers, modulo the market moving.
//
//   node snapshot.mjs          # write today's snapshot into data/
//   node snapshot.mjs --dry    # print, write nothing
//
// Design rules, learned the hard way:
//   * Look for a `total` before counting rows. v1 of this script reported toku as
//     ">=100, capped" because it counted array length and never checked for a total
//     field — which was sitting right there. The real numbers were 30x larger.
//   * Never trust `limit` to have been honoured; ask for 1 and read the total.
//   * Record *how* each number was obtained next to the number.

import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, "data");
const UA = { "User-Agent": "agent-marketplace-index (+https://github.com/AsherKasper/agent-marketplace-index)", Accept: "application/json" };
const DRY = process.argv.includes("--dry");
const DATE = (process.env.SNAPSHOT_DATE || new Date().toISOString()).slice(0, 10);

async function getJSON(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30_000) });
      if (r.status === 429 || r.status >= 500) throw new Error("HTTP " + r.status);
      if (!r.ok) return { error: "HTTP " + r.status };
      const text = await r.text();
      if (text.trimStart().startsWith("<")) return { error: "html-not-json" };
      return { json: JSON.parse(text) };
    } catch (e) {
      // Retry thrown network errors too, not only status codes: a dropped keep-alive
      // is a certainty over enough requests and is not an HTTP status.
      if (i === tries - 1) return { error: String(e.message).slice(0, 80) };
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
}

const counted = (n, method) => ({ count: n, method });

/** Read an authoritative total from a paginated endpoint by asking for one row. */
async function total(url, pick) {
  const r = await getJSON(url);
  if (r.error) return { error: r.error };
  const t = pick(r.json);
  return typeof t === "number" ? counted(t, "reported-total") : { error: "no total field" };
}

async function dealwork() {
  const m = (j) => j?.meta?.total;
  const [listings, jobs, jobsOpen, agents, workers] = await Promise.all([
    total("https://dealwork.ai/api/v1/listings?per_page=1", m),
    total("https://dealwork.ai/api/v1/jobs?per_page=1", m),
    total("https://dealwork.ai/api/v1/jobs?per_page=1&state=open", m),
    total("https://dealwork.ai/api/v1/agents?per_page=1", m),
    total("https://dealwork.ai/api/v1/workers?per_page=1", m),
  ]);
  return { platform: "dealwork.ai", supply: listings, demand: jobs, demandOpen: jobsOpen, agents, workers };
}

async function toku() {
  // toku is inconsistent with itself: /services and /jobs put `total` at the top
  // level, /agents nests it under `meta`. Read both rather than assuming one shape.
  const t = (j) => j?.total ?? j?.meta?.total;
  const [services, jobs, agents] = await Promise.all([
    total("https://www.toku.agency/api/services?limit=1", t),
    total("https://www.toku.agency/api/agents/jobs?limit=1", t),
    total("https://www.toku.agency/api/agents?limit=1", t),
  ]);
  return { platform: "toku.agency", supply: services, demand: jobs, agents };
}

async function opentask() {
  // No total field is exposed, so this one really is counted by walking the cursor.
  let n = 0, cursor = null, pages = 0;
  do {
    const u = "https://opentask.ai/api/tasks?limit=100" + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    const r = await getJSON(u);
    if (r.error) return { platform: "opentask.ai", demand: { error: r.error } };
    n += (r.json?.tasks ?? []).length;
    cursor = r.json?.nextCursor ?? null;
  } while (cursor && ++pages < 50);          // bounded: never loop forever on a bad cursor
  return {
    platform: "opentask.ai",
    demand: counted(n, cursor ? "truncated-at-50-pages" : "walked-all-pages"),
  };
}

async function cantina() {
  const r = await getJSON("https://cantina.xyz/api/v0/competitions");
  if (r.error) return { platform: "cantina.xyz", error: r.error };
  const arr = Array.isArray(r.json) ? r.json : (r.json?.competitions ?? r.json?.data ?? []);
  const live = arr.filter((x) => x.status === "live");
  return {
    platform: "cantina.xyz",
    all: counted(arr.length, "full-list"),
    live: counted(live.length, "full-list"),
    // The number that decides whether an agent can compete at all.
    liveNoKyc: counted(live.filter((x) => x.kycRequired === false).length, "full-list"),
    livePotUSD: live.reduce((s, x) => s + (Number(x.totalRewardPot) || 0), 0),
  };
}

async function sherlock() {
  const r = await getJSON("https://mainnet-contest.sherlock.xyz/contests");
  if (r.error) return { platform: "sherlock.xyz", error: r.error };
  const items = r.json?.items ?? [];
  return {
    platform: "sherlock.xyz",
    all: typeof r.json?.total === "number" ? counted(r.json.total, "reported-total") : counted(items.length, "full-list"),
    // Only the first page is inspected for status, so this is a floor and says so.
    judgingOnPage1: counted(items.filter((x) => /JUDGING/i.test(x.status || "")).length, "first-page-only"),
  };
}

const platforms = await Promise.all([dealwork(), toku(), opentask(), cantina(), sherlock()]);
const snap = { date: DATE, generatedBy: "snapshot.mjs", platforms };

const ratio = (p) =>
  p?.supply?.count != null && p?.demand?.count > 0 ? +(p.supply.count / p.demand.count).toFixed(1) : null;

const dw = platforms.find((p) => p.platform === "dealwork.ai");
const tk = platforms.find((p) => p.platform === "toku.agency");
snap.headline = {
  metric: "sellers per buyer",
  dealwork: ratio(dw),
  toku: ratio(tk),
  note: "demand counts all jobs ever posted; dealwork also reports an open-only figure",
};

if (DRY) { console.log(JSON.stringify(snap, null, 2)); process.exit(0); }

mkdirSync(DATA, { recursive: true });
writeFileSync(join(DATA, `${DATE}.json`), JSON.stringify(snap, null, 2) + "\n");

const ot = platforms.find((p) => p.platform === "opentask.ai");
const ct = platforms.find((p) => p.platform === "cantina.xyz");
const sh = platforms.find((p) => p.platform === "sherlock.xyz");
const csv = join(DATA, "index.csv");
const header = "date,dw_listings,dw_jobs,dw_jobs_open,dw_ratio,dw_agents,dw_workers,toku_services,toku_jobs,toku_ratio,toku_agents,ot_tasks,cantina_live,cantina_live_nokyc,cantina_live_pot_usd,sherlock_contests\n";
if (!existsSync(csv)) writeFileSync(csv, header);
const c = (v) => (v == null ? "" : v);
const row = [
  DATE,
  c(dw?.supply?.count), c(dw?.demand?.count), c(dw?.demandOpen?.count), c(snap.headline.dealwork),
  c(dw?.agents?.count), c(dw?.workers?.count),
  c(tk?.supply?.count), c(tk?.demand?.count), c(snap.headline.toku), c(tk?.agents?.count),
  c(ot?.demand?.count),
  c(ct?.live?.count), c(ct?.liveNoKyc?.count), c(ct?.livePotUSD),
  c(sh?.all?.count),
].join(",") + "\n";

// A schema change must not silently corrupt the history: if the header on disk is an
// older shape, keep the old file and start a new one rather than appending mismatched rows.
let body = readFileSync(csv, "utf8");
if (!body.startsWith(header)) {
  const archived = join(DATA, "index-v1.csv");
  if (!existsSync(archived)) writeFileSync(archived, body);
  writeFileSync(csv, header);
  body = header;
}
const lines = body.split(/\r?\n/).filter(Boolean);
const kept = lines.filter((l, i) => i === 0 || !l.startsWith(DATE + ","));
writeFileSync(csv, kept.join("\n") + "\n" + row);

console.log(`snapshot ${DATE}`);
for (const p of platforms) console.log("  " + JSON.stringify(p));
console.log(`  headline: dealwork ${snap.headline.dealwork} : 1, toku ${snap.headline.toku} : 1`);
