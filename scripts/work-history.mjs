// Rebuild app/admin/workHistory.json from git history. Run locally (Vercel's
// shallow clone lacks full history) and commit the JSON:
//   node scripts/work-history.mjs
// Hours are estimated by clustering each author's commits into work sessions:
// commits within 45 minutes of each other are one sitting, each sitting gets
// 15 minutes of lead-in, and a lone commit counts as 20 minutes.
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const GAP = 45 * 60, PAD = 15 * 60, LONE = 20 * 60;
const WHO = (email, name) => {
  if (email === "kaitlynkasel@cuecreative.media") return "Kaitlyn";
  if (email === "noreply@anthropic.com") return "Claude (cloud)";
  if (email === "merakasel@outlook.com") return "Mera";
  if (email === "skasel@eastsideprep.org") return "Suri";
  return name;
};

const raw = execSync("git log --pretty='%ae|%an|%at|%(trailers:key=Co-Authored-By,valueonly)'", {
  encoding: "utf8",
});
const byWho = new Map();
let commits = 0, assisted = 0, first = Infinity, last = 0;
for (const line of raw.split("\n")) {
  if (!line.trim()) continue;
  const [ae, an, at, trailer] = line.split("|");
  const t = Number(at);
  if (!t) continue;
  commits++;
  if (/Claude/i.test(trailer || "")) assisted++;
  first = Math.min(first, t);
  last = Math.max(last, t);
  const who = WHO(ae, an);
  const rec = byWho.get(who) || { commits: 0, times: [] };
  rec.commits++;
  rec.times.push(t);
  byWho.set(who, rec);
}

const people = [];
// Per-day, per-person hours so the admin card can draw a line graph over any
// time window. A session's whole time lands on the day it started.
const dayAgg = new Map();
for (const [who, rec] of byWho) {
  const ts = rec.times.sort((a, b) => a - b);
  let seconds = 0, sessions = 0, start = ts[0], prev = ts[0];
  for (let i = 1; i <= ts.length; i++) {
    if (i === ts.length || ts[i] - prev > GAP) {
      const secs = start === prev ? LONE : prev - start + PAD;
      seconds += secs;
      sessions++;
      const day = new Date(start * 1000).toISOString().slice(0, 10);
      const m = dayAgg.get(day) || new Map();
      m.set(who, (m.get(who) || 0) + secs);
      dayAgg.set(day, m);
      if (i < ts.length) start = ts[i];
    }
    if (i < ts.length) prev = ts[i];
  }
  people.push({ who, commits: rec.commits, sessions, hours: Math.round(seconds / 360) / 10 });
}
const days = [...dayAgg.entries()]
  .sort((a, b) => (a[0] < b[0] ? -1 : 1))
  .map(([date, m]) => ({
    date,
    byWho: Object.fromEntries(
      [...m.entries()].map(([w, secs]) => [w, Math.round(secs / 360) / 10])
    ),
  }));
people.sort((a, b) => b.hours - a.hours);

const out = {
  generatedAt: new Date().toISOString(),
  firstCommit: new Date(first * 1000).toISOString().slice(0, 10),
  lastCommit: new Date(last * 1000).toISOString().slice(0, 10),
  totalCommits: commits,
  claudeAssistedCommits: assisted,
  totalHours: Math.round(people.reduce((a, p) => a + p.hours, 0) * 10) / 10,
  people,
  days,
};
writeFileSync("app/admin/workHistory.json", JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(out, null, 1));
