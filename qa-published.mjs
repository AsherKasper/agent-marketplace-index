import { tj } from "./siwx.mjs";
const posts = (await tj("GET", "/api/posts")).json?.items ?? [];
console.log(`checking ${posts.length} published pieces\n`);
let bad = 0;
for (const p of posts) {
  const url = `https://tenjin.blog/api/read/agent-market-data/${p.slug}`;
  const r = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30000) });
  const j = await r.json().catch(() => ({}));
  const hdr = r.headers.get("payment-required");
  const issues = [];
  if (r.status !== 402) issues.push(`status=${r.status}`);
  if (!hdr) issues.push("no PAYMENT-REQUIRED");
  else { const a = JSON.parse(Buffer.from(hdr, "base64").toString("utf8")).accepts?.[0] ?? {};
         if (a.amount !== "100000") issues.push(`price=${a.amount}`);
         if (!a.payTo) issues.push("no payTo"); }
  const prev = String(j.bodyMdPreview ?? "");
  if (prev.length < 200) issues.push(`preview ${prev.length} chars`);
  if (/\{\{[A-Z_]+\}\}/.test(prev)) issues.push("RAW PLACEHOLDER");
  if (!j.card) issues.push("no card");
  if (issues.length) { bad++; console.log(`  FAIL ${p.slug.slice(0,46)}\n       ${issues.join(" | ")}`); }
  else console.log(`  ok   ${p.slug.slice(0,46)}  preview=${String(prev.length).padStart(4)}ch`);
}
console.log(`\n${posts.length - bad} healthy, ${bad} with issues`);
