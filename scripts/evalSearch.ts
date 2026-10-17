// Search eval: runs the REAL engine over a fixed set of goals and scores the
// results, so every engine change can be judged against the last run instead
// of by feel. Costs real API credits (~20 searches), so it is a manual
// command, never part of the build:
//
//   npm run eval:search              all goals
//   npm run eval:search -- curators  only goal ids containing "curators"
//   npm run eval:search -- --baseline  also save this run as the new baseline
//
// Per goal it records: finds returned, share with a contact route (email,
// handle, or phone), share with a personal email, mean fit, on-topic share
// (finds whose text mentions an expected keyword), junk leakage (listicles,
// how-to pages), distinct sites, and wall time. A summary compares against
// fixtures/search-baseline.json when one exists.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";

function loadEnv(file: string) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

async function main() {
  const root = process.cwd();
  loadEnv(path.join(root, ".env.local"));
  const { discover } = await import(path.join(root, "lib/discover.ts"));

  const args = process.argv.slice(2);
  const saveBaseline = args.includes("--baseline");
  const filter = args.find((a) => !a.startsWith("--")) || "";
  const spec = JSON.parse(readFileSync(path.join(root, "fixtures/search-goals.json"), "utf8"));
  const goals = (spec.goals as any[]).filter((g) => !filter || g.id.includes(filter));

  const rows: any[] = [];
  for (const g of goals) {
    const t0 = Date.now();
    let opps: any[] = [];
    let err = "";
    try {
      const res = await discover(g.goal, spec.about, g.useCase, 10);
      opps = res.opportunities || [];
    } catch (e: any) {
      err = e?.message || String(e);
    }
    const secs = (Date.now() - t0) / 1000;
    const n = opps.length;
    const text = (o: any) =>
      `${o.name} ${o.outlet} ${o.contactRole} ${o.whyItFits} ${o.url}`.toLowerCase();
    const contact = opps.filter((o) => o.contactEmail || o.contactHandle || o.contactPhone).length;
    const personal = opps.filter(
      (o) => o.contactEmail && !/^(info|hello|contact|admin|support|team|office|press|booking)@/i.test(o.contactEmail)
    ).length;
    const onTopic = opps.filter((o) => (g.expect || []).some((k: string) => text(o).includes(k))).length;
    const junk = opps.filter((o) =>
      /(\btop \d+|\bbest \d+|\d+ best|how to |guide to|ultimate list|\blist of\b)/i.test(o.name || "")
    ).length;
    const sites = new Set(
      opps.map((o) => {
        try {
          return new URL(o.url).hostname.replace(/^www\./, "");
        } catch {
          return "";
        }
      })
    ).size;
    const fits = opps.map((o) => o.fitScore).filter((x) => typeof x === "number");
    const row = {
      id: g.id,
      n,
      contactRate: n ? contact / n : 0,
      personalRate: n ? personal / n : 0,
      onTopicRate: n ? onTopic / n : 0,
      junk,
      sites,
      meanFit: fits.length ? fits.reduce((a: number, b: number) => a + b, 0) / fits.length : 0,
      secs,
      ...(err ? { err } : {}),
    };
    rows.push(row);
    const pct = (x: number) => `${Math.round(x * 100)}%`.padStart(4);
    console.log(
      `${g.id.padEnd(22)} n=${String(n).padStart(2)}  contact ${pct(row.contactRate)}  personal ${pct(
        row.personalRate
      )}  on-topic ${pct(row.onTopicRate)}  junk ${junk}  sites ${String(sites).padStart(2)}  fit ${pct(
        row.meanFit
      )}  ${secs.toFixed(0)}s${err ? `  ERROR ${err.slice(0, 60)}` : ""}`
    );
  }

  const avg = (k: string) => rows.reduce((a, r) => a + (r[k] || 0), 0) / Math.max(1, rows.length);
  const summary = {
    at: new Date().toISOString(),
    goals: rows.length,
    meanFinds: avg("n"),
    contactRate: avg("contactRate"),
    personalRate: avg("personalRate"),
    onTopicRate: avg("onTopicRate"),
    junkPerGoal: avg("junk"),
    meanFit: avg("meanFit"),
    meanSecs: avg("secs"),
    errors: rows.filter((r) => r.err).length,
  };
  console.log("\nSUMMARY", JSON.stringify(summary, null, 1));

  const basePath = path.join(root, "fixtures/search-baseline.json");
  if (existsSync(basePath) && !filter) {
    const base = JSON.parse(readFileSync(basePath, "utf8")).summary;
    console.log("\nVS BASELINE (" + base.at.slice(0, 10) + ")");
    for (const k of ["meanFinds", "contactRate", "personalRate", "onTopicRate", "junkPerGoal", "meanFit", "meanSecs"]) {
      const d = (summary as any)[k] - base[k];
      const better = k === "junkPerGoal" || k === "meanSecs" ? d < 0 : d > 0;
      console.log(`  ${k.padEnd(14)} ${base[k].toFixed(2)} -> ${(summary as any)[k].toFixed(2)}  ${d === 0 ? "=" : better ? "better" : "worse"}`);
    }
  }

  const outDir = path.join(root, ".scout-cache", "evals");
  mkdirSync(outDir, { recursive: true });
  const stamp = summary.at.replace(/[:.]/g, "-");
  writeFileSync(path.join(outDir, `${stamp}.json`), JSON.stringify({ summary, rows }, null, 2));
  if (saveBaseline && !filter) {
    writeFileSync(basePath, JSON.stringify({ summary, rows }, null, 2));
    console.log("\nSaved as the new baseline.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
