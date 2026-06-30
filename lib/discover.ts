// Discovery engine: build queries -> Tavily -> Claude extract -> dedupe.
// This is the heart of both your scripts (07_Discovery.gs), condensed for the
// spike. Same shape: queries from goal+template, web search, structured
// extraction, a known-index dedupe so the same target never repeats.

import { claudeJson, parseJsonLoose } from "./claude";
import { tavilySearch, TavilyResult } from "./tavily";
import { TEMPLATES } from "./templates";
import type { Opportunity, TemplateKey } from "./types";

function buildQueries(goal: string, templateKey: TemplateKey): string[] {
  const t = TEMPLATES[templateKey];
  const g = goal.trim();
  const set = new Set<string>();
  set.add(g);
  for (const tail of t.queryTails) set.add(tail.replace("{goal}", g));
  return Array.from(set);
}

function urlHost(u: string): string {
  const m = String(u || "").match(/^https?:\/\/([^\/?#]+)/i);
  return m ? m[1].replace(/^www\./, "").toLowerCase() : "";
}

function canonicalLink(u: string): string {
  const m = String(u || "")
    .trim()
    .match(/^https?:\/\/([^\/?#]+)([^?#]*)/i);
  return m
    ? (m[1].replace(/^www\./, "").toLowerCase() +
        (m[2] || "").replace(/\/+$/, "").toLowerCase())
    : "";
}

function normName(s: string): string {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

async function extract(
  cand: TavilyResult,
  goal: string,
  about: string,
  templateKey: TemplateKey
): Promise<Partial<Opportunity> & { isRelevant?: boolean } | null> {
  const t = TEMPLATES[templateKey];
  const sys =
    `You are a research assistant. From a web search result, extract a structured record of one ${t.targetNoun.slice(0, -1) || "target"} ` +
    `the user could reach out to, matching their GOAL. Return ONLY a JSON object, no prose, no markdown. ` +
    `Never invent contact details or facts — leave a field empty if it is not present in the result. ` +
    `Set is_relevant to false for: news articles, generic "top 10" listicles with no specific target, login/paywall pages, ` +
    `pay-to-play services, and the user themselves.`;
  const fields =
    `Fields: is_relevant (bool), name (the person/company/outlet, plus role if any), outlet (org/company/publication), ` +
    `channel (how to reach them: one of Email, LinkedIn, Website Form, Company Portal, Unknown), ` +
    `contact_email, contact_name (a named person if shown), contact_role, contact_handle (a LinkedIn URL or @handle), ` +
    `url (best link), location, fit_score (0 to 1, how well this matches the goal), ` +
    `why_it_fits (one specific, true detail about them, used to personalize outreach; empty if unknown).`;
  const ctx =
    `USER GOAL: ${goal}\nABOUT THE USER: ${about}\nVERTICAL: ${t.label}.`;
  const user =
    `${ctx}\n${fields}\n\nSEARCH RESULT:\nTitle: ${cand.title || ""}\nURL: ${cand.url || ""}\nContent: ${String(cand.content || "").slice(0, 2800)}`;
  try {
    return parseJsonLoose(await claudeJson(sys, user));
  } catch {
    return null;
  }
}

export interface DiscoverResult {
  opportunities: Opportunity[];
  searched: number;
  candidates: number;
  skippedDupes: number;
  skippedNotFit: number;
}

export async function discover(
  goal: string,
  about: string,
  templateKey: TemplateKey,
  maxItems = 10
): Promise<DiscoverResult> {
  const queries = buildQueries(goal, templateKey);

  // 1+2: gather + dedupe candidate pages.
  const candidates: TavilyResult[] = [];
  const seenLinks = new Set<string>();
  for (const q of queries) {
    if (candidates.length >= maxItems * 4) break;
    const results = await tavilySearch(q, 8);
    for (const r of results) {
      const k = canonicalLink(r.url) || urlHost(r.url);
      if (!k || seenLinks.has(k)) continue;
      seenLinks.add(k);
      candidates.push(r);
    }
  }

  // 3: extract structured records, dedupe by name/host, cap at maxItems.
  const opps: Opportunity[] = [];
  const knownNames = new Set<string>();
  const knownHosts = new Set<string>();
  let skippedDupes = 0;
  let skippedNotFit = 0;

  // Extract in small parallel batches so the spike is reasonably fast.
  const batchSize = 4;
  for (let i = 0; i < candidates.length && opps.length < maxItems; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);
    const recs = await Promise.all(
      batch.map((c) => extract(c, goal, about, templateKey))
    );
    for (let j = 0; j < recs.length; j++) {
      if (opps.length >= maxItems) break;
      const rec = recs[j];
      const cand = batch[j];
      if (!rec || rec.isRelevant === false || !String((rec as any).name || "").trim()) {
        skippedNotFit++;
        continue;
      }
      const r = rec as any;
      const nm = normName(r.name);
      const host = urlHost(r.url || cand.url);
      if ((nm && knownNames.has(nm)) || (host && knownHosts.has(host))) {
        skippedDupes++;
        continue;
      }
      if (nm) knownNames.add(nm);
      if (host) knownHosts.add(host);

      let fit = typeof r.fit_score === "number" ? r.fit_score : parseFloat(r.fit_score);
      if (isNaN(fit)) fit = null as any;

      opps.push({
        id: `${Date.now()}-${opps.length}`,
        name: String(r.name).trim(),
        outlet: r.outlet || "",
        url: r.url || cand.url || "",
        channel: r.channel || "Unknown",
        contactEmail: r.contact_email || "",
        contactName: r.contact_name || "",
        contactRole: r.contact_role || "",
        contactHandle: r.contact_handle || "",
        location: r.location || "",
        fitScore: fit,
        whyItFits: r.why_it_fits || "",
        sourceTitle: cand.title || "",
        sourceSnippet: String(cand.content || "").slice(0, 220),
      });
    }
  }

  // Best-fit first.
  opps.sort((a, b) => (b.fitScore || 0) - (a.fitScore || 0));

  return {
    opportunities: opps,
    searched: queries.length,
    candidates: candidates.length,
    skippedDupes,
    skippedNotFit,
  };
}
