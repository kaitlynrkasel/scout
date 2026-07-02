// Discovery engine: build queries -> Tavily -> Claude extract -> dedupe.
// This is the heart of both your scripts (07_Discovery.gs), condensed for the
// spike. Same shape: queries from goal+template, web search, structured
// extraction, a known-index dedupe so the same target never repeats.

import { claudeJson, parseJsonLoose } from "./claude";
import { tavilySearch, TavilyResult } from "./tavily";
import { resolveTemplate, GENERIC } from "./templates";
import { ApiCreditError } from "./apiErrors";
import type { Opportunity } from "./types";

function buildQueries(goal: string, useCase: string): string[] {
  const tails = resolveTemplate(useCase)?.queryTails || GENERIC.queryTails;
  const g = goal.trim();
  const set = new Set<string>();
  set.add(g);
  for (const tail of tails) set.add(tail.replace("{goal}", g));
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

// Is this a job/internship hunt? Those postings rarely list a real person, so we
// do an extra pass to find a named recruiter / team member to email.
function isJobUseCase(useCase: string): boolean {
  if (resolveTemplate(useCase)?.key === "jobs") return true;
  // Prefix matches (no trailing boundary) so plurals like "internships" count.
  return /\b(job|intern|hiring|hire|recruit|new ?grad|co-?op|career|apply|application)/i.test(
    useCase
  );
}

// Generic inbox prefixes — not a specific person, so we still try to find one.
const GENERIC_EMAIL =
  /^(careers?|jobs?|hr|recruit(ing|ment)?|talent|info|hello|contact|apply|applications?|resumes?|staffing|people|hiring|admin|support|team|noreply|no-reply)@/i;

function hasPersonalEmail(o: Opportunity): boolean {
  return (
    !!o.contactEmail &&
    !!o.contactName &&
    !GENERIC_EMAIL.test(o.contactEmail.trim())
  );
}

// For one opening, hunt for a specific person in recruiting or on the team who an
// applicant could email. Never invents contacts — only what appears in results.
async function findRecruiterContact(
  opp: Opportunity,
  goal: string
): Promise<{ name: string; role: string; email: string; handle: string } | null> {
  const company = (opp.outlet || opp.name || "").trim();
  if (!company) return null;

  const queries = [
    `${company} recruiter OR "talent acquisition" email`,
    `${company} ${goal} hiring manager OR "university recruiting" contact email`,
  ];
  const snippets: string[] = [];
  try {
    for (const q of queries) {
      const results = await tavilySearch(q, 4);
      for (const r of results) {
        snippets.push(
          `Title: ${r.title || ""}\nURL: ${r.url || ""}\n${String(r.content || "").slice(0, 900)}`
        );
      }
      if (snippets.length >= 8) break;
    }
  } catch (e) {
    if (e instanceof ApiCreditError) throw e;
    return null;
  }
  if (!snippets.length) return null;

  const sys =
    `You find ONE specific, named person at a company who someone applying for a role could email: ` +
    `a recruiter, talent-acquisition contact, hiring manager, university recruiter, or a member of the relevant team. ` +
    `Return ONLY JSON {name, role, email, handle}. CRITICAL: never invent an email or a name. Use only values that ` +
    `appear verbatim in the results. Prefer a real personal work email for a NAMED person over a generic inbox ` +
    `(careers@, jobs@, hr@, info@). If you can only find a named person's LinkedIn (no email), fill name/role/handle ` +
    `and leave email empty. If nothing specific to a real person is present, return all-empty fields.`;
  const user =
    `COMPANY: ${company}\nROLE THEY WANT: ${goal}\n\nSEARCH RESULTS:\n${snippets.join("\n\n").slice(0, 6000)}`;

  try {
    const parsed: any = parseJsonLoose(await claudeJson(sys, user));
    const email = String(parsed?.email || "").trim();
    const name = String(parsed?.name || "").trim();
    const handle = String(parsed?.handle || "").trim();
    const role = String(parsed?.role || "").trim();
    // Require at least a named person OR a usable email; drop generic-only inboxes.
    if (!name && !email) return null;
    if (email && GENERIC_EMAIL.test(email) && !name) return null;
    return { name, role, email, handle };
  } catch (e) {
    if (e instanceof ApiCreditError) throw e;
    return null;
  }
}

async function extract(
  cand: TavilyResult,
  goal: string,
  about: string,
  useCase: string
): Promise<Partial<Opportunity> & { isRelevant?: boolean } | null> {
  const noun = (resolveTemplate(useCase)?.targetNoun || GENERIC.targetNoun).replace(/s$/, "");
  const sys =
    `You are a research assistant. From a web search result, extract a structured record of one ${noun || "target"} ` +
    `the user could reach out to, matching their GOAL and USE CASE. Return ONLY a JSON object, no prose, no markdown. ` +
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
    `USER'S USE CASE: ${useCase}\nUSER GOAL: ${goal}\nABOUT THE USER: ${about}`;
  const user =
    `${ctx}\n${fields}\n\nSEARCH RESULT:\nTitle: ${cand.title || ""}\nURL: ${cand.url || ""}\nContent: ${String(cand.content || "").slice(0, 2800)}`;
  try {
    return parseJsonLoose(await claudeJson(sys, user));
  } catch (e) {
    if (e instanceof ApiCreditError) throw e; // credits/auth/limit — don't swallow
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
  useCase: string,
  maxItems = 10
): Promise<DiscoverResult> {
  const queries = buildQueries(goal, useCase);

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
      batch.map((c) => extract(c, goal, about, useCase))
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

  // For job/internship hunts, attach a specific recruiter / team-member contact
  // to openings that don't already list a real person. Enrich the top few in
  // parallel (bounded so we stay within the serverless time budget).
  let enrichSearches = 0;
  if (isJobUseCase(useCase)) {
    const needContact = opps.filter((o) => !hasPersonalEmail(o)).slice(0, 6);
    enrichSearches = needContact.length * 2;
    const found = await Promise.all(
      needContact.map((o) => findRecruiterContact(o, goal).catch(() => null))
    );
    needContact.forEach((o, i) => {
      const c = found[i];
      if (!c) return;
      if (c.name && !o.contactName) o.contactName = c.name;
      if (c.role && !o.contactRole) o.contactRole = c.role;
      if (c.handle && !o.contactHandle) o.contactHandle = c.handle;
      if (c.email && !o.contactEmail) {
        o.contactEmail = c.email;
        if (o.channel === "Company Portal" || o.channel === "Unknown") o.channel = "Email";
      }
    });
  }

  return {
    opportunities: opps,
    searched: queries.length + enrichSearches,
    candidates: candidates.length,
    skippedDupes,
    skippedNotFit,
  };
}
