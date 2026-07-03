// Discovery engine: build queries -> Tavily -> Claude extract -> dedupe.
// This is the heart of both your scripts (07_Discovery.gs), condensed for the
// spike. Same shape: queries from goal+template, web search, structured
// extraction, a known-index dedupe so the same target never repeats.

import { claudeJson, parseJsonLoose } from "./claude";
import { tavilySearch, TavilyResult } from "./tavily";
import { resolveTemplate, GENERIC } from "./templates";
import { ApiCreditError } from "./apiErrors";
import { targetKey, cappedKeys } from "./exposure";
import type { Opportunity } from "./types";

// What the user has taught Scout by denying / keeping past finds. Fed into query
// planning and extraction so the search learns their taste over time.
export interface DiscoverFeedback {
  avoid?: { name: string; reason: string }[]; // denied finds + why
  favor?: { name: string; why: string }[]; // kept / drafted finds + why they fit
}

// Compact "learned from your feedback" block for the Claude prompts.
function feedbackBlock(feedback?: DiscoverFeedback): string {
  const avoid = (feedback?.avoid || []).filter((a) => a && (a.name || a.reason)).slice(0, 12);
  const favor = (feedback?.favor || []).filter((f) => f && f.name).slice(0, 10);
  let s = "";
  if (favor.length) {
    s +=
      "\n\nWORKED BEFORE — the user KEPT and reached out to these, so favor results like them:\n" +
      favor.map((f) => `- ${f.name}${f.why ? ` (${f.why})` : ""}`).join("\n");
  }
  if (avoid.length) {
    s +=
      "\n\nREJECTED BEFORE — the user passed on these; treat the reasons as firm rules and steer away from similar results:\n" +
      avoid.map((a) => `- ${a.name}${a.reason ? `: ${a.reason}` : ""}`).join("\n");
  }
  return s;
}

function buildQueries(goal: string, useCase: string): string[] {
  const tails = resolveTemplate(useCase)?.queryTails || GENERIC.queryTails;
  const g = goal.trim();
  const set = new Set<string>();
  set.add(g);
  for (const tail of tails) set.add(tail.replace("{goal}", g));
  return Array.from(set);
}

function isNetworkingUseCase(useCase: string): boolean {
  if (resolveTemplate(useCase)?.key === "networking") return true;
  return /\b(network|coffee|mentor|connect|advice|informational)/i.test(useCase);
}

// Obvious how-to / advice / listicle pages — never actual prospects. Filtered
// before extraction so we don't waste calls turning guides into "opportunities".
function looksLikeAdvice(title: string): boolean {
  return /\b(how to|how i|tips?|a guide|guide to|ways to|steps to|best practices|advice|templates?|examples?|what to say|do'?s and don'?ts|ultimate guide|complete guide)\b/i.test(
    String(title || "")
  );
}

// Podcast episodes, video clips, and interview transcripts almost never make
// the person reachable — being a guest on a show isn't a contact channel.
// Filtered before extraction so we don't waste Claude calls on obvious dead
// ends. Own-account URLs on these hosts (a channel page, a profile) can still
// be legit, so we only skip individual-episode / individual-video URLs.
function looksLikePodcastOrVideoClip(url: string): boolean {
  const u = String(url || "").toLowerCase();
  if (!u) return false;
  // Podcast hosts — episode pages are the whole point of these hosts.
  if (/(^|\.)(buzzsprout|anchor\.fm|podbean|libsyn|transistor\.fm|captivate\.fm|simplecast|blubrry)\.com/.test(u))
    return true;
  if (/podcasts\.apple\.com\/[a-z-]+\/podcast\/.+\/id\d+\?i=\d+/.test(u)) return true; // apple episode url
  if (/open\.spotify\.com\/episode\//.test(u)) return true;
  if (/soundcloud\.com\/[^/]+\/[^/]+/.test(u)) return true; // individual soundcloud track, not a profile
  if (/(youtube\.com\/watch\?|youtu\.be\/)/.test(u)) return true; // individual youtube video
  if (/vimeo\.com\/\d+(?:\b|$)/.test(u)) return true; // individual vimeo video (numeric id)
  return false;
}

// Plan smart, industry-aligned search queries from the goal + the user's actual
// profile (their field, sub-specialty, seniority, city are inferred from ABOUT).
// This is what makes results match the user's industry instead of being generic.
// Falls back to the static template queries if there's no profile or on failure.
async function planQueries(
  goal: string,
  about: string,
  useCase: string,
  feedback?: DiscoverFeedback,
  salt?: string,
  cohortHint?: string
): Promise<string[]> {
  const g = goal.trim();
  if (!about.trim()) return buildQueries(goal, useCase);

  const jobs = isJobUseCase(useCase);
  const networking = isNetworkingUseCase(useCase);

  let guidance = "";
  if (jobs) {
    guidance =
      "Target REAL job/internship openings IN THE USER'S INDUSTRY. Every query should pair the role/field with " +
      "the user's specific industry and sub-field (e.g. for a music-business student wanting marketing: " +
      "'music industry marketing internship 2026 apply', 'record label marketing intern careers', " +
      "'Nashville entertainment marketing internship'). Include apply/careers/internship/2026, vary company types " +
      "(labels, agencies, startups, brands in that field) and add the user's city or a hub city for that industry.";
  } else if (networking) {
    guidance =
      "Target findable, REAL INDIVIDUAL PEOPLE to network with in the user's exact field, people with names and titles " +
      "you could actually reach out to. Each query combines a specific ROLE TITLE + the user's industry/sub-field + an " +
      "org type + a place + a findability signal (e.g. 'brand partnerships manager consumer beauty LinkedIn', " +
      "'growth marketing lead DTC startup email', 'product manager fintech alumni'). Prefer queries that surface " +
      "LinkedIn profiles, company team/staff/about pages, conference speaker lists, and roster or directory pages. " +
      "NEVER write queries that would return advice, how-to, tips, guides, or 'X ways to network' articles, do NOT use " +
      "the words 'how to', 'tips', 'guide', 'advice', 'template', or 'examples'.";
  } else {
    guidance =
      "Combine the goal with the user's specific field, sub-specialty, seniority and city so results match their industry.";
  }

  const year = new Date().getFullYear();
  const sys =
    "You are a search strategist for an outreach tool. From the user's goal and their profile, write web-search " +
    "queries that surface results matching BOTH the goal AND the user's industry/field/level/location (infer all of " +
    "these from ABOUT THE USER — do not ask). " +
    guidance +
    // Push the long tail: avoid the same few famous targets everyone contacts.
    " CRITICAL for relevance and to avoid spamming the same inboxes: favor NICHE, specific, less-obvious targets that " +
    "closely fit THIS user's exact sub-field, city, genre, stage and angle. Deliberately AVOID the handful of biggest, " +
    "most-famous, most-submitted-to names everyone already contacts; go for the long tail of smaller, genuinely-matching, " +
    "more responsive contacts. Make each query hyper-specific (sub-genre, neighborhood/city, company size, seniority) " +
    "rather than broad. " +
    (salt
      ? `Variation seed "${salt}": use it to choose DIFFERENT valid sub-angles and segments than a generic run would, so ` +
        "two people with a similar goal get different, equally-relevant results instead of the same list. "
      : "") +
    // Aggregate "people like you" guidance from similar users (never individual data).
    (cohortHint ? `PEOPLE-LIKE-YOU SIGNAL (aggregate, use as a soft steer not a rule): ${cohortHint} ` : "") +
    ` The current year is ${year}; for any dated query use ${year} or ${year + 1} (the current or upcoming cycle), never a past year. ` +
    "Return ONLY JSON {\"queries\": string[]} with 6 to 8 short, high-signal queries. Keep each query standalone and " +
    "natural (avoid heavy boolean syntax). Do not invent facts about the user beyond what ABOUT implies.";
  const user =
    `USE CASE: ${useCase}\nGOAL: ${g}\nABOUT THE USER (their industry, sub-field, seniority and city are in here): ${about.slice(0, 1600)}` +
    feedbackBlock(feedback);

  try {
    const parsed: any = parseJsonLoose(await claudeJson(sys, user));
    const qs = (Array.isArray(parsed?.queries) ? parsed.queries : [])
      .map((s: any) => String(s || "").trim())
      .filter(Boolean)
      .slice(0, 8);
    if (qs.length >= 3) return Array.from(new Set([g, ...qs]));
    return buildQueries(goal, useCase);
  } catch (e) {
    if (e instanceof ApiCreditError) throw e;
    return buildQueries(goal, useCase);
  }
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
  useCase: string,
  feedback?: DiscoverFeedback
): Promise<Partial<Opportunity> & { isRelevant?: boolean } | null> {
  const noun = (resolveTemplate(useCase)?.targetNoun || GENERIC.targetNoun).replace(/s$/, "");
  const sys =
    `You are a research assistant. From a web search result, extract a structured record of ONE REAL, SPECIFIC ${noun || "target"} ` +
    `the user could actually reach out to, matching their GOAL and USE CASE. Return ONLY a JSON object, no prose, no markdown. ` +
    `Never invent contact details or facts — leave a field empty if it is not present in the result. ` +
    `THE RESULT MUST BE AN ACTUAL PROSPECT, not content about outreach. Set is_relevant to false (and target_type "other") ` +
    `for anything that is ADVICE or GENERAL CONTENT rather than a specific reachable person or organization: how-to guides, ` +
    `"tips"/"advice"/"best practices" articles, "X ways to network" or "top 10" listicles, template/example collections, ` +
    `blog posts about how to reach out, news articles, login/paywall pages, pay-to-play services, off-industry results, and ` +
    `the user themselves. A real person's LinkedIn profile, a staff/team page, or a specific company IS a valid prospect; ` +
    `an article teaching you how to network is NOT. ` +
    `MENTIONED IS NOT ENOUGH: if the source is about a PROGRAM, EVENT, ORGANIZATION, or EMPLOYER and only mentions a person ` +
    `by name in passing — no personal profile page, no interview with them, no direct contact channel — set is_relevant to false. ` +
    `For target_type "person", the source must EITHER be about the person themselves (their profile page, an interview with ` +
    `them, coverage of their own career) OR give a direct contact channel (email or LinkedIn URL / handle). Otherwise it's ` +
    `not a real point of contact. ` +
    `WHY_IT_FITS DISCIPLINE: must be a specific true detail about THE PERSON'S OWN work, career, projects, or interests — ` +
    `not about their employer or program. If you can only describe the program they work at, that's a sign this isn't a real ` +
    `prospect; set is_relevant false. ` +
    `PODCASTS / INTERVIEWS / VIDEO CLIPS: episodes, YouTube videos, and interview transcripts almost never make the person ` +
    `reachable. If the source is a podcast episode or a video and the person is just the guest — no direct email, no LinkedIn ` +
    `linked from the page, no contact channel — set is_relevant false. Being interviewed on a podcast is not a way to be reached. ` +
    `INDUSTRY ALIGNMENT IS CRITICAL: judge against the user's field (from ABOUT THE USER + USE CASE); if clearly outside their ` +
    `industry (e.g. sports for a music search, medicine for a marketing search), set is_relevant false and fit_score below 0.3. ` +
    `Never surface cross-industry hits unless the goal explicitly asks for that other industry. ` +
    `LOCATION ALIGNMENT: if the user's ABOUT includes a location and the result is clearly in a different region / country / ` +
    `far-away city, penalize fit_score (below 0.4). Remote / global / same region = no penalty. Empty user location = no penalty. ` +
    `TIME WINDOW ALIGNMENT: if the user's GOAL specifies a semester or year (e.g. "Fall 2026 internships", "summer 2027 roles"), ` +
    `and the posting is clearly for a different window (already-closed 2024 posting, or the wrong semester), set is_relevant ` +
    `false. Don't invent a mismatch when the posting's timing is unclear — only reject when the source explicitly says the wrong ` +
    `window. Reserve fit_score above 0.7 for results matching goal + industry + location + time window; give 0.3 or below when ` +
    `two or more of those are off.`;
  const fields =
    `Fields: is_relevant (bool), target_type (one of "person", "organization", "other" — use "other" for any article/guide/advice/listicle), ` +
    `name (the person/company/outlet, plus role if any), outlet (org/company/publication), ` +
    `channel (how to reach them: one of Email, LinkedIn, Website Form, Company Portal, Unknown), ` +
    `contact_email, contact_name (a named person if shown), contact_role, contact_handle (a LinkedIn URL or @handle), ` +
    `url (best link), location, ` +
    `timezone (the IANA timezone for their location, e.g. "America/Chicago" for Nashville TN, "Europe/London" for London; empty if the location is unknown or remote/global), ` +
    `fit_score (0 to 1, how well this matches the goal AND the user's industry), ` +
    `why_it_fits (one specific, true detail about them tied to the user's field, used to personalize outreach; empty if unknown).`;
  const ctx =
    `USER'S USE CASE: ${useCase}\nUSER GOAL: ${goal}\nABOUT THE USER: ${about}`;
  const learned = feedbackBlock(feedback);
  const user =
    `${ctx}\n${fields}${learned}\n\nSEARCH RESULT:\nTitle: ${cand.title || ""}\nURL: ${cand.url || ""}\nContent: ${String(cand.content || "").slice(0, 2800)}`;
  try {
    return parseJsonLoose(await claudeJson(sys, user));
  } catch (e) {
    if (e instanceof ApiCreditError) throw e; // credits/auth/limit — don't swallow
    return null;
  }
}

// One candidate that discover() considered but dropped, plus the human-readable
// reason. Surfaced in the UI's "See what was filtered" panel so we can debug
// prompt/filter tweaks without re-running full searches.
export interface SkippedCandidate {
  title: string;
  url: string;
  reason: string;
}

export interface DiscoverResult {
  opportunities: Opportunity[];
  searched: number;
  candidates: number;
  skippedDupes: number;
  skippedNotFit: number;
  skippedCapped: number; // dropped because too many other users already contacted them
  skipped: SkippedCandidate[]; // per-candidate log of what got dropped and why
}

export async function discover(
  goal: string,
  about: string,
  useCase: string,
  maxItems = 10,
  feedback?: DiscoverFeedback,
  salt?: string,
  cohortHint?: string
): Promise<DiscoverResult> {
  const queries = await planQueries(goal, about, useCase, feedback, salt, cohortHint);
  const networking = isNetworkingUseCase(useCase);
  // Skip anyone the user already denied by name — never resurface a rejected find.
  const deniedNames = new Set(
    (feedback?.avoid || []).map((a) => normName(a.name)).filter(Boolean)
  );

  // Per-candidate log of what got skipped and why. Populated at every skip
  // point below so the UI can show a "See what was filtered" panel.
  const skipped: SkippedCandidate[] = [];
  const logSkip = (title: string, url: string, reason: string) => {
    // Cap so a huge candidate pool doesn't balloon the response.
    if (skipped.length < 60) skipped.push({ title: title || "", url: url || "", reason });
  };

  // 1+2: gather + dedupe candidate pages.
  const candidates: TavilyResult[] = [];
  const seenLinks = new Set<string>();
  for (const q of queries) {
    if (candidates.length >= maxItems * 4) break;
    const results = await tavilySearch(q, 8);
    for (const r of results) {
      if (looksLikeAdvice(r.title)) {
        logSkip(r.title, r.url, "title looks like advice / how-to");
        continue;
      }
      if (looksLikePodcastOrVideoClip(r.url)) {
        logSkip(r.title, r.url, "podcast episode or video clip (guest ≠ contact channel)");
        continue;
      }
      const k = canonicalLink(r.url) || urlHost(r.url);
      if (!k) {
        logSkip(r.title, r.url, "no usable URL");
        continue;
      }
      if (seenLinks.has(k)) {
        logSkip(r.title, r.url, "duplicate link");
        continue;
      }
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
      batch.map((c) => extract(c, goal, about, useCase, feedback))
    );
    for (let j = 0; j < recs.length; j++) {
      if (opps.length >= maxItems) break;
      const rec = recs[j];
      const cand = batch[j];
      if (!rec) {
        skippedNotFit++;
        logSkip(cand.title, cand.url, "extractor returned nothing");
        continue;
      }
      if (rec.isRelevant === false) {
        skippedNotFit++;
        logSkip(cand.title, cand.url, "extractor marked not relevant");
        continue;
      }
      if (!String((rec as any).name || "").trim()) {
        skippedNotFit++;
        logSkip(cand.title, cand.url, "extractor found no name");
        continue;
      }
      const ttype = String((rec as any).target_type || "").toLowerCase();
      // Drop advice/guide content, and for networking require an actual person.
      if (ttype === "other") {
        skippedNotFit++;
        logSkip(cand.title, cand.url, 'target_type "other" (advice/guide)');
        continue;
      }
      if (networking && ttype && ttype !== "person") {
        skippedNotFit++;
        logSkip(cand.title, cand.url, `not a person (target_type "${ttype}") for a networking search`);
        continue;
      }
      const r = rec as any;
      // Backstop for the "name mentioned in an article about their program" case:
      // if we've got a person with no email, no LinkedIn/handle, and no known
      // channel, there's no real way to reach them — skip. Company Portal / staff
      // pages / etc. still pass because their channel isn't "Unknown".
      if (ttype === "person") {
        const channel = String(r.channel || "").toLowerCase();
        const reachable =
          !!String(r.contact_email || "").trim() ||
          !!String(r.contact_handle || "").trim() ||
          (channel && channel !== "unknown");
        if (!reachable) {
          skippedNotFit++;
          logSkip(cand.title, cand.url, "person with no reachable channel (probably mentioned in passing)");
          continue;
        }
      }
      const nm = normName(r.name);
      const host = urlHost(r.url || cand.url);
      if (nm && deniedNames.has(nm)) {
        skippedDupes++;
        logSkip(cand.title, cand.url, `you denied "${r.name}" before`);
        continue; // already rejected this exact one before
      }
      if (nm && knownNames.has(nm)) {
        skippedDupes++;
        logSkip(cand.title, cand.url, `duplicate name: ${r.name}`);
        continue;
      }
      if (host && knownHosts.has(host)) {
        skippedDupes++;
        logSkip(cand.title, cand.url, `another find already on ${host}`);
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
        timezone: r.timezone || "",
        fitScore: fit,
        whyItFits: r.why_it_fits || "",
        sourceTitle: cand.title || "",
        sourceSnippet: String(cand.content || "").slice(0, 220),
      });
    }
  }

  // The same company can slip past name/host dedup by appearing both as a generic
  // entry ("Round Hill Music") and a specific posting ("Round Hill Music, Copyright
  // Internship"), often from different pages/hosts. For job/internship hunts, where
  // you want one entry per employer, collapse by company (outlet), keeping the most
  // specific (a posting title beats the bare company name).
  if (isJobUseCase(useCase)) {
    const specificity = (o: Opportunity) => {
      const on = normName(o.outlet || "");
      const nn = normName(o.name || "");
      return on && nn && nn !== on ? 1 : 0; // name says more than just the company
    };
    const byOutlet = new Map<string, Opportunity>();
    const collapsed: Opportunity[] = [];
    for (const o of opps) {
      const key = normName(o.outlet || "");
      if (!key) {
        collapsed.push(o);
        continue;
      }
      const existing = byOutlet.get(key);
      if (!existing) {
        byOutlet.set(key, o);
        collapsed.push(o);
        continue;
      }
      skippedDupes++;
      if (specificity(o) > specificity(existing)) {
        const i = collapsed.indexOf(existing);
        if (i >= 0) collapsed[i] = o;
        byOutlet.set(key, o);
      }
    }
    opps.length = 0;
    opps.push(...collapsed);
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

  // Hard cap: drop any target already contacted by too many other users recently,
  // so the same inboxes don't get blasted across profiles. Fail-open (if the
  // ledger is unreachable, nothing is dropped).
  //
  // IMPORTANT: only cap PERSONAL outreach (networking, PR, individual contacts).
  // Job/internship postings are MEANT to receive many applicants, so there is no
  // cap on those — everyone can and should apply to the same opening.
  let kept = opps;
  let skippedCapped = 0;
  if (!isJobUseCase(useCase)) {
    try {
      const capped = await cappedKeys(opps.map((o) => targetKey(o)));
      if (capped.size) {
        kept = opps.filter((o) => {
          const k = targetKey(o);
          if (k && capped.has(k)) {
            logSkip(
              o.name,
              o.url,
              "capped: many other Scout users already reached out to this contact"
            );
            return false;
          }
          return true;
        });
        skippedCapped = opps.length - kept.length;
      }
    } catch {
      kept = opps;
    }
  }

  return {
    opportunities: kept,
    searched: queries.length + enrichSearches,
    candidates: candidates.length,
    skippedDupes,
    skippedNotFit,
    skippedCapped,
    skipped,
  };
}
