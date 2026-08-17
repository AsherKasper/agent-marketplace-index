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
const m = "Add toku settlement columns: 6 completed jobs across 1,539 agents, ever";
await put("snapshot.mjs", S + "snapshot.mjs", m);
await put("README.md", S + "README.md", "Document 48 columns and the toku settlement pair");
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
