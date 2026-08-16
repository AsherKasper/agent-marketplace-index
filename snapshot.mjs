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
  // CORRECTION 2026-08-15: this used `?state=open`. There is no `state` parameter —
  // it was silently ignored and returned the unfiltered total, so the column labelled
  // "open jobs" was publishing "all jobs" for two days. The correct key is `status`,
  // and "open" is not a value: jobs are `posted` | `bidding` | `completed`.
  // The platform has since shipped `meta.ignored_params` so an unknown filter is
  // visible instead of silently returning the default set.
  const [listings, jobs, posted, bidding, completed, agents, workers] = await Promise.all([
    total("https://dealwork.ai/api/v1/listings?per_page=1", m),
    total("https://dealwork.ai/api/v1/jobs?per_page=1", m),
    total("https://dealwork.ai/api/v1/jobs?per_page=1&status=posted", m),
    total("https://dealwork.ai/api/v1/jobs?per_page=1&status=bidding", m),
    total("https://dealwork.ai/api/v1/jobs?per_page=1&status=completed", m),
    total("https://dealwork.ai/api/v1/agents?per_page=1", m),
    total("https://dealwork.ai/api/v1/workers?per_page=1", m),
  ]);
  // Settled side. NOTE: these are ADVERTISED prices on completed jobs, not amounts paid.
  // The platform's admin states median fixed price is $0.40 while median *paid* contract is
  // $0.20, so actual settlement runs at roughly half of advertised. Recorded as advertised
  // because that is what the API exposes; do not read it as revenue.
  let completedValueUSD = null, completedMedianUSD = null, completedMaxUSD = null, completedFreshest = null;
  const rows = [];
  for (let p = 1; p <= 5; p++) {
    const r = await getJSON(`https://dealwork.ai/api/v1/jobs?per_page=100&page=${p}&status=completed`);
    if (r.error) break;
    const d = r.json?.data ?? [];
    rows.push(...d);
    if (d.length < 100) break;
  }
  if (rows.length) {
    const vals = rows.map((t) => Number(t.fixedPrice ?? t.budgetMax ?? t.budgetMin ?? 0))
      .filter((v) => v > 0).sort((a, b) => a - b);
    completedValueUSD = +vals.reduce((a, b) => a + b, 0).toFixed(2);
    completedMedianUSD = vals[Math.floor(vals.length / 2)] ?? null;
    completedMaxUSD = vals[vals.length - 1] ?? null;
    // Days since the most recently touched completed job — the liveness signal.
    completedFreshest = Math.min(...rows.map((t) =>
      Math.floor((Date.now() - new Date(t.updatedAt ?? t.createdAt)) / 86400000)));
  }

  return { platform: "dealwork.ai", supply: listings, demand: jobs, posted, bidding, completed,
    agents, workers, completedValueUSD, completedMedianUSD, completedMaxUSD, completedFreshestDays: completedFreshest };
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

  // Added 2026-08-16. Until now this platform had supply, demand and a ratio but NO
  // settlement column — so it could look busy forever. The agent directory exposes
  // `jobsCompleted` per agent, which sums to a real lifetime completion count. Walking all
  // ~1,539 agents is the only way to get it; there is no aggregate endpoint.
  // The array key on this endpoint DEPENDS ON AUTH: `data` unauthenticated, `agents` with a
  // bearer token. Same URL, same status, different shape. Read both — the first version of
  // this read only `agents` and silently recorded 0 completions from 1,539 agents.
  let completions = null, agentsWithAny = null;
  const roster = [];
  for (let off = 0; off < 3000; off += 100) {
    const r = await getJSON(`https://www.toku.agency/api/agents?limit=100&offset=${off}`);
    if (r.error) break;
    const rows = r.json?.data ?? r.json?.agents ?? [];
    roster.push(...rows);
    if (rows.length < 100) break;
  }
  // Cross-check the walk against the endpoint's own total; a wrong key and an empty
  // platform are indistinguishable without it.
  if (agents?.count && roster.length && roster.length < agents.count * 0.9)
    console.error(`  WARN toku roster: read ${roster.length} of ${agents.count} agents`);
  if (roster.length) {
    completions = roster.reduce((s, a) => s + Number(a.jobsCompleted || 0), 0);
    agentsWithAny = roster.filter((a) => Number(a.jobsCompleted || 0) > 0).length;
  }

  // Effort absorbed vs work converted. Completions alone understate how much labour a board
  // consumes: every post here carries bids, so `bidCount` summed is the number of times an
  // agent wrote a proposal. Against lifetime completions it gives bids-per-completion, which
  // is the honest cost of participating.
  let bidsPlaced = null, postsWithBids = null;
  const posts = [];
  for (let off = 0; off < 500; off += 100) {
    const r = await getJSON(`https://www.toku.agency/api/agents/jobs?limit=100&offset=${off}`);
    if (r.error) break;
    const rows = r.json?.jobPosts ?? [];
    posts.push(...rows);
    if (rows.length < 100) break;
  }
  if (posts.length) {
    bidsPlaced = posts.reduce((s, p) => s + Number(p.bidCount || 0), 0);
    postsWithBids = posts.filter((p) => Number(p.bidCount || 0) > 0).length;
  }
  return { platform: "toku.agency", supply: services, demand: jobs, agents,
    jobsCompletedLifetime: completions, agentsWithCompletions: agentsWithAny,
    bidsPlaced, postsWithBids,
    bidsPerCompletion: (bidsPlaced && completions) ? +(bidsPlaced / completions).toFixed(0) : null,
    rosterRead: counted(roster.length, "walked-all-pages") };
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

/**
 * execution.market — the only platform found that exposes SETTLED volume, not just
 * listings. Supply and demand counts say what is advertised; these say what was paid.
 * All endpoints are public, so this keeps the collector credential-free.
 */
async function executionMarket() {
  const BASE = "https://api.execution.market";
  const out = { platform: "execution.market" };

  // Walk the full task history rather than sampling — it is ~14 pages.
  const tasks = [];
  for (let off = 0; off < 5000; off += 100) {
    const r = await getJSON(`${BASE}/api/v1/tasks?limit=100&offset=${off}`);
    if (r.error) { out.error = r.error; break; }
    const page = r.json?.tasks ?? [];
    tasks.push(...page);
    if (page.length < 100) break;
  }
  // CORRECTION 2026-08-16: `tasks.length` is NOT the task population and this column used
  // to say it was. The list endpoint silently omits expired and cancelled tasks — it returns
  // ~1,363 of ~3,918. Every em_tasks value recorded before this date is the size of the
  // list, not the platform. The true population comes from the metrics endpoint below,
  // which is a genuinely different source rather than the same one re-read.
  const met = await getJSON(`${BASE}/api/v1/public/metrics`);
  if (!met.error && met.json?.tasks) {
    const m = met.json.tasks;
    out.tasksEver = counted(m.total, "platform-metrics");
    out.expired = m.expired;
    out.cancelled = m.cancelled;
    out.completionRatePct = m.total ? +((m.completed / m.total) * 100).toFixed(1) : null;
  }

  if (tasks.length) {
    const done = tasks.filter((t) => t.status === "completed");
    const live = tasks.filter((t) => t.status === "published");
    const paid = done.reduce((s, t) => s + Number(t.bounty_usd || 0), 0);
    const sizes = done.map((t) => Number(t.bounty_usd || 0)).sort((a, b) => a - b);
    out.tasksListed = counted(tasks.length, "walked-all-pages; EXCLUDES expired+cancelled");
    out.tasksCompleted = counted(done.length, "walked-all-pages");
    // The headline: everything this marketplace has ever actually paid out.
    out.paidLifetimeUSD = +paid.toFixed(2);
    // Of which: rows that LABEL THEMSELVES as test/demo runs. Matched on the bracket prefix
    // the rows declare, never on inference about who posted them. Reported separately so the
    // gross figure stays honest and the winnable figure stays visible.
    const tests = done.filter((t) => /^\s*\[(MULTICHAIN GF|GOLDEN FLOW)/i.test(t.title ?? ""));
    out.testTasks = tests.length;
    out.testPaidUSD = +tests.reduce((s, t) => s + Number(t.bounty_usd || 0), 0).toFixed(2);
    out.realPaidUSD = +(paid - out.testPaidUSD).toFixed(2);
    out.medianCompletedUSD = sizes.length ? sizes[Math.floor(sizes.length / 2)] : null;
    out.maxCompletedUSD = sizes.length ? sizes[sizes.length - 1] : null;
    out.published = counted(live.length, "walked-all-pages");
    out.publishedUSD = +live.reduce((s, t) => s + Number(t.bounty_usd || 0), 0).toFixed(2);
  }

  const s = await getJSON(`${BASE}/api/v1/services?limit=100`);
  if (!s.error) {
    const ls = s.json?.listings ?? [];
    const orders = ls.reduce((a, x) => a + Number(x.orders_count || 0), 0);
    const gross = ls.reduce((a, x) => a + Number(x.orders_count || 0) * Number(x.unit_price_usd || 0), 0);
    const sold = ls.filter((x) => Number(x.orders_count || 0) > 0).map((x) => Number(x.unit_price_usd || 0));
    out.services = counted(ls.length, "full-list");
    out.serviceOrders = orders;
    out.serviceGrossUSD = +gross.toFixed(2);
    // The ceiling: the dearest thing anyone has actually bought.
    out.maxSoldPriceUSD = sold.length ? Math.max(...sold) : null;
  }
  return out;
}

/**
 * x402 via Agentic.Market — the only source found that reports REAL PAID CALLS rather
 * than listings or offers. This is where the agent economy actually transacts: agents
 * buying inputs (search, data, inference) at API-call prices. Added 2026-08-15 after
 * this data falsified the report's previous headline.
 */
async function x402() {
  const out = { platform: "x402 (agentic.market)" };
  const svcs = [];
  for (let off = 0; off < 5000; off += 100) {
    const r = await getJSON(`https://api.agentic.market/v1/services?limit=100&offset=${off}`);
    if (r.error) { out.error = r.error; break; }
    const rows = r.json?.services ?? [];
    svcs.push(...rows);
    if (rows.length < 100) break;
  }
  if (!svcs.length) return out;

  const per = svcs.map((s) => ({
    price: Number(s.priceSummary?.avgCostPerTransaction ?? 0),
    calls: (s.endpoints ?? []).reduce((a, e) => a + Number(e?.quality?.l30DaysTotalCalls ?? 0), 0),
  }));
  out.services = counted(svcs.length, "walked-all-pages");
  out.servicesWithCalls = counted(per.filter((r) => r.calls > 0).length, "walked-all-pages");
  out.calls30d = per.reduce((a, r) => a + r.calls, 0);
  out.gross30dUSD = +per.reduce((a, r) => a + r.calls * r.price, 0).toFixed(2);
  // A single service priced at ~$5,000/call has repeatedly been ~69% of gross. Report
  // both, because quoting only the headline would overstate this market ~3x.
  out.gross30dExOutliersUSD = +per.filter((r) => r.price < 1000)
    .reduce((a, r) => a + r.calls * r.price, 0).toFixed(2);
  const priced = per.map((r) => r.price).filter((p) => p > 0).sort((a, b) => a - b);
  out.medianPriceUSD = priced.length ? priced[Math.floor(priced.length / 2)] : null;
  return out;
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

const platforms = await Promise.all([dealwork(), toku(), opentask(), cantina(), sherlock(), executionMarket(), x402()]);
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
const em = platforms.find((p) => p.platform === "execution.market");
const xf = platforms.find((p) => p.platform === "x402 (agentic.market)");
const csv = join(DATA, "index.csv");
const header = "date,dw_listings,dw_jobs,dw_posted,dw_bidding,dw_completed,dw_completed_value_usd,dw_completed_median_usd,dw_completed_max_usd,dw_days_since_last_completion,dw_ratio,dw_agents,dw_workers,toku_services,toku_jobs,toku_ratio,toku_agents,toku_jobs_completed_lifetime,toku_agents_with_completions,toku_bids_placed,toku_bids_per_completion,ot_tasks,cantina_live,cantina_live_nokyc,cantina_live_pot_usd,sherlock_contests,em_tasks_ever,em_tasks_listed,em_expired,em_cancelled,em_completion_rate_pct,em_completed,em_paid_lifetime_usd,em_test_tasks,em_test_paid_usd,em_real_paid_usd,em_median_completed_usd,em_max_completed_usd,em_published,em_published_usd,em_services,em_service_orders,em_service_gross_usd,em_max_sold_price_usd,x402_services,x402_services_with_calls,x402_calls_30d,x402_gross_30d_usd,x402_gross_30d_ex_outlier_usd,x402_median_price_usd\n";
if (!existsSync(csv)) writeFileSync(csv, header);
const c = (v) => (v == null ? "" : v);
const row = [
  DATE,
  c(dw?.supply?.count), c(dw?.demand?.count), c(dw?.posted?.count), c(dw?.bidding?.count),
  c(dw?.completed?.count), c(dw?.completedValueUSD), c(dw?.completedMedianUSD),
  c(dw?.completedMaxUSD), c(dw?.completedFreshestDays), c(snap.headline.dealwork),
  c(dw?.agents?.count), c(dw?.workers?.count),
  c(tk?.supply?.count), c(tk?.demand?.count), c(snap.headline.toku), c(tk?.agents?.count),
  c(tk?.jobsCompletedLifetime), c(tk?.agentsWithCompletions),
  c(tk?.bidsPlaced), c(tk?.bidsPerCompletion),
  c(ot?.demand?.count),
  c(ct?.live?.count), c(ct?.liveNoKyc?.count), c(ct?.livePotUSD),
  c(sh?.all?.count),
  // execution.market — the settlement columns. em_paid_lifetime_usd is the one that
  // matters: everything this marketplace has ever actually paid out.
  c(em?.tasksEver?.count), c(em?.tasksListed?.count), c(em?.expired), c(em?.cancelled),
  c(em?.completionRatePct), c(em?.tasksCompleted?.count), c(em?.paidLifetimeUSD),
  c(em?.testTasks), c(em?.testPaidUSD), c(em?.realPaidUSD),
  c(em?.medianCompletedUSD), c(em?.maxCompletedUSD), c(em?.published?.count), c(em?.publishedUSD),
  c(em?.services?.count), c(em?.serviceOrders), c(em?.serviceGrossUSD), c(em?.maxSoldPriceUSD),
  // x402 — real paid calls. This is where the agent economy actually transacts.
  c(xf?.services?.count), c(xf?.servicesWithCalls?.count), c(xf?.calls30d),
  c(xf?.gross30dUSD), c(xf?.gross30dExOutliersUSD), c(xf?.medianPriceUSD),
].join(",") + "\n";

// A schema change must not silently corrupt the history: if the header on disk is an
// older shape, keep the old file and start a new one rather than appending mismatched rows.
let body = readFileSync(csv, "utf8");
if (!body.startsWith(header)) {
  // Archive to the next free version rather than a fixed name. v1 of this guard wrote
  // only ever to index-v1.csv and skipped if it existed — so the SECOND schema change
  // silently discarded the old rows instead of keeping them. A guard against silent
  // data loss that itself loses data silently is worse than none.
  let n = 1;
  while (existsSync(join(DATA, `index-v${n}.csv`))) n++;
  writeFileSync(join(DATA, `index-v${n}.csv`), body);
  console.log(`schema changed — previous history archived as index-v${n}.csv`);
  writeFileSync(csv, header);
  body = header;
}
const lines = body.split(/\r?\n/).filter(Boolean);
const kept = lines.filter((l, i) => i === 0 || !l.startsWith(DATE + ","));
writeFileSync(csv, kept.join("\n") + "\n" + row);

console.log(`snapshot ${DATE}`);
for (const p of platforms) console.log("  " + JSON.stringify(p));
console.log(`  headline: dealwork ${snap.headline.dealwork} : 1, toku ${snap.headline.toku} : 1`);
