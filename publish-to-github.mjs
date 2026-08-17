import { readFileSync, readdirSync } from "node:fs";
const T = readFileSync("./gh.token","utf8").trim();
const H = { Authorization: "Bearer "+T, Accept: "application/vnd.github+json", "User-Agent": "x", "Content-Type": "application/json" };
const S = "C:/Users/shekel/make-1000-dollars/publish/agent-index/";
const put = async (path, file, msg) => {
  const u = `https://api.github.com/repos/AsherKasper/agent-marketplace-index/contents/${path}`;
  let sha; const g = await fetch(u, { headers: H }); if (g.ok) sha = (await g.json()).sha;
  const r = await fetch(u, { method: "PUT", headers: H, body: JSON.stringify({
    message: msg, content: Buffer.from(readFileSync(file, "utf8"), "utf8").toString("base64"), ...(sha?{sha}:{}) }) });
  console.log(path, "->", r.status);
};
const m = process.env.PUBLISH_MSG || "Update dataset and collector";

// Enumerate the scripts; do not list them. The data files were fixed to enumerate after two
// separate incidents, and the CODE list was left hardcoded to exactly two names — so when
// siwx.mjs was added, README.md documented it, docs-check.mjs passed locally, and the published
// repo 404'd on it. Documented-but-absent, which is the failure the README fix was meant to end.
//
// The lesson that keeps costing me: a filename written down once is a filename that goes stale.
// If a file belongs in the repo, derive the list from the directory.
const scripts = readdirSync(S).filter((n) => n.endsWith(".mjs")).sort();
if (!scripts.length) throw new Error("no .mjs files matched — check the path");
console.log("scripts to publish:", scripts.join(", "));
for (const f of scripts) await put(f, S + f, m);
await put("README.md", S + "README.md", m);
const archives = readdirSync(S + "data").filter((n) => /^index-v\d+\.csv$/.test(n));
if (!archives.length) throw new Error("no index-v*.csv archives matched — check the pattern");
console.log("archives to publish:", archives.join(", "));
for (const f of archives) await put("data/" + f, S + "data/" + f, "Archive " + f);
await put("data/index.csv", S + "data/index.csv", m);
// history.csv is THE series — the file the README now tells readers to start with — and it was
// missing from this list entirely. And the daily snapshot was hardcoded to one date, so every
// run after that day published a stale file and silently skipped the new one. Same bug as the
// archives: a filename that changes, written down once.
await put("data/history.csv", S + "data/history.csv", "Merged series");
const snaps = readdirSync(S + "data").filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort();
if (!snaps.length) throw new Error("no dated snapshots matched — check the pattern");
console.log("snapshots to publish:", snaps.join(", "));
for (const f of snaps) await put("data/" + f, S + "data/" + f, "Snapshot " + f.replace(".json", ""));
