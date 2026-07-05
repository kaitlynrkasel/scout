// Discovery engine: build queries -> Tavily -> Claude extract -> dedupe.
// This is the heart of both your scripts (07_Discovery.gs), condensed for the
// spike. Same shape: queries from goal+template, web search, structured
// extraction, a known-index dedupe so the same target never repeats.

import { claudeJson, parseJsonLoose } from "./claude";
import { tavilySearch, TavilyResult } from "./tavily";
import { resolveTemplate, GENERIC, isProspectingUseCase } from "./templates";
import { ApiCreditError } from "./apiErrors";
import { targetKey, cappedKeys } from "./exposure";
import type { Opportunity } from "./types";

// ---- Auto-tunable fit-scoring clauses ----
// Isolated as single-string constants (not woven into the surrounding
// template-literal concatenation) so /api/cron/auto-tune can safely locate,
// replace, and re-commit just ONE of these based on real deny-reason data,
// without touching the rest of extract()'s logic. Each must stay a single
// backtick-delimited string ending in a semicolon on its own — that's what
// makes the auto-editor's regex extraction reliable. See lib/autotune.ts.
export const TUNABLE_INDUSTRY_ALIGNMENT_CLAUSE =
  `INDUSTRY ALIGNMENT: judge against the user's field (from ABOUT THE USER + USE CASE); if clearly outside their industry (e.g. sports for a music search, medicine for a marketing search), set is_relevant false and fit_score below 0.3. Never surface cross-industry hits unless the goal explicitly asks for that other industry.`;

export const TUNABLE_LOCATION_ALIGNMENT_CLAUSE =
  `LOCATION ALIGNMENT: if the user's ABOUT includes a location and the result is clearly a different region / far city, penalize fit_score (below 0.4). Remote / global / same region = no penalty. Empty user location = no penalty.`;

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

// isProspectingUseCase (imported above) covers: the user is finding EXTERNAL
// targets to pitch, sell to, partner with, get sponsored by, or raise money
// from. The target lives in a DIFFERENT world than the user — a marketing
// agency pitching restaurants, a SaaS founder selling to any industry, a
// nonprofit chasing sponsors. For these, the user's own industry must NOT
// filter results; the GOAL defines the target profile. Contrast with
// networking/jobs, where the target IS in the user's field and industry
// alignment against the user is exactly right.

// The user has explicitly widened the target to any industry / anywhere. When
// the goal says this, we drop industry + location filtering no matter the use
// case, because the user is telling us the net is intentionally wide.
function goalWantsAnyIndustry(goal: string): boolean {
  // Loose enough to catch "any other industry", "any type of industry", "any
  // kind of business", etc, not just the exact phrase "any industry" — a
  // fixed two-word match was silently missing common real-world phrasings.
  return /\b(any (other |type of |kind of |given )*(industry|field|sector|vertical|niche|business)|all (industries|sectors|fields|businesses)|every (industry|sector|business)|industry.?agnostic|no (specific )?industry|regardless of (the )?industry|(not|isn'?t) industry.?specific|across industries|open to (any|all) industr(y|ies)|doesn'?t matter (the |what )?industry)\b/i.test(
    goal || ""
  );
}
function goalWantsAnywhere(goal: string): boolean {
  return /\b(anywhere|any (location|city|region|country|state|area)|nationwide|worldwide|global(ly)?|remote|no (specific )?location|regardless of location|located anywhere)\b/i.test(
    goal || ""
  );
}

// Influencer / creator discovery: brand looking for social creators, PR looking
// for TikTokers to send product to, etc. These use cases live mostly outside
// Scout's crawlable web — IG/TikTok/X are login-walled — so we lean on
// roundup articles, blog listicles, and aggregator sites that name creators
// and link out to their socials.
function isInfluencerUseCase(useCase: string): boolean {
  return /\b(influenc|creator|content creator|tiktok(er)?|instagram(m?er)?|youtub(er|e creator)|streamer|micro-?influenc|nano-?influenc|ugc)/i.test(
    useCase
  );
}

// Same intent, read from the GOAL text rather than the use-case label. Without
// this, "find TikTok creators posting folk covers" typed under a "Music PR"
// use case never triggered the creator pipeline — the single most common way
// social searches quietly under-performed. Kept a touch stricter than the
// use-case check so a normal search that merely mentions a platform (e.g.
// "companies that have an Instagram") doesn't get pulled into creator mode:
// require an explicit creator noun, OR a platform paired with creator context.
function goalWantsSocialCreators(goal: string): boolean {
  const g = String(goal || "");
  if (
    /\b(influencers?|content creators?|creators?|tiktokers?|youtubers?|instagrammers?|streamers?|ugc creators?|micro-?influencers?|nano-?influencers?)\b/i.test(
      g
    )
  )
    return true;
  return (
    /\b(tiktok|instagram|youtube|twitch|\breels?\b|shorts)\b/i.test(g) &&
    /\b(creator|influencer|account|channel|page|follow|handle|dm)\b/i.test(g)
  );
}

// The engine treats a search as social-creator discovery when EITHER the use
// case or the goal says so. Drives query strategy (roundup articles), the
// multi-person listicle extractor, deeper Tavily crawling, and the advice
// filter's leniency toward "top 10 creators" style titles.
function isSocialCreatorSearch(useCase: string, goal: string): boolean {
  return isInfluencerUseCase(useCase) || goalWantsSocialCreators(goal);
}

// Pages structured as ranked / listed roundups — the primary source for
// finding creators when we can't crawl the social platforms themselves.
// "Top 10 beauty TikTokers", "Best Nashville influencers to follow", etc.
export function looksLikeListicle(title: string): boolean {
  const t = String(title || "");
  if (!t.trim()) return false;
  // A leading number ("10 Beauty Influencers…") is a strong signal.
  if (/^\s*\d{1,3}\b/.test(t)) return true;
  return /\b(top\s+\d+|best\s+\d+|our (favorite|favourite|top)\s+\w+|\d+\s+\w+(?:\s+\w+)?\s+to\s+(follow|watch|know)|\w+\s+you should (know|follow)|\d+\s+\w+ (accounts|creators|influencers|people|voices) to)\b/i.test(
    t
  );
}

// Obvious how-to / advice pages — never actual prospects. For influencer use
// cases, listicle-style roundups DO count as source material (that's how you
// find creators when their content lives inside login-walled apps), so those
// bypass this filter. Standard how-to / tips content still gets dropped.
function looksLikeAdvice(title: string, useCase = "", goal = ""): boolean {
  const t = String(title || "");
  const generic = /\b(how to|how i|tips?|a guide|guide to|ways to|steps to|best practices|advice|templates?|what to say|do'?s and don'?ts|ultimate guide|complete guide)\b/i.test(
    t
  );
  if (!generic) return false;
  // For creator discovery, "10 tips for growing on TikTok" is still noise,
  // but "10 beauty creators to follow" isn't; the listicle check above catches
  // the second. If BOTH signals match, prefer the listicle read (keep it).
  if (isSocialCreatorSearch(useCase, goal) && looksLikeListicle(t)) return false;
  return true;
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
  cohortHint?: string,
  personalOverride?: string,
  // Broaden mode: a narrower first pass returned nothing, so widen the net —
  // relax the niche/long-tail/geo/segment constraints and allow bigger, more
  // obvious targets so a very specific goal degrades to *some* results instead
  // of an empty screen.
  broaden = false
): Promise<string[]> {
  const g = goal.trim();
  if (!about.trim()) return buildQueries(goal, useCase);

  const jobs = isJobUseCase(useCase);
  const networking = isNetworkingUseCase(useCase);
  const influencer = isSocialCreatorSearch(useCase, goal);
  const prospecting = isProspectingUseCase(useCase) || goalWantsAnyIndustry(goal);
  // The industry anchor below stops queries from clustering in the user's own
  // field. Location needs the exact same guard: ABOUT is the only place a
  // city ever appears for this user, so with no explicit instruction the
  // model quietly grounds queries in the sender's own city even when the
  // goal says "any location" — this was the actual cause of prospecting
  // searches still coming back Nashville/music-flavored.
  const anywhere = goalWantsAnywhere(goal);

  let guidance = "";
  // Creator/social intent is checked FIRST: a creator search that also says
  // "any industry" should still use the roundup strategy, not the company-
  // directory one, so it must win over the prospecting branch below.
  if (influencer) {
    guidance =
      "Target curated ROUNDUP articles and listicles that NAME real social creators — that's where we find them, " +
      "since Instagram / TikTok / X / YouTube block deep search. Combine the specific niche + platform + geography + a " +
      "roundup signal. Good query patterns: 'top 10 {niche} {platform} {city}', 'best {niche} creators to follow', " +
      "'{niche} {platform} accounts to know', '{niche} micro-influencer roundup', '{niche} {platform} directory', " +
      "'{niche} creators linktree {city}'. If the GOAL names a specific platform, prioritize it; otherwise spread queries " +
      "across the majors (TikTok, Instagram, YouTube, and where it fits Twitch or X) so coverage isn't stuck on one app. " +
      "Prefer queries that will surface: local magazine / press features (Voyager, Time Out, city guides), brand blog " +
      "roundups, agency directories, aggregator sites (Later, Modash public pages, HypeAuditor blog, Klear, Collabstr, " +
      "SocialBlade). Include '{platform}.com' in some queries so pages that mention creator @handles surface. NEVER use " +
      "'how to' or 'tips' — those are advice, not creator lists.";
  } else if (prospecting) {
    guidance =
      "The user is PROSPECTING — finding external companies / people to pitch, sell to, partner with, or raise from. The " +
      "targets live in DIFFERENT industries than the user, so do NOT bias queries toward the user's own field. Build queries " +
      "from the GOAL's target profile (size, type, stage, location) plus a findability signal that surfaces a contact route. " +
      "Good query patterns: '{target type} companies contact email', '{target type} directory', 'list of {target type} " +
      "businesses', '{target type} companies {city}' (only if the goal names a place), '{industry} startups contact us', " +
      "'{target type} companies with phone number email'. Prefer queries that surface company contact / about pages, business " +
      "directories, chamber-of-commerce and association member lists, and curated roundups of companies. If the goal says ANY " +
      "industry, vary the industries across queries (e.g. one for local retailers, one for professional-services firms, one " +
      "for SaaS startups) to cast a wide net. NEVER use 'how to', 'tips', 'guide', or 'advice'.";
  } else if (jobs) {
    guidance =
      "Target REAL job/internship openings IN THE USER'S INDUSTRY. Every query should pair the role/field with " +
      "the user's specific industry and sub-field (e.g. for a marketing junior wanting a brand internship: " +
      "'brand marketing internship summer 2026 apply', 'growth marketing intern DTC careers', " +
      "'New York consumer brand marketing internship'). Include apply/careers/internship/2026, vary company types " +
      "(agencies, startups, established brands in that field) and add the user's city or a hub city for that industry.";
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
  const anyIndustry = goalWantsAnyIndustry(goal);
  // In prospecting / any-industry mode the TARGET lives in a different world than
  // the user, so anchoring queries to the user's own field (e.g. a music-industry
  // profile) is exactly wrong — it's why an "any industry" search kept returning
  // only music. The GOAL defines the target; the user's field must not filter.
  const anchor = prospecting
    ? "You are a search strategist for an outreach tool. The user is PROSPECTING: write web-search queries that surface " +
      "the TARGETS DESCRIBED BY THE GOAL. Do NOT anchor to the user's own industry, field, or genre (from ABOUT) — those " +
      "targets live in DIFFERENT industries than the user, and biasing toward the user's field would return the wrong " +
      "results. Use ABOUT only to understand what the user sells/offers, never as an industry filter on the targets. " +
      "USE CASE is just a category label for this search, not the product being pitched — if ABOUT describes a specific " +
      "product, tool, or service (even one sentence naming it), THAT is what's being offered; never substitute the USE " +
      "CASE label as the offering (e.g. a 'Music PR' use case prospecting for a software tool's customers is NOT selling " +
      "music services — it's selling that tool, so don't bias queries toward buyers of music-related things). " +
      (anywhere
        ? "The user has said the target can be ANYWHERE — do NOT use the sender's own city, state, or region from ABOUT " +
          "as a query parameter, even implicitly; it is not a location constraint on the targets. "
        : "Only use a location in queries if the GOAL ITSELF explicitly names one. The sender's own city/region in ABOUT " +
          "describes the sender, not where the targets should be — never default to it as a stand-in location. ")
    : "You are a search strategist for an outreach tool. From the user's goal and their profile, write web-search " +
      "queries that surface results matching BOTH the goal AND the user's industry/field/level/location (infer all of " +
      "these from ABOUT THE USER — do not ask). ";
  // The long-tail push: for prospecting, "specific" means the GOAL's target
  // profile (type/size/stage/place), not the user's sub-field/genre.
  const longTail = prospecting
    ? (anyIndustry
        ? " CRITICAL: the user asked for ANY industry, so span MANY different industries across the query set (e.g. one " +
          "for local retailers, one for professional-services firms, one for trades, one for hospitality, one for SaaS) " +
          "instead of clustering in one. "
        : " CRITICAL: keep queries specific to the GOAL's target profile (type, size, stage, location). ") +
      "Favor NICHE, smaller, more-responsive targets over the handful of biggest names everyone already contacts. " +
      "Make each query hyper-specific to the target profile (segment, company size, city) rather than broad. "
    : " CRITICAL for relevance and to avoid spamming the same inboxes: favor NICHE, specific, less-obvious targets that " +
      "closely fit THIS user's exact sub-field, city, genre, stage and angle. Deliberately AVOID the handful of biggest, " +
      "most-famous, most-submitted-to names everyone already contacts; go for the long tail of smaller, genuinely-matching, " +
      "more responsive contacts. Make each query hyper-specific (sub-genre, neighborhood/city, company size, seniority) " +
      "rather than broad. ";
  const broadenClause = broaden
    ? " BROADEN MODE: a narrower version of this search just returned NO results, so widen the net now. DROP the niche / " +
      "long-tail / hyper-specific push above. Use simpler, broader queries with FEWER combined constraints — relax location, " +
      "company size, sub-genre, seniority and segment filters, and it is fine to include larger, well-known targets. Stay " +
      "on-topic for the GOAL, but prioritize surfacing real, reachable results over being specific. "
    : "";
  const sys =
    anchor +
    guidance +
    longTail +
    broadenClause +
    (salt
      ? `Variation seed "${salt}": use it to choose DIFFERENT valid sub-angles and segments than a generic run would, so ` +
        "two people with a similar goal get different, equally-relevant results instead of the same list. "
      : "") +
    // Aggregate "people like you" guidance from similar users (never individual data).
    (cohortHint ? `PEOPLE-LIKE-YOU SIGNAL (aggregate, use as a soft steer not a rule): ${cohortHint} ` : "") +
    ` The current year is ${year}; for any dated query use ${year} or ${year + 1} (the current or upcoming cycle), never a past year. ` +
    "Return ONLY JSON {\"queries\": string[]} with 6 to 8 short, high-signal queries. Keep each query standalone and " +
    "natural (avoid heavy boolean syntax). Do not invent facts about the user beyond what ABOUT implies." +
    // This user's own calibration, appended last so it takes priority over
    // the guidance above when they conflict (same mechanism as coaching for
    // drafting) — see buildPersonalOverride in lib/autotune.ts.
    (personalOverride ? `\n\n${personalOverride}` : "");
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

// Decide which URL to attach to an extracted opp. Prefers the LLM's URL when
// it's demonstrably real — its host either matches the Tavily source URL's
// host (a canonical link off the same domain) or appears somewhere in the
// source page's content (the LLM cleaned up a jobs-board link to the direct
// company page). Otherwise falls back to the actual Tavily source URL so a
// hallucinated same-name domain can't slip through. Empty LLM URL is a no-op.
function pickTrustedUrl(llmUrl: string, candUrl: string, candContent: string): string {
  const llm = String(llmUrl || "").trim();
  const cand = String(candUrl || "").trim();
  if (!llm) return cand || "";
  const llmHost = urlHost(llm);
  if (!llmHost) return cand || "";
  const candHost = urlHost(cand);
  // Same-domain: LLM stripped tracking params or picked a canonical URL — trust.
  if (candHost && llmHost === candHost) return llm;
  // Cross-domain: only trust when the LLM's host actually appears in the
  // source page's content (case-insensitive substring). Hallucinated hosts
  // don't survive this because the source page never mentions them.
  const contentLower = String(candContent || "").toLowerCase();
  if (contentLower && contentLower.includes(llmHost)) return llm;
  return cand || "";
}

// Normalize a person's name so "John Smith", "John J. Smith", "Dr. John Smith Jr",
// and "John Jacob Smith" all collapse to the same key. Strips honorifics,
// suffixes, and middle names/initials, then keeps first + last token.
function normName(s: string): string {
  // Drop everything after the first role separator so "Neal Eggers, VP of
  // Customer Success" and "Neal Eggers" both normalize to "nealeggers".
  // Without this, the "first + last token" heuristic below picks "success"
  // as the last token for the first form and dedup fails.
  const dropRoleSuffix = String(s || "")
    .split(/[,|·•—–]|\s+[-–—]\s+|\s+\bat\b\s+|\s+\bfor\b\s+/i)[0]
    .replace(/\([^)]*\)/g, " ");
  const cleaned = dropRoleSuffix
    .toLowerCase()
    // Drop leading role/title prefixes ("VP of Marketing at John Smith" style
    // never actually appears — extractor puts the name first — so this is
    // safe.)
    .replace(/\b(dr|mr|mrs|ms|prof|rev|hon|sir)\.?\s+/g, "")
    // Drop suffixes that come after the last name.
    .replace(/\b(jr|sr|ii|iii|iv|v|phd|md|esq|do|dds|rn|mba|cpa)\.?$/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const parts = cleaned.split(" ").filter(Boolean);
  if (parts.length <= 1) return parts[0] || "";
  return parts[0] + parts[parts.length - 1];
}

// A LinkedIn (or other social) URL/handle collapses to a stable identity key
// even when spellings of the name differ across articles. Two opps with the
// same LinkedIn slug are almost certainly the same person.
function normHandle(h: string): string {
  const s = String(h || "").toLowerCase().trim();
  if (!s) return "";
  const li = s.match(/linkedin\.com\/in\/([a-z0-9-]+)/);
  if (li) return "li:" + li[1];
  const tw = s.match(/(?:twitter\.com|x\.com)\/([a-z0-9_]+)/);
  if (tw) return "tw:" + tw[1];
  const ig = s.match(/instagram\.com\/([a-z0-9_.]+)/);
  if (ig) return "ig:" + ig[1];
  return s.replace(/^@+/, "").replace(/[^a-z0-9]/g, "");
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
  feedback?: DiscoverFeedback,
  personalOverride?: string
): Promise<Partial<Opportunity> & { isRelevant?: boolean } | null> {
  // Fit is judged differently depending on what the user is doing:
  // - Prospecting (sales/leads/partners/investors) OR a goal that says "any
  //   industry": the target lives in a DIFFERENT world than the user, so we
  //   must NOT filter by the user's own field. The GOAL defines the target.
  // - Everything else (networking/jobs/PR): the target IS in the user's field,
  //   so aligning to the user's industry/location is correct.
  const prospecting = isProspectingUseCase(useCase) || goalWantsAnyIndustry(goal);
  // The template's targetNoun (e.g. "outlet" for music PR) primes the extractor
  // toward that world. In prospecting mode the target is whatever the GOAL says,
  // so use a neutral noun instead of the user's-field noun.
  const noun = prospecting
    ? "target"
    : (resolveTemplate(useCase)?.targetNoun || GENERIC.targetNoun).replace(/s$/, "");
  // Within prospecting we never align to the USER'S field, but we still respect
  // a target profile the goal DOES name (e.g. "restaurants in Chicago"). Only
  // drop the industry / location filter entirely when the goal explicitly says
  // any-industry / anywhere.
  const anyIndustry = goalWantsAnyIndustry(goal);
  const anywhere = goalWantsAnywhere(goal);

  // Core quality gates — apply to every mode. These are about whether the
  // result is a REAL, REACHABLE target, not about fit.
  const core =
    `You are a research assistant. From a web search result, extract a structured record of ONE REAL, SPECIFIC ${noun || "target"} ` +
    `the user could actually reach out to, matching their GOAL and USE CASE. Return ONLY a JSON object, no prose, no markdown. ` +
    `Never invent contact details or facts — leave a field empty if it is not present in the result. ` +
    `URL DISCIPLINE: the url field MUST appear verbatim in the search result's content or URL. Never construct ` +
    `a URL by guessing what the company's domain probably is (e.g. do NOT write "concordgroupinsurance.com" ` +
    `just because the company is "Concord"; that risks pointing at a completely different company that happens ` +
    `to share a name). If no URL for this specific target appears in the source, leave url empty. ` +
    `THE RESULT MUST BE AN ACTUAL PROSPECT, not content about outreach. Set is_relevant to false (and target_type "other") ` +
    `for anything that is ADVICE or GENERAL CONTENT rather than a specific reachable person or organization: how-to guides, ` +
    `"tips"/"advice"/"best practices" articles, "top 10" listicles, template/example collections, ` +
    `blog posts about how to reach out, login/paywall pages, pay-to-play services, and the user themselves. ` +
    `A real person's LinkedIn profile, a staff/team page, or a specific company IS a valid prospect; ` +
    `an article teaching you how to do outreach is NOT. ` +
    `MENTIONED IS NOT ENOUGH: for target_type "person", if the source is about a PROGRAM, EVENT, ORGANIZATION, or EMPLOYER and ` +
    `only mentions a person by name in passing — no personal profile page, no interview, no direct contact channel — set ` +
    `is_relevant to false. For a "person" the source must EITHER be about them OR give a direct contact channel ` +
    `(email or LinkedIn URL / handle). ` +
    `PODCASTS / VIDEO CLIPS: an episode or video where the person is just a guest, with no contact channel, is not reachable; ` +
    `set is_relevant false. `;

  // Fit / alignment section — this is the part that differs by mode.
  const fitRules = prospecting
    ? `TARGET DEFINED BY THE GOAL, NOT THE USER'S FIELD: the user is prospecting — finding external ${noun || "target"}s to ` +
      `pitch, sell to, partner with, or raise from. Do NOT reject a result for being in a different industry than the user. ` +
      `The GOAL states the target profile (size, type, stage, location if any); judge fit against THAT, and ignore the user's ` +
      `own field entirely for filtering. WHAT'S BEING OFFERED comes from ABOUT's actual description of the product/service/ ` +
      `project (even one sentence naming it) — the USE CASE label is only a category for this search, never assume it IS ` +
      `the offering (e.g. a "Music PR" use case prospecting for a software tool's customers is selling that tool, not music ` +
      `services — do not bias fit or why_it_fits toward buyers of music-related things just because of the USE CASE label). ` +
      (anyIndustry
        ? `The user has said ANY INDUSTRY is fine, so industry is NOT a filter at all — a bakery, a law firm, and a game studio ` +
          `are all equally valid if they otherwise match the goal. `
        : `Match the target types the goal describes. `) +
      (anywhere
        ? `The user has said the target can be ANYWHERE, so do NOT penalize location. `
        : `LOCATION: only penalize fit_score if the GOAL specifies a location and this result is clearly elsewhere. `) +
      `REACHABILITY MATTERS MOST: since the user needs to actually contact these targets, favor results that expose a way in ` +
      `(a company contact page, an email, a phone number, a named person). A real company with a contact route is a strong ` +
      `fit even in an unrelated industry. REQUIRED CHANNELS: if the GOAL says it needs specific contact channels (e.g. "a phone ` +
      `number", "an email", "a website"), treat those as hard preferences — capture each one that appears (contact_phone, ` +
      `contact_email, url for the website) and give a clearly higher fit_score to results that expose ALL the requested ` +
      `channels, a lower one to results missing some. WHY_IT_FITS: a specific true detail about the TARGET's OWN business ` +
      `(size, recent growth, what they do, why they'd want this) that makes them a good prospect for what the user offers. ` +
      `FORBIDDEN: never phrase why_it_fits in terms of the SENDER's background, employer, career, or industry — do not ` +
      `write things like "a good fit given the sender's X experience" or reference the sender's field/employer at all; if ` +
      `the target's own details don't stand on their own, describe the target's business instead, or leave why_it_fits empty. ` +
      `fit_score: how well the target matches the GOAL's stated criteria; give 0.7+ to clear matches with a contact route, ` +
      `0.4-0.7 to plausible matches missing a contact detail, below 0.3 only when it clearly is not the kind of target the ` +
      `goal describes. Do NOT lower fit_score just because the industry differs from the user's.`
    : `${TUNABLE_INDUSTRY_ALIGNMENT_CLAUSE} ` +
      `WHY_IT_FITS DISCIPLINE: a specific true detail about THE PERSON'S OWN work, career, or interests tied to the user's ` +
      `field — not about their employer or program. If you can only describe the program they work at, set is_relevant false. ` +
      `${TUNABLE_LOCATION_ALIGNMENT_CLAUSE} ` +
      `TIME WINDOW ALIGNMENT: if the GOAL specifies a semester or year and the posting is clearly for a different window, set ` +
      `is_relevant false — but only when the source explicitly says the wrong window. ` +
      `Reserve fit_score above 0.7 for results matching goal + industry + location; give 0.3 or below when two or more are off.`;

  // Personal calibration wins over the universal baseline above by being the
  // last, most specific instruction — same mechanism coaching/dismissedAdvice
  // already use for drafting. Sourced fresh per request from THIS user's own
  // deny data (see buildPersonalOverride in lib/autotune.ts); never touches
  // shared code, unlike the universal auto-tune cron.
  const sys = core + fitRules + (personalOverride ? `\n\n${personalOverride}` : "");
  const fields =
    `Fields: is_relevant (bool), target_type (one of "person", "organization", "other" — use "other" for any article/guide/advice/listicle), ` +
    `name (the person/company/outlet, plus role if any), outlet (org/company/publication), ` +
    `channel (how to reach them: one of Email, LinkedIn, Website Form, Company Portal, Phone, Unknown), ` +
    `contact_email, contact_name (a named person if shown), contact_role, contact_handle (a LinkedIn URL or @handle), ` +
    `contact_phone (a phone number ONLY if it appears verbatim in the result — for local businesses / lead-gen this is often listed; leave empty otherwise, never invent one), ` +
    `url (best link), location, ` +
    `timezone (the IANA timezone for their location, e.g. "America/Chicago" for Nashville TN, "Europe/London" for London; empty if the location is unknown or remote/global), ` +
    `fit_score (0 to 1 — follow the fit-scoring rules above exactly; do not apply extra industry alignment beyond what those rules say), ` +
    `why_it_fits (one specific, true detail used to personalize outreach — follow the WHY_IT_FITS rule above exactly for what it should describe; empty if unknown).`;
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

// Multi-person extraction for INFLUENCER discovery. Roundup articles like
// "Top 10 beauty TikTokers to follow" name multiple creators; the single-
// person `extract` above only gets one, wasting 90% of the source. This
// variant reads the whole article and returns EVERY named creator with their
// handle when present. Each becomes its own opp, all sharing the same source
// URL/title so the multi-source dedup works cleanly if a creator appears
// across two roundups.
async function extractMultiplePeople(
  cand: TavilyResult,
  goal: string,
  about: string,
  useCase: string
): Promise<
  Array<{
    name: string;
    handle: string;
    email: string;
    role: string;
    outlet: string;
    location: string;
    why_it_fits: string;
    fit_score: number | null;
    channel: string;
  }>
> {
  const sys =
    `You are a research assistant reading a curated ROUNDUP article that lists multiple real social creators / ` +
    `influencers. Extract EVERY named creator from the article that fits the user's GOAL. Return ONLY a JSON ` +
    `object with a "people" array, no prose. Each element: {name (their real name or handle if that's all shown), ` +
    `handle (their @handle or full social URL — e.g. instagram.com/example, tiktok.com/@example, ` +
    `youtube.com/@example — prefer the platform the user's GOAL implies), email (only if the article lists a ` +
    `direct contact email; leave empty otherwise), role (what they do / niche: "beauty creator", "food TikToker", ` +
    `etc.), outlet (the platform they're mostly on or their brand), location (city or country if the article ` +
    `mentions it), why_it_fits (one specific true detail about THIS creator's own content or angle from the ` +
    `article, not the article's premise; empty if unknown), fit_score (0..1 how well this specific creator ` +
    `matches the goal), channel (one of "Instagram", "TikTok", "YouTube", "X", "Email", "Website Form", ` +
    `"Unknown" — pick the platform their handle points at)}. Never invent handles or emails; if the article ` +
    `only mentions a name in passing without any social handle or way to reach them, SKIP that person. Return ` +
    `an empty array if there are no genuinely reachable creators on the page.`;
  const user =
    `USER GOAL: ${goal}\nUSE CASE: ${useCase}\nABOUT THE USER: ${about}\n\n` +
    `SEARCH RESULT:\nTitle: ${cand.title || ""}\nURL: ${cand.url || ""}\nContent: ${String(cand.content || "").slice(0, 6000)}`;
  try {
    const parsed: any = parseJsonLoose(await claudeJson(sys, user));
    const arr: any[] = Array.isArray(parsed?.people) ? parsed.people : [];
    const out: Array<{
      name: string;
      handle: string;
      email: string;
      role: string;
      outlet: string;
      location: string;
      why_it_fits: string;
      fit_score: number | null;
      channel: string;
    }> = [];
    for (const p of arr) {
      const name = String(p?.name || "").trim();
      const handle = String(p?.handle || "").trim();
      // A creator needs at least a name AND some way to reach them (handle or
      // email). Skip pure name mentions.
      if (!name || (!handle && !String(p?.email || "").trim())) continue;
      const fitRaw = p?.fit_score;
      const fit =
        typeof fitRaw === "number"
          ? fitRaw
          : typeof fitRaw === "string"
            ? parseFloat(fitRaw)
            : null;
      out.push({
        name,
        handle,
        email: String(p?.email || "").trim(),
        role: String(p?.role || "").trim(),
        outlet: String(p?.outlet || "").trim(),
        location: String(p?.location || "").trim(),
        why_it_fits: String(p?.why_it_fits || "").trim(),
        fit_score: fit != null && !Number.isNaN(fit) ? fit : null,
        channel: String(p?.channel || "").trim() || "Unknown",
      });
    }
    return out;
  } catch (e) {
    if (e instanceof ApiCreditError) throw e;
    return [];
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
  cohortHint?: string,
  // This user's own calibration text (see buildPersonalOverride in
  // lib/autotune.ts) — takes priority over the universal baseline by being
  // appended last to both the query planner and the extractor's prompts.
  personalOverride?: string
): Promise<DiscoverResult> {
  const queries = await planQueries(goal, about, useCase, feedback, salt, cohortHint, personalOverride);
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

  // Creator/social searches lean entirely on roundup articles, so pull more
  // candidates per query and crawl each page deeper — advanced depth returns
  // richer content, which is exactly what the multi-person listicle extractor
  // reads to pull many creators out of one article. Everything else stays on
  // the cheaper basic depth.
  const creatorSearch = isSocialCreatorSearch(useCase, goal);
  const perQuery = creatorSearch ? 10 : 8;
  const depth: "basic" | "advanced" = creatorSearch ? "advanced" : "basic";

  // 1+2: gather + dedupe candidate pages. Wrapped so a broadening retry can
  // append a fresh batch of candidates from wider queries when the first pass
  // comes up empty.
  const candidates: TavilyResult[] = [];
  const seenLinks = new Set<string>();
  async function gather(passQueries: string[]) {
    for (const q of passQueries) {
      if (candidates.length >= maxItems * 4) break;
      const results = await tavilySearch(q, perQuery, { depth });
      for (const r of results) {
        if (looksLikeAdvice(r.title, useCase, goal)) {
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
  }
  await gather(queries);

  // 3: extract structured records, dedupe by name/host, cap at maxItems.
  const opps: Opportunity[] = [];
  const knownNames = new Set<string>();
  const knownHosts = new Set<string>();
  let skippedDupes = 0;
  let skippedNotFit = 0;

  // Creator roundup articles list MULTIPLE creators; those get a different
  // extractor that returns an array of people, all sharing the same source
  // URL. Everything else runs single-extract as before. Reuses the goal-aware
  // creatorSearch flag so a "find TikTok creators" goal counts even when the
  // use-case label doesn't say so.
  const isListicle = (c: TavilyResult) => creatorSearch && looksLikeListicle(c.title);

  // Extract in small parallel batches so the spike is reasonably fast. Wrapped
  // as a function taking a start index so a broadening retry can process only
  // the freshly-gathered candidates instead of re-extracting the first pass.
  const batchSize = 4;
  async function extractFrom(start: number) {
  for (let i = start; i < candidates.length && opps.length < maxItems; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);
    const rawResults = await Promise.all(
      batch.map(async (c) => {
        if (isListicle(c)) {
          const people = await extractMultiplePeople(c, goal, about, useCase);
          return { multi: true as const, people, cand: c };
        }
        const rec = await extract(c, goal, about, useCase, feedback, personalOverride);
        return { multi: false as const, rec, cand: c };
      })
    );
    // Flatten multi-person listicles into individual {rec, cand} pairs so the
    // existing per-record processing logic below handles them the same way as
    // single-person extracts. Every person from the same listicle keeps the
    // listicle's URL/title as their source.
    const flat: Array<{
      rec: (Partial<Opportunity> & { isRelevant?: boolean }) | null;
      cand: TavilyResult;
    }> = [];
    for (const r of rawResults) {
      if (!r.multi) {
        flat.push({ rec: r.rec, cand: r.cand });
        continue;
      }
      if (!r.people.length) {
        // The listicle extractor said "no reachable creators here" — log it as
        // a skip so it's visible in the filter panel, don't retry with the
        // single-person extractor.
        logSkip(r.cand.title, r.cand.url, "listicle produced no reachable creators");
        continue;
      }
      for (const p of r.people) {
        // Downstream reads raw snake_case fields off the extracted record;
        // mirror that shape so the multi-person path drops in cleanly.
        flat.push({
          rec: {
            isRelevant: true,
          } as any,
          cand: r.cand,
        });
        Object.assign(flat[flat.length - 1].rec as any, {
          name: p.name,
          outlet: p.outlet,
          channel: p.channel,
          contact_email: p.email,
          contact_name: p.name,
          contact_role: p.role,
          contact_handle: p.handle,
          location: p.location,
          fit_score: p.fit_score,
          why_it_fits: p.why_it_fits,
          target_type: "person",
        });
      }
    }
    for (let j = 0; j < flat.length; j++) {
      if (opps.length >= maxItems) break;
      const rec = flat[j].rec as any;
      const cand = flat[j].cand;
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
      const handleKey = normHandle(r.contact_handle || "");
      const host = urlHost(r.url || cand.url);
      if (nm && deniedNames.has(nm)) {
        skippedDupes++;
        logSkip(cand.title, cand.url, `you denied "${r.name}" before`);
        continue; // already rejected this exact one before
      }
      // Same-person detection across articles: match either the normalized
      // name or the same LinkedIn/Twitter/Instagram handle. When we hit one,
      // don't drop the article — attach it as another source on the existing
      // opp so the user can see every place we found this person.
      const dupIdx = opps.findIndex((o) => {
        if (nm && normName(o.name) === nm) return true;
        const ok = normHandle(o.contactHandle);
        if (handleKey && ok && ok === handleKey) return true;
        return false;
      });
      if (dupIdx >= 0) {
        const existing = opps[dupIdx];
        const newRef = {
          title: cand.title || "",
          url: cand.url || "",
          snippet: String(cand.content || "").slice(0, 220),
        };
        if (!existing.sources) {
          existing.sources = [
            { title: existing.sourceTitle, url: existing.url, snippet: existing.sourceSnippet },
          ];
        }
        // Avoid re-adding an identical article URL, but merge in any missing
        // contact detail the second article surfaces.
        if (newRef.url && !existing.sources.find((s) => s.url === newRef.url)) {
          existing.sources.push(newRef);
        }
        if (!existing.contactEmail && r.contact_email) existing.contactEmail = r.contact_email;
        if (!existing.contactHandle && r.contact_handle) existing.contactHandle = r.contact_handle;
        if (!existing.contactRole && r.contact_role) existing.contactRole = r.contact_role;
        if (!existing.contactPhone && r.contact_phone) existing.contactPhone = r.contact_phone;
        if (!existing.location && r.location) existing.location = r.location;
        logSkip(
          cand.title,
          cand.url,
          `merged into "${existing.name}" (now ${existing.sources.length} sources)`
        );
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

      // Trust the LLM's URL only when we can verify it isn't hallucinated:
      // its host must appear in the source page's content, OR it must sit on
      // the same domain as the Tavily source URL. Otherwise fall back to the
      // real cand.url. Fixes the "Concord Music Publishing → concordgroup
      // insurance.com" style cross-company confusion where the extractor
      // invents a plausible domain from the company name.
      const chosenUrl = pickTrustedUrl(String(r.url || ""), cand.url || "", cand.content || "");
      opps.push({
        id: `${Date.now()}-${opps.length}`,
        name: String(r.name).trim(),
        outlet: r.outlet || "",
        url: chosenUrl,
        channel: r.channel || "Unknown",
        contactEmail: r.contact_email || "",
        contactName: r.contact_name || "",
        contactRole: r.contact_role || "",
        contactHandle: r.contact_handle || "",
        contactPhone: r.contact_phone || "",
        location: r.location || "",
        timezone: r.timezone || "",
        fitScore: fit,
        whyItFits: r.why_it_fits || "",
        sourceTitle: cand.title || "",
        sourceSnippet: String(cand.content || "").slice(0, 220),
        sources: [
          {
            title: cand.title || "",
            url: cand.url || "",
            snippet: String(cand.content || "").slice(0, 220),
          },
        ],
      });
    }
  }
  }

  await extractFrom(0);

  // Nothing survived the specific pass? Widen the net once and try again, so a
  // very specific "who is this for" degrades to *some* real results instead of an
  // empty screen. Reuses the same candidate/opp/dedup state and only extracts the
  // freshly-gathered pages. Skipped for creator searches (which depend on
  // roundup listicles, a different strategy) and when there were no queries.
  let broadenedQueries = 0;
  if (opps.length === 0 && queries.length && !creatorSearch) {
    const alreadyProcessed = candidates.length;
    const broadened = await planQueries(
      goal,
      about,
      useCase,
      feedback,
      salt,
      cohortHint,
      personalOverride,
      true
    );
    broadenedQueries = broadened.length;
    await gather(broadened);
    await extractFrom(alreadyProcessed);
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
    searched: queries.length + broadenedQueries + enrichSearches,
    candidates: candidates.length,
    skippedDupes,
    skippedNotFit,
    skippedCapped,
    skipped,
  };
}
