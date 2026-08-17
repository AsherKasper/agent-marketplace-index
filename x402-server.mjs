#!/usr/bin/env node
// A paid x402 endpoint for the Agent Marketplace Index — LOCAL ONLY until someone
// deliberately puts a tunnel in front of it.
//
//   node x402-server.mjs                    # binds 127.0.0.1:8402, reachable from this machine only
//   node x402-server.mjs --port 8402
//
// To expose it (a human decision, not the script's):
//   cloudflared tunnel --url http://127.0.0.1:8402
//
// WHY THIS EXISTS. I published, in a paid piece, that the x402 inputs layer was unreachable
// because "serving an endpoint requires a host, and every host wants an address it can mail."
// That was false: ten live paid endpoints in the public catalogue run on anonymous Cloudflare
// quick tunnels. This is the server that claim said could not exist.
//
// WHAT IT SELLS. `history.csv` — the merged daily series of what agent marketplaces actually
// settle. It is CC0 and also free on GitHub. That is deliberate: the paid endpoint sells
// *convenience and freshness to an agent mid-task*, not exclusivity. An agent that would
// rather pay $0.10 than clone a repo is the customer; anyone else should take the free copy.
//
// WHERE THE PAYMENT PATH ACTUALLY STANDS (updated 2026-08-17 — it changed, so this did).
//
//   decode header   implemented, tested (garbage header → 400)
//   VERIFY          implemented via the official facilitator client, and the facilitator's
//                   own capability list confirms it supports exactly what this server
//                   advertises: `v2 exact eip155:8453` with this USDC address
//   SETTLE          implemented, NEVER RUN AGAINST REAL FUNDS
//   deliver         gated behind --i-have-tested-settlement
//
// The gate stays shut until one real payment proves the settle path end to end. A verified
// payer currently gets a 501 that says, in plain words, that they have not been charged and
// where to get the same data free. Taking money without delivering, or delivering without
// taking, are both worse than refusing — and an untested settle path can do either.

import { createServer } from "node:http";
import { HTTPFacilitatorClient, decodePaymentSignatureHeader } from "@x402/core/http";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, "data");
const args = process.argv.slice(2);
const PORT = Number((args[args.indexOf("--port") + 1]) || 8402);
const SETTLEMENT_TESTED = args.includes("--i-have-tested-settlement");

const PAY_TO = "0xe9d3ce3E1A8695c87314A1C6b25130Cc266B1477";   // the experiment's wallet
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PRICE_ATOMIC = "100000";                                  // $0.10, 6 decimals

// Verified against this facilitator's own capability list rather than its docs: it advertises
// `v2 exact eip155:8453` with exactly this USDC address, so the requirements below are
// settleable. I hand-rolled the /verify request twice from the published example first and it
// was rejected identically both times — the prose in that OpenAPI document does not match the
// implementation. The official client knows the wire format; use it and never guess.
const FACILITATOR = process.env.X402_FACILITATOR || "https://facilitator.ultravioletadao.xyz";
const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR });

const requirementsFor = (resource) => ({
  scheme: "exact",
  network: "eip155:8453",
  maxAmountRequired: PRICE_ATOMIC,
  resource,
  description: "Agent Marketplace Index — merged daily settled-volume series",
  mimeType: "text/csv",
  payTo: PAY_TO,
  maxTimeoutSeconds: 300,
  asset: USDC_BASE,
});

const paymentRequired = (resource) => ({
  x402Version: 2,
  accepts: [{
    scheme: "exact",
    network: "eip155:8453",
    asset: USDC_BASE,
    amount: PRICE_ATOMIC,
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    resource,
  }],
});

const send = (res, code, body, headers = {}) => {
  const payload = typeof body === "string" ? body : JSON.stringify(body, null, 1);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(payload);
};

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const self = `${url.protocol}//${req.headers.host}${url.pathname}`;

  // Free: what this is, so an agent can decide without paying. Mirrors the discovery card.
  if (url.pathname === "/" || url.pathname === "/.well-known/x402") {
    const hist = join(DATA, "history.csv");
    const rows = existsSync(hist) ? readFileSync(hist, "utf8").trim().split(/\r?\n/).length - 1 : 0;
    return send(res, 200, {
      service: "Agent Marketplace Index",
      description: "Daily settled-volume series across six agent marketplaces plus the x402 layer. " +
        "What these markets PAY, not what they advertise.",
      free: { "/": "this", "/schema": "column list and meaning" },
      paid: { "/history.csv": `$0.10 — the full series, ${rows} day(s)` },
      alsoFreeAt: "https://github.com/AsherKasper/agent-marketplace-index",
      note: "The data is CC0 and free at the link above. The paid endpoint sells freshness and " +
            "one HTTP call instead of a clone. If you would rather not pay, please take the free copy.",
    });
  }

  if (url.pathname === "/schema") {
    const hist = join(DATA, "history.csv");
    if (!existsSync(hist)) return send(res, 503, { error: "history.csv not built — run merge-history.mjs" });
    return send(res, 200, { columns: readFileSync(hist, "utf8").split(/\r?\n/)[0].split(",") });
  }

  if (url.pathname === "/history.csv") {
    const payment = req.headers["x-payment"] || req.headers["payment"];
    if (!payment) {
      const reqs = paymentRequired(self);
      return send(res, 402, { error: "payment required", ...reqs }, {
        "payment-required": Buffer.from(JSON.stringify(reqs), "utf8").toString("base64"),
      });
    }
    // A payment header arrived. Verify BEFORE settling and settle BEFORE delivering — in that
    // order, always. Verify is free and catches a bad signature without touching the chain;
    // settling first would spend gas on a payment that was never valid.
    return (async () => {
      let payload;
      try { payload = decodePaymentSignatureHeader(String(payment)); }
      catch { return send(res, 400, { error: "malformed_payment_header" }); }

      const requirements = requirementsFor(self);
      try {
        const v = await facilitator.verify(payload, requirements);
        if (!v?.isValid) {
          return send(res, 402, { error: "payment_invalid", reason: v?.invalidReason ?? "unknown",
            message: "You have not been charged." });
        }
      } catch (e) {
        // Facilitator unreachable or erroring. Refuse — never deliver on an unverified payment
        // because the check happened to be down.
        return send(res, 503, { error: "verification_unavailable", detail: String(e.message).slice(0, 140),
          message: "Could not verify your payment, so nothing was released and you were not charged." });
      }

      // The flag stays off until a REAL payment has proven this path end to end. Verification
      // above is now real; settlement below has never run against live funds, and shipping an
      // untested settle path is how you take money and deliver nothing.
      if (!SETTLEMENT_TESTED) {
        return send(res, 501, {
          error: "settlement_untested",
          message: "Your payment authorisation VERIFIED, but this server has not yet settled a " +
                   "real payment, so it will not take yours. You have not been charged. The same " +
                   "data is free at https://github.com/AsherKasper/agent-marketplace-index",
        });
      }

      let settled;
      try { settled = await facilitator.settle(payload, requirements); }
      catch (e) { return send(res, 502, { error: "settlement_failed", detail: String(e.message).slice(0, 140),
        message: "Settlement did not complete; no content released." }); }
      if (!settled?.success) {
        return send(res, 402, { error: "settlement_rejected", reason: settled?.errorReason ?? "unknown" });
      }

      const hist = join(DATA, "history.csv");
      return send(res, 200, readFileSync(hist, "utf8"), {
        "content-type": "text/csv; charset=utf-8",
        "payment-response": Buffer.from(JSON.stringify(settled), "utf8").toString("base64"),
      });
    })();
  }

  send(res, 404, { error: "not found", try: ["/", "/schema", "/history.csv"] });
});

// Bind to loopback explicitly. Exposing this is a separate, deliberate act.
server.listen(PORT, "127.0.0.1", () => {
  console.log(`x402 index server on http://127.0.0.1:${PORT} (loopback only)`);
  console.log(`settlement verification: ${SETTLEMENT_TESTED ? "ENABLED" : "NOT implemented — paid path returns 501"}`);
  console.log(`to expose: cloudflared tunnel --url http://127.0.0.1:${PORT}`);
});
