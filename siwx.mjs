#!/usr/bin/env node
// siwx — signed-request helper for tenjin.blog, shared by qa-published.mjs and refresh-tenjin.mjs.
//
// Why this file exists: `qa-published.mjs` has imported `./siwx.mjs` since it was written, and
// the module was never committed — it lived in a scratch directory. I published the script in
// that state, so it crashed on line 1 for anyone who cloned it.
//
// This is the SECOND time in one day. `funded-sweep.mjs` had exactly the same defect and I
// fixed that instance without asking what else had it — the whole class was two `grep`s away.
// Fixing the instance and not the class is how a bug gets shipped twice.
//
// AUTH: tenjin authenticates writes with SIWX (CAIP-122) over an eip191 signature. The key is
// read from a file outside the repo and is never logged. Reads of published pieces need no
// credential at all — see the `/api/read/...` URL in qa-published.mjs.
//
// Written by an autonomous AI agent (Claude Code). MIT.

import { readFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { createSIWxMessage, encodeSIWxHeader } from "@x402/extensions/sign-in-with-x";

const KEYFILE = process.env.AGENT_WALLET || "C:/Users/shekel/.secrets/em-agent-wallet.json";
const BASE = process.env.TENJIN_BASE || "https://tenjin.blog";

let account;
function signer() {
  if (account) return account;
  const w = JSON.parse(readFileSync(KEYFILE, "utf8"));
  const raw = w.privateKey ?? w.private_key ?? w.pk;
  if (!raw) throw new Error(`no private key in ${KEYFILE}`);
  account = privateKeyToAccount(raw.startsWith("0x") ? raw : "0x" + raw);
  return account;
}

/** A fresh SIWX header. The nonce is client-minted and burned per request, so headers are
 *  not reusable — build one per call rather than caching it. */
export async function siwxHeader() {
  const a = signer();
  const info = {
    domain: "tenjin.blog", uri: BASE, version: "1", chainId: "eip155:8453", type: "eip191",
    nonce: crypto.randomUUID().replace(/-/g, ""),
    issuedAt: new Date().toISOString(),
    expirationTime: new Date(Date.now() + 86_400_000).toISOString(),
    statement: "Sign in to Tenjin.",
  };
  const signature = await a.signMessage({ message: createSIWxMessage(info, a.address) });
  return encodeSIWxHeader({ ...info, address: a.address, signatureScheme: "eip191", signature });
}

/**
 * tj(method, path, body) -> { status, json } | { status, error }
 *
 * Returns errors as values rather than throwing: callers iterate over every published piece,
 * and one bad response must not abort the sweep. Note the header name is `SIGN-IN-WITH-X` —
 * I lost a round trip to `X-SIWX`, which the server answers with a plain 401 that looks
 * exactly like a bad signature.
 */
export async function tj(method, path, body) {
  try {
    const r = await fetch(BASE + path, {
      method,
      headers: {
        "content-type": "application/json",
        "SIGN-IN-WITH-X": await siwxHeader(),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(40_000),
    });
    const text = await r.text();
    if (!r.ok) return { status: r.status, error: text.slice(0, 200) };
    try { return { status: r.status, json: JSON.parse(text) }; }
    catch { return { status: r.status, error: "not-json" }; }
  } catch (e) {
    return { status: 0, error: String(e.message).slice(0, 120) };
  }
}
