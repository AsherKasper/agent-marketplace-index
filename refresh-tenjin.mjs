#!/usr/bin/env node
// Rebuild the paid dataset piece on tenjin.blog from today's snapshot and PUT it.
//
//   node snapshot.mjs && node refresh-tenjin.mjs
//
// The card on that piece claims `temporalMode: "maintained"` with a daily cadence. This
// script is what makes that claim true rather than aspirational — a maintained dataset that
// silently goes stale is worse than one honestly labelled as a snapshot, because the buyer
// paid for the freshness.
//
// The signing key is read from outside the repo and is never printed or committed.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createSIWxMessage, encodeSIWxHeader } from "@x402/extensions/sign-in-with-x";
import { privateKeyToAccount } from "viem/accounts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, "data");
const KEYFILE = process.env.AGENT_WALLET || "C:/Users/shekel/.secrets/em-agent-wallet.json";
const POST_ID = process.env.TENJIN_POST_ID || readFileSync(join(HERE, ".tenjin-post-id"), "utf8").trim();

const w = JSON.parse(readFileSync(KEYFILE, "utf8"));
const raw = w.privateKey ?? w.private_key ?? w.pk;
const account = privateKeyToAccount(raw.startsWith("0x") ? raw : "0x" + raw);

async function siwx() {
  const info = {
    domain: "tenjin.blog", uri: "https://tenjin.blog", version: "1",
    chainId: "eip155:8453", type: "eip191",
    nonce: crypto.randomUUID().replace(/-/g, ""),          // client-minted, burned per write
    issuedAt: new Date().toISOString(),
    expirationTime: new Date(Date.now() + 86_400_000).toISOString(),
    statement: "Sign in to Tenjin.",
  };
  const signature = await account.signMessage({ message: createSIWxMessage(info, account.address) });
  return encodeSIWxHeader({ ...info, address: account.address, signatureScheme: "eip191", signature });
}

const DATE = (process.env.SNAPSHOT_DATE || new Date().toISOString()).slice(0, 10);
const snapPath = join(DATA, `${DATE}.json`);
if (!existsSync(snapPath)) {
  console.error(`no snapshot for ${DATE} — run snapshot.mjs first. Refusing to republish stale data.`);
  process.exit(1);
}

// history.csv, NOT index.csv. index.csv holds the current schema generation only, and a
// schema change rotates it — so it has been ONE row for most of this dataset's life. The paid
// piece was shipping that single row while promising a daily series. Buyers pay for the
// series; give them the series.
const csv = readFileSync(join(DATA, "history.csv"), "utf8").trim();
const csvRows = csv.split(/\r?\n/).length - 1;
if (csvRows < 2) {
  console.error(`history.csv has ${csvRows} data row(s) — refusing to publish a "daily series" that is not one. Run merge-history.mjs first.`);
  process.exit(1);
}
const snap = readFileSync(snapPath, "utf8").trim();
const [header, ...rows] = csv.split(/\r?\n/);
const cols = header.split(",");
const latest = rows[rows.length - 1].split(",");
const kv = cols.map((c, i) => `${c}=${latest[i]}`).join("  ");

const body = readFileSync(join(HERE, "dataset-template.md"), "utf8")
  .replace("{{NROWS}}", String(rows.length))
  .replace("{{NCOLS}}", String(cols.length))
  .replace("{{DATE}}", latest[0])
  .replace("{{KV}}", kv)
  .replace("{{CSV}}", csv)
  .replace("{{JSON}}", snap);

// An unsubstituted placeholder ships `{{CSV}}` to someone who paid for the CSV. Adding a
// token to the template and forgetting to wire it is a one-line mistake with a paying victim,
// so it fails here rather than in the product.
const leftover = body.match(/\{\{[A-Z_]+\}\}/g);
if (leftover) {
  console.error(`unsubstituted placeholder(s): ${[...new Set(leftover)].join(", ")} — refusing to publish`);
  process.exit(1);
}

const r = await fetch(`https://tenjin.blog/api/posts/${POST_ID}`, {
  method: "PUT",
  headers: { "content-type": "application/json", "SIGN-IN-WITH-X": await siwx() },
  body: JSON.stringify({ bodyMd: body, resource: { asOf: `${latest[0]}T00:00:00Z` } }),
});
console.log(`refresh ${latest[0]} -> ${r.status}`);
if (r.status !== 200) { console.error((await r.text()).slice(0, 300)); process.exit(1); }
