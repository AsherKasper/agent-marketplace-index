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
// Design rules, learned the hard way earlier in this run:
//   * Never trust `limit` to have been honoured. Ask for more than you expect and
//     check whether you got exactly the cap back.
//   * Never trust page one to be the whole set. Follow the total when one is given.
//   * Record *how* a number was obtained next to the number, so a capped count is
//     never mistaken for a complete one.

import { writeFileSync, mkdirSync, existsSync, readFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, "data");
const UA = { "User-Agent": "agent-marketplace-index (+https://github.com/AsherKasper/agent-marketplace-index)", Accept: "application/json" };
const DRY = process.argv.includes("--dry");

// The date is supplied by the environment so a re-run cannot silently relabel history.
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
      // Retry on thrown network errors too, not only on status codes — a dropped
      // keep-alive is a certainty over enough requests, and it is not an HTTP status.
      if (i === tries - 1) return { error: String(e.message).slice(0, 80) };
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
}

/** A count plus provenance. `method` says how we know, so nothing is over-claimed. */
const counted = (n, method, extra = {}) => ({ count: n, method, ...extra });

async function dealwork() {
  const out = { platform: "dealwork.ai" };
  for (const [key, path] of [["supply", "listings"], ["demand", "jobs"]]) {
    const r = await getJSON(`https://dealwork.ai/api/v1/${path}?per_page=1`);
    if (r.error) { out[key] = { error: r.error }; continue; }
    const total = r.json?.meta?.total;
    out[key] = typeof total === "number"
      ? counted(total, "meta.total")               // authoritative: platform reports it
      : { error: "no meta.total" };
  }
  return out;
}

async function toku() {
  const out = { platform: "toku.agency" };
  // toku caps list responses at 100 regardless of `limit` — verified by asking for 200
  // and receiving exactly 100. So these are lower bounds, and they say so.
  for (const [key, url] of [
    ["supply", "https://www.toku.agency/api/services?limit=200"],
    ["demand", "https://www.toku.agency/api/agents/jobs?limit=200"],
  ]) {
    const r = await getJSON(url);
    if (r.error) { out[key] = { error: r.error }; continue; }
    const arr = r.json?.services ?? r.json?.jobPosts ?? [];
    const capped = arr.length >= 100;
    out[key] = counted(arr.length, capped ? "capped-at-100" : "full-list", { atLeast: capped });
  }
  return out;
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
    // The interesting one for an autonomous agent: can you enter without an identity?
    liveNoKyc: counted(live.filter((x) => x.kycRequired === false).length, "full-list"),
    livePotUSD: live.reduce((s, x) => s + (Number(x.totalRewardPot) || 0), 0),
  };
}

const platforms = await Promise.all([dealwork(), toku(), cantina()]);
const snap = { date: DATE, generatedBy: "snapshot.mjs", platforms };

// Supply-to-demand ratio, only where both sides are honestly known.
const dw = platforms.find((p) => p.platform === "dealwork.ai");
if (dw?.supply?.count != null && dw?.demand?.count > 0) {
  snap.headline = {
    metric: "dealwork sellers per buyer",
    value: +(dw.supply.count / dw.demand.count).toFixed(1),
    note: "demand counts every job ever posted, not only open ones — this flatters demand",
  };
}

if (DRY) { console.log(JSON.stringify(snap, null, 2)); process.exit(0); }

mkdirSync(DATA, { recursive: true });
writeFileSync(join(DATA, `${DATE}.json`), JSON.stringify(snap, null, 2) + "\n");

const csv = join(DATA, "index.csv");
const header = "date,dw_listings,dw_jobs,dw_ratio,toku_services,toku_jobs,cantina_live,cantina_live_nokyc,cantina_live_pot_usd\n";
if (!existsSync(csv)) writeFileSync(csv, header);
const tk = platforms.find((p) => p.platform === "toku.agency");
const ct = platforms.find((p) => p.platform === "cantina.xyz");
const cell = (v) => (v == null ? "" : v);
const row = [
  DATE, cell(dw?.supply?.count), cell(dw?.demand?.count), cell(snap.headline?.value),
  cell(tk?.supply?.count), cell(tk?.demand?.count),
  cell(ct?.live?.count), cell(ct?.liveNoKyc?.count), cell(ct?.livePotUSD),
].join(",") + "\n";

// Idempotent: re-running on the same day replaces that day's row rather than duplicating it.
const body = readFileSync(csv, "utf8");
const lines = body.split(/\r?\n/).filter(Boolean);
const kept = lines.filter((l, i) => i === 0 || !l.startsWith(DATE + ","));
writeFileSync(csv, kept.join("\n") + "\n" + row);

console.log(`snapshot ${DATE}`);
for (const p of platforms) console.log("  " + JSON.stringify(p));
if (snap.headline) console.log(`  headline: ${snap.headline.value} ${snap.headline.metric}`);
