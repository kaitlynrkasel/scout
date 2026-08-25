// Discovery engine: build queries -> Tavily -> Claude extract -> dedupe.
// This is the heart of both your scripts (07_Discovery.gs), condensed for the
// spike. Same shape: queries from goal+template, web search, structured
// extraction, a known-index dedupe so the same target never repeats.

import { claudeJson, parseJsonLoose, noDash } from "./claude";
import { tavilySearch, type TavilyResult } from "./tavily";
import { resolveTemplate, GENERIC, isProspectingUseCase } from "./templates";
import { ApiCreditError } from "./apiErrors";
import { targetKey, cappedKeys } from "./exposure";
import { pdlEnabled, goalToPdlFilters, pdlRosterCached, pdlPeopleAsCandidates, type PdlFilters } from "./pdl";
import type { Opportunity } from "./types";
import { todayLine } from "./today";

// ---- Auto-tunable fit-scoring clauses ----
// Isolated as single-string constants (not woven into the surrounding
// template-literal concatenation) so /api/cron/auto-tune can safely locate,
// replace, and re-commit just ONE of these based on real deny-reason data,
// without touching the rest of extract()'s logic. Each must stay a single
// backtick-delimited string ending in a semicolon on its own, that's what
// makes the auto-editor's regex extraction reliable. See lib/autotune.ts.
export const TUNABLE_INDUSTRY_ALIGNMENT_CLAUSE =
  `INDUSTRY ALIGNMENT: judge against the user's field (from ABOUT THE USER + USE CASE); if clearly outside their industry (e.g. sports for a music search, medicine for a marketing search), set is_relevant false and fit_score below 0.3. Never surface cross-industry hits unless the goal explicitly asks for that other industry.`;

export const TUNABLE_LOCATION_ALIGNMENT_CLAUSE =
  `LOCATION ALIGNMENT: when the user's ABOUT includes a location and the GOAL does not override it, results clearly based in a different region should score low (0.2 or below) unless the result is explicitly remote, distributed, or global, or the goal is satisfied at a distance. Same metro area counts as a match; nearby cities in the same metro count as a match; an unstated location is uncertainty, score on the other signals and say the location is unconfirmed in why_it_fits rather than flooring the score. If the GOAL says any location, anywhere, remote, nationwide, or names its own target places, this rule is OFF and location must not lower the score. Empty user location = no penalty.`;

// Stable (NOT auto-tuned — deliberately no "TUNABLE_" prefix, so the auto-editor
// leaves it alone) rule for TRANSIENT / EVENT-PRESENCE goals. It overrides the
// residence-based location ceiling above whenever the goal is about someone being
// physically PRESENT at a place for a window, not living there. Placed after the
// location clause in the prompt so it wins for these goals.
// Two rules born from real misses. (1) The UBC mentor program looked perfect
// until the page said mentors must be UBC-affiliated; the user is not.
// Eligibility requirements the user cannot meet are disqualifying, not a
// footnote. (2) When the user states criteria ("remote or in person", "has to
// be paid"), each find should ANSWER them, so the UI can show remote/in-person
// etc. as fields instead of burying it in prose.
export const ELIGIBILITY_AND_CRITERIA_CLAUSE =
  `ELIGIBILITY GATE: if the source states requirements for participating (must be a student or alumnus of a SPECIFIC school, members only, licensed professionals only, residents of a place, an affiliation) that ABOUT THE USER clearly does not satisfy, set is_relevant false, whatever else fits; an opportunity the user cannot be accepted into is not an opportunity. When eligibility is stated and the user MEETS it, say so in why_it_fits. CRITERIA ANSWERS: also return "criteria": an array of up to 5 {"ask","answer"} pairs, one for each explicit requirement or preference in the GOAL (remote or in person, paid, timeframe, size, location), where ask is the user's criterion in 2-4 words and answer is what THIS source says about it in 2-6 words ("Remote?" -> "In person, Vancouver"; "Paid?" -> "Unpaid" or "Not stated"). Answer from the source only, "Not stated" when it is silent, never guess. When the source states WHEN applications open, close, or recur, always include that as one of the pairs ("Applications?" -> "Open each January"). FACEBOOK-ONLY POSTINGS: when the page you are reading is a facebook.com (or other login-walled social) post or profile, do NOT make that the find's website: put the ORGANIZATION'S own website in url whenever the source names or links one, keep the social link in sources/contact_handle, and add a criteria pair ("Posting?" -> "On Facebook") so the user knows where the posting itself lives.`;

export const TRANSIENT_PRESENCE_CLAUSE =
  ` TRANSIENT / EVENT PRESENCE OVERRIDE: this applies ONLY when the GOAL is about a person being physically present at a place for an event, appearance, tour stop, festival, conference, residency, or visit during a time window (e.g. "artists who will be in Nashville in March", "founders coming to Austin for SXSW", "a speaker in town the week of the 12th"). For such goals, location compatibility is about WHERE THE PERSON WILL BE during that window, NOT where they are based or headquartered — and the residence-based LOCATION ALIGNMENT ceiling above does NOT apply. A person based anywhere who has a confirmed appearance, booked show, tour date, festival slot, or scheduled visit at the goal's location within the window is a STRONG location match: do not penalize them for living elsewhere. Conversely, a local resident who is clearly touring/away during the window is a WEAKER match. Capture the specific appearance/tour date in why_it_fits when the source states it, and raise fit_score when that date falls inside the requested window; lower it (or set is_relevant false) only when the source explicitly shows the person will NOT be there in the window. A candidate is LOCATION-ELIGIBLE for such a goal if EITHER of these is true, and you must accept both paths (do not require a printed future date for everyone): (A) the source shows a confirmed appearance, booked show, tour date, festival slot, residency, or scheduled visit at the goal's location within the window — this is the STRONGEST match, rank it highest and capture the date in why_it_fits; OR (B) the person is openly BASED IN / headquartered in / local to the goal's location (their bio, profile, or the source says they live or are based there) — a local is present by default, so being based there IS sufficient proof they can be in town, treat it as a STRONG match even with no specific date. Reject (set is_relevant false) only when the person is NEITHER confirmed-present in the window NOR based at the location — e.g. an out-of-town person with no booked appearance there — because someone who won't be in town cannot be used. Do NOT reject a locally-based person merely for lacking a printed date; their home base is the proof. Rank confirmed-in-window above merely-local. This eligibility rule SUPERSEDES any required/hard_constraint that would demand a specific printed date and reject locals along with everyone else. If the goal is NOT about transient presence, ignore this override entirely.`;

// Tunable rank weights (Phase 1 of the opportunity-intelligence architecture).
// The headline fit shown to users is now COMPUTED: a weighted blend of the
// extractor's per-component reads (relevance/timing/momentum) and the
// mechanically-computed reachability — instead of one opaque model number.
// Backtick-string format so lib/autotune.ts's slot machinery can adjust these
// NUMBERS from real deny data instead of escalating prose clauses. Values are
// re-normalized at parse time, and any malformed edit falls back to defaults,
// so a bad auto-edit can never break ranking. Must stay valid JSON.
export const TUNABLE_RANK_WEIGHTS = `{"relevance":0.45,"reachability":0.20,"timing":0.20,"momentum":0.15}`;

const DEFAULT_RANK_WEIGHTS = { relevance: 0.45, reachability: 0.2, timing: 0.2, momentum: 0.15 };
function rankWeights(): typeof DEFAULT_RANK_WEIGHTS {
  try {
    const w = JSON.parse(TUNABLE_RANK_WEIGHTS);
    const keys = ["relevance", "reachability", "timing", "momentum"] as const;
    const vals = keys.map((k) => Number(w[k]));
    if (vals.some((v) => !Number.isFinite(v) || v < 0)) return DEFAULT_RANK_WEIGHTS;
    const sum = vals.reduce((a, b) => a + b, 0);
    if (sum <= 0) return DEFAULT_RANK_WEIGHTS;
    return {
      relevance: vals[0] / sum,
      reachability: vals[1] / sum,
      timing: vals[2] / sum,
      momentum: vals[3] / sum,
    };
  } catch {
    return DEFAULT_RANK_WEIGHTS;
  }
}

// What the user has taught Scout by denying / keeping past finds. Fed into query
// planning and extraction so the search learns their taste over time.
// Deny reasons that are ONLY about timing (nothing open right now, deadline
// passed) rather than fit. These targets stay watchable: re-check them, and
// the moment they have a live opening they're a top recommendation again.
export function isTimingDenyReason(r: string): boolean {
  return /\b(no open|not (currently |actively )?hiring|nothing (open|posted|available)|no (positions?|openings?|roles?|listings?|jobs?)|positions? (are )?(closed|filled)|applications? closed|deadline (passed|closed)|expired|closed for|not accepting|too (early|late)|wrong (semester|year|season|window)|next (year|semester|cycle|fall|spring|summer|winter)|check back|reopens?)\b/i.test(
    String(r || "")
  );
}

export interface DiscoverFeedback {
  avoid?: { name: string; reason: string }[]; // denied finds + why
  // Set per-run by discover(): roughly one run in three is a "check-in" run
  // where timing-denied orgs may resurface even without a confirmed opening,
  // so they get sprinkled back in occasionally instead of vanishing.
  reopenCheckIn?: boolean;
  favor?: { name: string; why: string }[]; // kept / drafted finds + why they fit
  // Phase 4 — outcome learning. Compact, plain-English facts about what actually
  // produced results for THIS user (replies vs silence vs denies), computed from
  // their real pipeline. e.g. "Replies so far came from candidates with a personal
  // email (avg reachability 0.9) and recent-launch signals; DM-only finds got no
  // replies." Fed to query planning + fit scoring so ranking chases outcomes,
  // not just approvals.
  outcomes?: string[];
}

// Compact "learned from your feedback" block for the Claude prompts.
function feedbackBlock(feedback?: DiscoverFeedback, goal = ""): string {
  const avoidAll = (feedback?.avoid || []).filter((a) => a && (a.name || a.reason));
  const reopen = avoidAll.filter((a) => isTimingDenyReason(a.reason)).slice(0, 8);
  const avoid = avoidAll.filter((a) => !isTimingDenyReason(a.reason)).slice(0, 12);
  const favor = (feedback?.favor || []).filter((f) => f && f.name).slice(0, 10);
  const outcomes = (feedback?.outcomes || [])
    .map((s) => String(s || "").trim())
    .filter(Boolean)
    .slice(0, 6);
  let s = "";
  // The user's EXPLICIT instruction outranks learned history. If they asked for
  // a variety of industries this run, say so up front, so the model doesn't let
  // "kept/replied before" patterns quietly collapse the results back to the one
  // or two industries they've engaged with most.
  const wantsVariety = goalWantsAnyIndustry(goal);
  if (wantsVariety && (outcomes.length || favor.length)) {
    s +=
      "\n\nINSTRUCTION OVERRIDE: this search explicitly asks for a VARIETY of industries. The learned " +
      "preferences below are secondary — use them ONLY to judge quality/reachability WITHIN each industry, " +
      "never to narrow WHICH industries appear. Keep the results spread across many distinct industries even " +
      "if the user has kept or replied to some industries more than others. The explicit ask wins. " +
      "ROTATE, TOO: read the learned lists below for industries ALREADY well represented from past runs (a wall of " +
      "music-industry keeps means music is covered) and point most of THIS run at industries not yet represented, " +
      "so coverage widens run over run instead of finding the same field again.";
  }
  if (outcomes.length) {
    s +=
      "\n\nPROVEN OUTCOMES for this user (from real replies, not just approvals). Weight these HEAVIEST when scoring " +
      "fit: favor candidates matching the patterns that got replies, deprioritize the patterns that went nowhere:\n" +
      outcomes.map((o) => `- ${o}`).join("\n");
  }
  if (favor.length) {
    s +=
      "\n\nWORKED BEFORE, the user KEPT and reached out to these, so favor results like them:\n" +
      favor.map((f) => `- ${f.name}${f.why ? ` (${f.why})` : ""}`).join("\n");
  }
  if (avoid.length) {
    s +=
      "\n\nREJECTED BEFORE, the user passed on these; treat the reasons as firm rules and steer away from similar results. " +
      "WHOSE RULE IS IT: on a shared pipeline some of these decisions were made by TEAMMATES whose circumstances differ. " +
      "Before applying a reason, check it against ABOUT THE USER: a reason grounded in the DECIDER'S own eligibility or " +
      "stage of life (\"it isn't for high schoolers\" from a high schooler, \"requires a degree I don't have\") binds only " +
      "when it is also true of THIS user; a reason about the target itself (industry, genre, location, quality, ethics) " +
      "binds everyone. " +
      "When a reason names a subject, genre, or industry the user does not want (\"I don't want to work in country music\"), " +
      "that is a HARD filter: any result squarely in that world is is_relevant false, not merely a low fit_score:\n" +
      avoid.map((a) => `- ${a.name}${a.reason ? `: ${a.reason}` : ""}`).join("\n");
  }
  if (reopen.length) {
    s +=
      "\n\nPASSED ONLY FOR TIMING, not fit. The user liked these but nothing was open at the time; they are on a " +
      "reopen watch, NOT a blocklist:\n" +
      reopen.map((a) => `- ${a.name}${a.reason ? `: ${a.reason}` : ""}`).join("\n") +
      "\nIf a source shows a LIVE opening at one of them now, that is a TOP result: high fit_score, and say in " +
      "why_it_fits that positions have opened since the user last checked. " +
      (feedback?.reopenCheckIn
        ? "This run is a periodic check-in: even without a confirmed opening, one of these may return as a modest-fit " +
          "reminder, with why_it_fits noting it is a re-check of a place the user liked."
        : "Without a live opening, leave them out this run.");
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
// from. The target lives in a DIFFERENT world than the user, a marketing
// agency pitching restaurants, a SaaS founder selling to any industry, a
// nonprofit chasing sponsors. For these, the user's own industry must NOT
// filter results; the GOAL defines the target profile. Contrast with
// networking/jobs, where the target IS in the user's field and industry
// alignment against the user is exactly right.

// The user has explicitly widened the target to any industry / anywhere. When
// the goal says this, we drop industry + location filtering no matter the use
// case, because the user is telling us the net is intentionally wide.
export function goalWantsAnyIndustry(goal: string): boolean {
  // Two intents both mean "don't anchor to my field": (1) ANY industry is fine,
  // and (2) I want a VARIETY across many industries. The second phrasing
  // ("a variety of industries", "different industries", "multiple sectors") was
  // silently missing before, so those searches ran anchored to the user's own
  // field and collapsed to one industry — the exact bug the user hit.
  const g = goal || "";
  const noun = "(industr(?:y|ies)|sectors?|fields?|verticals?|niches?|businesses)";
  return (
    // "any industry is fine" family
    new RegExp(
      `\\b(any (other |type of |kind of |given )*${noun}|all (industries|sectors|fields|businesses)|every (industry|sector|business)|across ${noun}|(cross|multi)[- ]?industr(y|ies)|industry.?agnostic|no (specific )?industry|regardless of (the )?industry|(not|isn'?t) industry.?specific|open to (any|all) industr(y|ies)|doesn'?t matter (the |what )?industry)\\b`,
      "i"
    ).test(g) ||
    // "a variety / range / mix / spread of industries" family
    new RegExp(
      `\\b(a |an )?(wide |broad |diverse )?(variety|range|mix|mixture|assortment|spread|diversity|bunch|number|selection) of (different |various |diverse )?${noun}`,
      "i"
    ).test(g) ||
    // "different / multiple / various / several / diverse … industries" family
    new RegExp(
      `\\b(different|differing|multiple|various|several|diverse|many|numerous|assorted|mixed|varied|a bunch of|lots of|all kinds of|all sorts of|all types of) (kinds of |sorts of |types of )?${noun}`,
      "i"
    ).test(g) ||
    // "across / spanning / from many industries"
    new RegExp(
      `\\b(across|spanning|from|in|over|throughout) (a )?(wide |broad |many |several |multiple |various |different |diverse |all )+(range of )?${noun}`,
      "i"
    ).test(g)
  );
}
function goalWantsAnywhere(goal: string): boolean {
  return /\b(anywhere|any (location|city|region|country|state|area)|nationwide|worldwide|global(ly)?|remote|no (specific )?location|regardless of location|located anywhere)\b/i.test(
    goal || ""
  );
}

// Influencer / creator discovery: brand looking for social creators, PR looking
// for TikTokers to send product to, etc. These use cases live mostly outside
// Scout's crawlable web, IG/TikTok/X are login-walled, so we lean on
// roundup articles, blog listicles, and aggregator sites that name creators
// and link out to their socials.
function isInfluencerUseCase(useCase: string): boolean {
  return /\b(influenc|creator|content creator|tiktok(er)?|instagram(m?er)?|youtub(er|e creator)|streamer|micro-?influenc|nano-?influenc|ugc)/i.test(
    useCase
  );
}

// Same intent, read from the GOAL text rather than the use-case label. Without
// this, "find TikTok creators posting folk covers" typed under a "Music PR"
// use case never triggered the creator pipeline, the single most common way
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

// Pages structured as ranked / listed roundups, the primary source for
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

// Obvious how-to / advice pages, never actual prospects. For influencer use
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
// the person reachable, being a guest on a show isn't a contact channel.
// Filtered before extraction so we don't waste Claude calls on obvious dead
// ends. Own-account URLs on these hosts (a channel page, a profile) can still
// be legit, so we only skip individual-episode / individual-video URLs.
function looksLikePodcastOrVideoClip(url: string): boolean {
  const u = String(url || "").toLowerCase();
  if (!u) return false;
  // Podcast hosts, episode pages are the whole point of these hosts.
  if (/(^|\.)(buzzsprout|anchor\.fm|podbean|libsyn|transistor\.fm|captivate\.fm|simplecast|blubrry)\.com/.test(u))
    return true;
  if (/podcasts\.apple\.com\/[a-z-]+\/podcast\/.+\/id\d+\?i=\d+/.test(u)) return true; // apple episode url
  if (/open\.spotify\.com\/episode\//.test(u)) return true;
  if (/soundcloud\.com\/[^/]+\/[^/]+/.test(u)) return true; // individual soundcloud track, not a profile
  if (/(youtube\.com\/watch\?|youtu\.be\/)/.test(u)) return true; // individual youtube video
  if (/vimeo\.com\/\d+(?:\b|$)/.test(u)) return true; // individual vimeo video (numeric id)
  return false;
}

// ---- Goal Decomposition Engine (the Discovery Planner) ----
// BEFORE any query is written, Scout reasons about the goal like an elite
// recruiter + investigative journalist: what outcome the user really wants, who
// achieves it, what MUST be true, what evidence would PROVE a match (never
// search for people directly, search for evidence), when NOW is a good time to
// reach out, and which angles to attack from. This structured plan becomes the
// blueprint every downstream search and the fit-scorer read from.
export interface RankingFactor {
  factor: string;
  weight: number;
}
// A pre-search sharpening question surfaced in the confidence gate. options are
// 2–5 concrete answers the user can pick with one tap; the UI always adds its
// own "Other" write-in, so options should NOT include a generic other/none.
export interface ConfidenceQuestion {
  question: string;
  options: string[];
}
export interface GoalPlan {
  goal: string;
  target_type: string;
  understanding: number; // 0-100: how completely Scout understands what to search for
  required: string[];
  preferred: string[];
  hard_constraints: string[];
  soft_constraints: string[];
  negative_constraints: string[];
  evidence_needed: string[];
  opportunity_signals: string[];
  search_dimensions: string[];
  ranking_factors: RankingFactor[];
  confidence_questions: ConfidenceQuestion[];
}

const DECOMPOSE_SYS =
  "You are Scout's Discovery Planner. Do NOT generate search queries. Deeply understand the user's real objective: " +
  "what outcome they're trying to achieve, what kind of person or organization accomplishes that, what hidden " +
  "constraints are implied, what would make someone likely to say yes, and what would make someone impossible to " +
  "use. Infer intent, never rely only on the literal wording. Then decompose the goal into this EXACT JSON schema " +
  "(populate every field): {\"goal\":\"\",\"target_type\":\"\",\"required\":[],\"preferred\":[],\"hard_constraints\":[]," +
  "\"understanding\":0,\"soft_constraints\":[],\"negative_constraints\":[],\"evidence_needed\":[],\"opportunity_signals\":[]," +
  "\"search_dimensions\":[],\"ranking_factors\":[{\"factor\":\"\",\"weight\":0}]," +
  "\"confidence_questions\":[{\"question\":\"\",\"options\":[]}]}\n" +
  "understanding = an integer 0-100 for how well you grasp the OBJECTIVE and who to look for, given the goal PLUS the " +
  "ABOUT / project context provided. Judge comprehension, NOT narrowness: a clear objective backed by real context is " +
  "AT LEAST 55-70 even when targeting specifics (company size, location, seniority, niche) are still open — those are " +
  "refinements that would sharpen results, not gaps in understanding — and an intentionally broad scope ('any industry', " +
  "'all companies') is a deliberate choice, never a missing constraint. Go 85+ when the goal is specific and self-contained. " +
  "ONE EXCEPTION: when the goal is role-shaped (a hire, a role, a position, someone open to new work) and NOTHING in the " +
  "goal or the ABOUT context settles WORK ARRANGEMENT — remote, hybrid, or on-site — cap understanding at 85 and make " +
  "that your FIRST confidence_question. Where the work happens decides who qualifies, so not knowing it is a real gap in " +
  "who to look for, not a refinement. " +
  "Only go below 30 when the goal is genuinely vague AND almost no context is provided. NEVER return 0 when a real " +
  "objective and any context are present; it does not start from zero. " +
  "Definitions: goal = the actual objective (e.g. 'find a guest speaker', not 'search Nashville artists'). " +
  "target_type = the entity type (Person, Company, Artist, Founder, Journalist, Investor, Professor, Creator, " +
  "Podcast Host, etc.). required = things that MUST be true; if one is false, reject the candidate. preferred = " +
  "strong positives, not required. hard_constraints = concrete requirements (available in April, within 25 miles, " +
  "in healthcare, under 500 employees). IMPORTANT — TRANSIENT / EVENT PRESENCE: if the objective is about someone " +
  "being physically present at a place during a time window (touring through a city, in town for an event, appearing " +
  "at a conference/festival that month), the person genuinely must be able to be in town — but that is satisfied TWO " +
  "ways, so do NOT write a hard_constraint demanding a specific printed future date. Instead set evidence_needed to " +
  "cover BOTH paths: (1) dated proof of an appearance/show/tour stop at the location in the window (venue calendars, " +
  "tour schedules, festival/conference lineups for that month), AND (2) people openly BASED IN / local to that " +
  "location (they are present by default). A locally-based candidate qualifies even with no specific date. The " +
  "window decides RANK (confirmed date ranks above merely-local), and only someone who is neither confirmed-present " +
  "nor local should be excluded. soft_constraints = nice-to-haves (independent, emerging, growing fast). " +
  "negative_constraints = who to EXCLUDE (major celebrities, retired, no public contact, inactive, already " +
  "contacted, out of budget). evidence_needed = THE MOST IMPORTANT field: never search for people directly, search " +
  "for EVIDENCE that would PROVE someone matches (tour schedules, festival lineups, conference speaker lists, " +
  "management/team pages, funding announcements, book launches, award winners, recent interviews, hiring posts, " +
  "press releases, association directories, professional memberships, LinkedIn profiles, official sites, recent " +
  "news). Generate MULTIPLE evidence sources. opportunity_signals = signals that NOW is a good time to reach out " +
  "(new album, launching a company, recently funded, hiring, speaking at a conference, traveling nearby, podcast " +
  "appearance, book release, award, media tour, new executive role, recent acquisition) — these dramatically raise " +
  "reply probability. search_dimensions = different ways to attack the search (by geography, profession, event, " +
  "employer, recent news, organization, conference, award, social presence, publication, community, alumni, " +
  "association) — never rely on one. ranking_factors = weighted scoring like [{factor,weight}] where weights total " +
  "1.0. " +
  "HOME BASE: when ABOUT THE USER states where the person or company is BASED (as opposed to the goal demanding a " +
  "location), treat it as a REGIONAL PREFERENCE, never a hard_constraint or a negative_constraint. Put the wider " +
  "region in preferred and give proximity real weight in ranking_factors, so nearby opportunities rank first while " +
  "strong matches elsewhere still surface. Widen the stated base to its own metro area and the neighbouring cities " +
  "within normal commuting or relocating distance OF THAT BASE, derived from the location the user actually gave. " +
  "When NO base appears in the goal or the ABOUT context, apply NO geographic preference whatsoever: do not invent a " +
  "city, region, or country, do not fall back to anywhere named in these instructions, and leave location out of " +
  "required, preferred, hard_constraints and ranking_factors entirely. The goal still overrides all of this: if it " +
  "says remote/anywhere, drop the geographic weighting, and if it names its own location or demands on-site " +
  "presence, that wins. " +
  "confidence_questions = ONLY genuinely missing information that would change WHO Scout looks for. This is the " +
  "MOST IMPORTANT rule: before writing ANY question, re-read the GOAL, ABOUT THE USER, the context, and any answers " +
  "already given — if they STATE or reasonably IMPLY the answer, DO NOT ASK IT. Never ask the user something they " +
  "just told you. Concrete bans: do NOT ask which industry when the goal names one or says 'any/all/various " +
  "industries'; do NOT ask company size/stage when the goal already says small/startup/SMB/enterprise/early/growth; " +
  "do NOT ask location or 'local only' when the goal or the user's profile gives a city/region or says " +
  "remote/anywhere/any location; do NOT ask the user's own field, role, seniority, or what they do when ABOUT THE " +
  "USER states it; do NOT ask what they're offering or their use case when the goal already makes it clear. It is " +
  "BETTER to return an EMPTY array than to ask one thing that is already answered — a well-specified inquiry needs " +
  "zero questions, and understanding should be HIGH in that case. CONTRADICTIONS: if the GOAL contains an apparent " +
  "internal contradiction (e.g. 'remote-only roles at an office I can go into daily', 'small startups with 10,000 " +
  "employees'), resolve it with the most plausible interpretation in the plan — but make your FIRST " +
  "confidence_question confirm that interpretation, with the plausible readings as its options; never silently pick " +
  "one and ask about unrelated dimensions instead. " +
  "WORTH ASKING — the practical dimensions users most often leave out, and that genuinely change WHO qualifies: " +
  "WORK ARRANGEMENT (remote / hybrid / on-site) whenever the target is a role, a hire, or someone taking a " +
  "position; employment type (full-time, part-time, contract, freelance); experience level or seniority; " +
  "availability or start timing; required credentials, licenses, or tools; organization size or stage; how far " +
  "the person may be from a place when the work is place-bound; and audience or reach tier when the target is a " +
  "creator, outlet, or venue. Before you finish, check this list against what the goal and profile already say. " +
  "Work arrangement especially is almost never stated and almost always decides who qualifies for anything " +
  "role-shaped — ask it unless the goal or profile already settles it. These beat a vaguer question about the " +
  "same search, but they do NOT override the bans above: if the goal or profile already answers one, skip it. " +
  "Ask AT MOST 3, each a DISTINCT, decision-changing " +
  "dimension that is truly unstated. Each is an OBJECT {question, options}: question is a short, plain " +
  "question; options is 2–5 concrete, mutually-exclusive answers the user can pick with one tap (real values like " +
  "'Within 25 miles','This city only','Anywhere remote' — never 'yes/no' unless the question is truly binary). " +
  "Infer likely options from the goal and the user's field; keep each option under ~4 words. Do NOT add an " +
  "'Other'/'Not sure' option — the UI supplies its own write-in. Never ask two questions about the same attribute " +
  "(e.g. don't ask both 'what company size' and 'what employee count'). " +
  "PRIVATE INDIVIDUALS: when the goal targets private individuals in a personal-life moment (brides/engaged couples, " +
  "new parents, patients, grieving families, homebuyers), do NOT plan to mine social groups, forums, or personal posts " +
  "for those individuals — that is invasive and produces unreachable, unwelcome outreach. Reframe the plan toward the " +
  "PROFESSIONAL INTERMEDIARIES and public-facing channels that reach them (e.g. for brides: wedding planners, venues, " +
  "photographers for referral partnerships, bridal expos, preferred-vendor lists), state that reframe in the goal field, " +
  "and make the first confidence_question confirm it. Public-facing professionals and creators are always fine to target. " +
  "PROVING A NEGATIVE: a requirement that something has NEVER happened (e.g. 'podcasts that never had a musician on') " +
  "cannot be verified from search results. Restate it as a soft signal — 'no evidence of X in what is visible' — " +
  "targeting adjacent categories where X is naturally rare, and never plan evidence that requires exhaustively " +
  "auditing someone's full history. " +
  "Think in evidence and investigations, not keywords or Google " +
  "searches. Always infer hidden constraints, opportunities, timing, reachability, and likelihood of response. " +
  "Keep each array CONCISE: at most 10 items, each a short phrase (not a paragraph). Return ONLY the JSON object, " +
  "nothing before or after it.";

export async function decomposeGoal(
  goal: string,
  about: string,
  useCase: string,
  personalOverride?: string,
  askedQuestions: string[] = []
): Promise<GoalPlan | null> {
  const g = String(goal || "").trim();
  if (!g) return null;
  // When the user is prospecting (selling/pitching/partnering with EXTERNAL
  // targets), the target's profile is set by the GOAL, not by the user's own
  // field. Without this, the planner sees a music-tech company in ABOUT and
  // bakes "music industry" into required/hard/negative constraints — which
  // planFit then enforces, rejecting every off-field company as "not a fit".
  const prospecting = isProspectingUseCase(useCase) || goalWantsAnyIndustry(g);
  const anyIndustry = goalWantsAnyIndustry(g);
  const prospectingNote = prospecting
    ? `\n\nPROSPECTING MODE: The user is finding EXTERNAL targets to sell to, pitch, partner with, or raise from — ABOUT THE USER describes the SENDER and what they offer, NOT the target. Define the target from the GOAL alone; never treat the user's own industry or field as a target requirement.` +
      (anyIndustry
        ? ` The user has explicitly said ANY / ALL industries are acceptable, so industry is NOT a constraint: required, hard_constraints, and negative_constraints must NOT reference any industry, sector, or field — limit them to the target's size, type, stage, reachability, or timing. Keep understanding HIGH: an open industry is a deliberate choice, not missing information, so do not lower understanding or ask a confidence_question about which industry to target.`
        : ``)
    : ``;
  // On a re-plan (the user hit "Sharpen"), don't ask the same things again. The
  // answers are already folded into the goal above; these were the questions.
  const asked = (askedQuestions || []).map((q) => String(q || "").trim()).filter(Boolean);
  const askedNote = asked.length
    ? `\n\nALREADY ASKED (the user has these covered — do NOT repeat them or ask anything that overlaps in meaning; only surface genuinely NEW, still-unknown dimensions, and return an empty confidence_questions array if nothing new remains): ${asked
        .map((q) => `"${q}"`)
        .join("; ")}`
    : ``;
  const user =
    `${todayLine()}\n\n` +
    `USE CASE: ${useCase}\nGOAL: ${g}\nABOUT THE USER (their field, sub-field, seniority, city are in here): ` +
    `${String(about || "").slice(0, 1600)}` +
    prospectingNote +
    askedNote +
    (personalOverride ? `\n\n${personalOverride}` : "");
  try {
    const raw = await claudeJson(DECOMPOSE_SYS, user, 3200); // big schema, needs room
    const parsed: any = parseJsonLoose(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const arr = (v: any): string[] =>
      Array.isArray(v) ? v.map((x) => String(x || "").trim()).filter(Boolean).slice(0, 20) : [];
    const factors: RankingFactor[] = Array.isArray(parsed.ranking_factors)
      ? parsed.ranking_factors
          .map((f: any) => ({ factor: String(f?.factor || "").trim(), weight: Number(f?.weight) || 0 }))
          .filter((f: RankingFactor) => f.factor)
          .slice(0, 8)
      : [];
    // The model occasionally OMITS `understanding` on a rich, complex plan. A
    // bare `|| 0` then reads as "Scout is totally lost" — showing 0% and firing
    // needless clarifying questions on a goal it actually grasped (observed on a
    // fully-decomposed "musicians in Nashville in March" plan). When it's missing
    // or non-numeric, infer it from how completely the plan came back instead of
    // defaulting to zero.
    const rawU = Math.round(Number(parsed.understanding));
    let understanding: number;
    if (Number.isFinite(rawU)) {
      understanding = Math.max(0, Math.min(100, rawU));
    } else {
      const filled =
        (Array.isArray(parsed.required) && parsed.required.length ? 1 : 0) +
        (Array.isArray(parsed.hard_constraints) && parsed.hard_constraints.length ? 1 : 0) +
        (Array.isArray(parsed.evidence_needed) && parsed.evidence_needed.length ? 1 : 0) +
        (parsed.target_type && String(parsed.target_type).trim() ? 1 : 0);
      const qCount = Array.isArray(parsed.confidence_questions)
        ? parsed.confidence_questions.length
        : 0;
      // A well-populated plan with few open questions is well-understood; a thin
      // one isn't. Never 0 when a real plan came back.
      understanding = filled >= 3 ? Math.max(55, 80 - qCount * 8) : 45;
    }
    // Questions may come back as {question,options} objects (new) or bare
    // strings (older prompts / fallback). Normalize both to the object shape.
    const questions: ConfidenceQuestion[] = Array.isArray(parsed.confidence_questions)
      ? parsed.confidence_questions
          .map((q: any): ConfidenceQuestion => {
            if (typeof q === "string") return { question: q.trim(), options: [] };
            return {
              question: String(q?.question || "").trim(),
              options: Array.isArray(q?.options)
                ? q.options.map((o: any) => String(o || "").trim()).filter(Boolean).slice(0, 5)
                : [],
            };
          })
          .filter((q: ConfidenceQuestion) => q.question)
          .slice(0, 4)
      : [];

    // Safety net: the model still sometimes asks about a dimension the goal or
    // profile already states (or even contradicts — e.g. asking to prioritize a
    // city when the goal says "any location"). Drop those so Scout never asks
    // the user something they just told it.
    const hay = `${g} ${about}`.toLowerCase();
    const anyLocation =
      /\b(any\s?(location|city|region|country|where)|anywhere|nationwide|worldwide|global(ly)?|remote|location[-\s]?agnostic|no\s+(location|geo))\b/.test(
        hay
      );
    const hasSize =
      /\b(small(er)?|tiny|startups?|smb|mid[-\s]?size(d)?|large(r)?|enterprise|big|boutique|\d+\s*(employees|people|person|staff|headcount))\b/.test(
        hay
      );
    const hasStage =
      /\b(pre[-\s]?revenue|early[-\s]?stage|seed|series\s?[a-e]|growth[-\s]?stage|established|mature|bootstrapp?ed|funded|venture[-\s]?backed)\b/.test(
        hay
      );
    const anyIndustryStated = goalWantsAnyIndustry(g);
    const redundant = (q: string): boolean => {
      const t = q.toLowerCase();
      // Stems (not \b-bounded whole words) so "located"/"locate"/"industries"
      // all match — that mismatch let a "where should they be located?" question
      // slip through even though the goal said "any location".
      const isLoc =
        /(locat|\bcity|region|countr|\blocal|nearby|geograph|distance|radius|\bmiles|\barea\b|\bwhere\b|based in|prioriti[sz])/.test(t);
      const isInd = /(industr|sector|vertical|niche|\bfield\b|\bspace\b|\bmarket)/.test(t);
      const isSize =
        /(company size|employee|headcount|how (big|small|large)|size range|team size|number of (employees|people)|small or large)/.test(t);
      const isStage = /(\bstage\b|pre[-\s]?revenue|early|growth|mature|\bseed\b|series|funding|funded)/.test(t);
      if (isLoc && anyLocation) return true;
      if (isInd && anyIndustryStated) return true;
      if (isSize && hasSize) return true;
      if (isStage && hasStage) return true;
      return false;
    };
    const beforeCount = questions.length;
    const filteredQuestions = questions.filter((q) => !redundant(q.question));
    // Removing already-answered questions means Scout understands more than the
    // model admitted — nudge understanding up so a well-specified inquiry isn't
    // gated behind a redundant question (or an implausible 0%).
    const dropped = beforeCount - filteredQuestions.length;
    const bumpedUnderstanding = Math.min(
      100,
      understanding + dropped * 15 + (filteredQuestions.length === 0 ? 10 : 0)
    );

    return {
      goal: String(parsed.goal || g).trim(),
      target_type: String(parsed.target_type || "").trim(),
      understanding: bumpedUnderstanding,
      required: arr(parsed.required),
      preferred: arr(parsed.preferred),
      hard_constraints: arr(parsed.hard_constraints),
      soft_constraints: arr(parsed.soft_constraints),
      negative_constraints: arr(parsed.negative_constraints),
      evidence_needed: arr(parsed.evidence_needed),
      opportunity_signals: arr(parsed.opportunity_signals),
      search_dimensions: arr(parsed.search_dimensions),
      ranking_factors: factors,
      confidence_questions: filteredQuestions,
    };
  } catch (e) {
    if (e instanceof ApiCreditError) throw e;
    return null;
  }
}

// A compact text rendering of the plan for injecting into the query planner and
// the extractor's prompts.
function planBlock(plan: GoalPlan | null | undefined): string {
  if (!plan) return "";
  const list = (label: string, items: string[]) =>
    items.length ? `\n${label}: ${items.join("; ")}` : "";
  return (
    `\n\nGOAL DECOMPOSITION (your blueprint — reason from this):` +
    `\nReal objective: ${plan.goal}` +
    (plan.target_type ? `\nTarget type: ${plan.target_type}` : "") +
    list("Must be true (reject if false)", [...plan.required, ...plan.hard_constraints]) +
    list("Nice to have", [...plan.preferred, ...plan.soft_constraints]) +
    list("EXCLUDE", plan.negative_constraints) +
    list("EVIDENCE that would prove a match (search for THIS, not for people)", plan.evidence_needed) +
    list("Opportunity signals (favor targets showing these, NOW is a good time)", plan.opportunity_signals) +
    list("Search dimensions (attack from several of these)", plan.search_dimensions)
  );
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
  // Broaden mode: a narrower first pass returned nothing, so widen the net,
  // relax the niche/long-tail/geo/segment constraints and allow bigger, more
  // obvious targets so a very specific goal degrades to *some* results instead
  // of an empty screen.
  broaden = false,
  // The Discovery Planner's blueprint (decomposeGoal). When present, queries are
  // written to surface the EVIDENCE it names, spread across its search
  // dimensions, favoring its opportunity signals.
  plan?: GoalPlan | null
): Promise<string[]> {
  const g = goal.trim();
  if (!about.trim() && !plan) return buildQueries(goal, useCase);

  const jobs = isJobSearch(useCase, goal);
  const networking = !jobs && isNetworkingUseCase(useCase);
  const influencer = isSocialCreatorSearch(useCase, goal);
  const prospecting = isProspectingUseCase(useCase) || goalWantsAnyIndustry(goal);
  // The industry anchor below stops queries from clustering in the user's own
  // field. Location needs the exact same guard: ABOUT is the only place a
  // city ever appears for this user, so with no explicit instruction the
  // model quietly grounds queries in the sender's own city even when the
  // goal says "any location", this was the actual cause of prospecting
  // searches still coming back Nashville/music-flavored.
  const anywhere = goalWantsAnywhere(goal);

  let guidance = "";
  // Creator/social intent is checked FIRST: a creator search that also says
  // "any industry" should still use the roundup strategy, not the company-
  // directory one, so it must win over the prospecting branch below.
  if (influencer) {
    guidance =
      "Target curated ROUNDUP articles and listicles that NAME real social creators, that's where we find them, " +
      "since Instagram / TikTok / X / YouTube block deep search. Combine the specific niche + platform + geography + a " +
      "roundup signal. Good query patterns: 'top 10 {niche} {platform} {city}', 'best {niche} creators to follow', " +
      "'{niche} {platform} accounts to know', '{niche} micro-influencer roundup', '{niche} {platform} directory', " +
      "'{niche} creators linktree {city}'. If the GOAL names a specific platform, prioritize it; otherwise spread queries " +
      "across the majors (TikTok, Instagram, YouTube, and where it fits Twitch or X) so coverage isn't stuck on one app. " +
      "Prefer queries that will surface: local magazine / press features (Voyager, Time Out, city guides), brand blog " +
      "roundups, agency directories, aggregator sites (Later, Modash public pages, HypeAuditor blog, Klear, Collabstr, " +
      "SocialBlade). Include '{platform}.com' in some queries so pages that mention creator @handles surface. NEVER use " +
      "'how to' or 'tips', those are advice, not creator lists.";
  } else if (prospecting) {
    guidance =
      "The user is PROSPECTING, finding external companies / people to pitch, sell to, partner with, or raise from. The " +
      "targets live in DIFFERENT industries than the user, so do NOT bias queries toward the user's own field. Build queries " +
      "from the GOAL's target profile (size, type, stage, location) plus a findability signal that surfaces a contact route. " +
      "Good query patterns: '{target type} companies contact email', '{target type} directory', 'list of {target type} " +
      "businesses', '{target type} companies {city}' (only if the goal names a place), '{industry} startups contact us', " +
      "'{target type} companies with phone number email'. Prefer queries that surface company contact / about pages, business " +
      "directories, chamber-of-commerce and association member lists, and curated roundups of companies. " +
      "HALF AND HALF, a hard rule when the goal names ONE industry plus openness beyond it ('music industry and other " +
      "industries', 'tech but open to anything'): split the query set close to evenly, half inside the named industry, " +
      "half deliberately across DIFFERENT industries, so results come back balanced instead of collapsing into the named one. " +
      "INDUSTRY SPREAD, a hard rule when the goal asks for ANY industry or a VARIETY: assign each query its OWN industry, " +
      "drawn from a spread like restaurants and food, fitness and wellness, construction and trades, healthcare clinics, " +
      "e-commerce and retail brands, real estate, marketing and creative agencies, manufacturers, education, logistics, " +
      "professional services, software startups. No two queries may target the same industry, and at most one query may " +
      "name no industry at all. A query set that clusters in one field returns one field, which is exactly what the user " +
      "said they do not want. NEVER use 'how to', 'tips', 'guide', or 'advice'.";
  } else if (jobs) {
    guidance =
      "Find things the user can APPLY TO in their industry. Weight the query set about TWO-THIRDS toward (1) and one-third " +
      "toward (2): (1) REAL open job/internship listings the user can apply to right now, and (2) GOOD-FIT COMPANIES that " +
      "likely hire people like the user even if no listing is public, so they can send a proactive 'please consider me' " +
      "email. If the goal names one industry plus openness beyond it ('music industry and other industries'), split the " +
      "queries close to evenly between that industry and deliberately different ones, so the results come back balanced. " +
      "Openings are the priority — most queries should hunt actual postings. For (1) pair the " +
      "role/field with the user's sub-field and an apply signal (e.g. 'brand marketing internship summer 2026 apply', " +
      "'growth marketing intern DTC careers'). For (2) surface actual COMPANIES and their contact/careers/about pages " +
      "(e.g. 'small brand marketing agencies New York', 'boutique DTC studios careers email', 'independent {industry} firms " +
      "contact'), business directories, and local roundups. STRONGLY prefer SMALL companies, startups, studios, boutiques, " +
      "and local firms, they are far more responsive to a cold note than big brands. If the profile signals a beginner or " +
      "small-company preference, lean almost entirely on small/local/early-stage employers and AVOID the famous, ultra-" +
      "competitive names. Add the user's city or a hub city for their industry. Never use 'how to', 'tips', or 'guide'.";
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
  // profile) is exactly wrong, it's why an "any industry" search kept returning
  // only music. The GOAL defines the target; the user's field must not filter.
  const anchor = prospecting
    ? "You are a search strategist for an outreach tool. The user is PROSPECTING: write web-search queries that surface " +
      "the TARGETS DESCRIBED BY THE GOAL. Do NOT anchor to the user's own industry, field, or genre (from ABOUT), those " +
      "targets live in DIFFERENT industries than the user, and biasing toward the user's field would return the wrong " +
      "results. Use ABOUT only to understand what the user sells/offers, never as an industry filter on the targets. " +
      "USE CASE is just a category label for this search, not the product being pitched, if ABOUT describes a specific " +
      "product, tool, or service (even one sentence naming it), THAT is what's being offered; never substitute the USE " +
      "CASE label as the offering (e.g. a 'Music PR' use case prospecting for a software tool's customers is NOT selling " +
      "music services, it's selling that tool, so don't bias queries toward buyers of music-related things). " +
      (anywhere
        ? "The user has said the target can be ANYWHERE, do NOT use the sender's own city, state, or region from ABOUT " +
          "as a query parameter, even implicitly; it is not a location constraint on the targets. "
        : "Only use a location in queries if the GOAL ITSELF explicitly names one. The sender's own city/region in ABOUT " +
          "describes the sender, not where the targets should be, never default to it as a stand-in location. ")
    : "You are a search strategist for an outreach tool. From the user's goal and their profile, write web-search " +
      "queries that surface results matching BOTH the goal AND the user's industry/field/level/location (infer all of " +
      "these from ABOUT THE USER, do not ask). ";
  // The long-tail push: for prospecting, "specific" means the GOAL's target
  // profile (type/size/stage/place), not the user's sub-field/genre.
  const longTail = prospecting
    ? (anyIndustry
        ? " CRITICAL: the user wants a VARIETY of industries, so every query must target a DIFFERENT industry — cover at " +
          "least 6 distinct ones across the set (e.g. local retailers, professional-services firms, trades, hospitality, " +
          "healthcare, SaaS, manufacturing, nonprofits, real estate), and NEVER put two queries in the same industry. " +
          "IMPORTANT: the user's past kept or denied finds (in the feedback below) reflect only the narrow slice Scout has " +
          "surfaced so far, NOT an industry preference — do NOT let them pull queries toward that one industry. Deliberately " +
          "reach into industries NOT represented in that feedback so the results keep widening, not narrowing. "
        : " CRITICAL: keep queries specific to the GOAL's target profile (type, size, stage, location). ") +
      "Favor NICHE, smaller, more-responsive targets over the handful of biggest names everyone already contacts. " +
      "Make each query hyper-specific to the target profile (segment, company size, city) rather than broad. "
    : " CRITICAL for relevance and to avoid spamming the same inboxes: favor NICHE, specific, less-obvious targets that " +
      "closely fit THIS user's exact sub-field, city, genre, stage and angle. Deliberately AVOID the handful of biggest, " +
      "most-famous, most-submitted-to names everyone already contacts; go for the long tail of smaller, genuinely-matching, " +
      "more responsive contacts. Make each query hyper-specific (sub-genre, neighborhood/city, company size, seniority) " +
      "rather than broad. EXCEPTION — THE GOAL WINS: if the GOAL explicitly asks for the biggest, most famous, top, major, " +
      "or best-known targets, honor that exactly — drop this long-tail push for this search and write queries that surface " +
      "precisely those big names instead. ";
  const broadenClause = broaden
    ? " BROADEN MODE: a narrower version of this search just returned NO results, so widen the net now. DROP the niche / " +
      "long-tail / hyper-specific push above. Use simpler, broader queries with FEWER combined constraints, relax location, " +
      "company size, sub-genre, seniority and segment filters, and it is fine to include larger, well-known targets. Stay " +
      "on-topic for the GOAL, but prioritize surfacing real, reachable results over being specific. "
    : "";
  // Evidence-first querying, driven by the Discovery Planner's blueprint.
  const evidenceClause = plan
    ? " EVIDENCE-FIRST: a GOAL DECOMPOSITION blueprint is provided below. Do NOT write queries that search for the target " +
      "people or organizations by description directly. Instead, write queries that surface the EVIDENCE the blueprint " +
      "names (rosters, lineups, speaker lists, funding announcements, team/management pages, award winners, directories, " +
      "recent press) — the best candidates are found through indirect evidence. Spread your queries ACROSS the blueprint's " +
      "search dimensions (don't cluster on one), weave in its opportunity signals so recently-active targets surface, and " +
      "never target anyone on its EXCLUDE list. "
    : "";
  // Date-anchored evidence for goals with a TIME WINDOW ("in March", "spring
  // 2026", "the week of the 12th", "during SXSW"): the right sources are dated
  // calendars and lineups, and a query without the dates returns evergreen
  // pages that can't confirm presence in the window.
  const timeWindowClause =
    " TIME WINDOW: if the GOAL names a time window (a month, date range, season, semester, or a named event's dates), " +
    "anchor MOST queries to it explicitly — put the month/year or event name IN the query text (e.g. 'Nashville concert " +
    "calendar March 2026', '{city} festival lineup {month} {year}', 'conferences in {city} {month} {year} speakers', " +
    "'{venue} upcoming shows {month} {year}', 'artists touring through {city} {month} {year}'). Prefer sources that are " +
    "dated by nature — venue calendars, event/ticketing listings (Songkick, Bandsintown, Eventbrite, city event guides), " +
    "festival and conference lineups, tour-date pages — over undated directories or bio pages, because only dated sources " +
    "can prove someone will actually be there during the window. BUT also spend SOME queries finding people who are BASED " +
    "IN the location (e.g. '{city}-based artists', 'musicians who live in {city}', '{city} local {profession}'), because " +
    "a local is in town by default and is fully eligible without a dated appearance — dated visitors and locals are BOTH " +
    "valid, so cover both. If the goal has no time window, ignore this. ";
  const sys =
    anchor +
    guidance +
    longTail +
    broadenClause +
    evidenceClause +
    timeWindowClause +
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
    // drafting), see buildPersonalOverride in lib/autotune.ts.
    (personalOverride ? `\n\n${personalOverride}` : "");
  const user =
    `${todayLine()}\n\n` +
    `USE CASE: ${useCase}\nGOAL: ${g}\nABOUT THE USER (their industry, sub-field, seniority and city are in here): ${about.slice(0, 1600)}` +
    planBlock(plan) +
    feedbackBlock(feedback, g);

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
// it's demonstrably real, its host either matches the Tavily source URL's
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
  // Same-domain: LLM stripped tracking params or picked a canonical URL, trust.
  if (candHost && llmHost === candHost) return llm;
  // Cross-domain: only trust when the LLM's host actually appears in the
  // source page's content (case-insensitive substring). Hallucinated hosts
  // don't survive this because the source page never mentions them.
  const contentLower = String(candContent || "").toLowerCase();
  if (contentLower && contentLower.includes(llmHost)) return llm;
  return cand || "";
}

// ---- Platform sweeps ----------------------------------------------------
// Which public platforms are worth a dedicated domain-scoped pass for a given
// goal. Ordinary search ranks articles about people above the people
// themselves; scoping a query to one platform forces profile pages to the
// surface. Capped at 3 platforms per search so a sweep stays a few extra
// queries, not a second full search.
//
// Every entry is the search index's PUBLIC view of that site. Nothing here
// logs in, and platforms whose content is walled (Facebook) or effectively
// unindexed are deliberately absent, a sweep that returns login pages costs
// credits and yields nothing.
const PLATFORM_SWEEPS: {
  key: string;
  label: string;
  domains: string[];
  // When this platform is worth sweeping. Matched against goal + use case.
  when: RegExp;
  // Skip when the goal is clearly a different world (keeps music sweeps off a
  // finance search, and vice versa).
  unless?: RegExp;
}[] = [
  {
    key: "linkedin",
    label: "public LinkedIn profiles",
    domains: ["linkedin.com"],
    // The default professional sweep: any goal about people or companies.
    when: /\b(alumni|alumnus|alumna|mentors?|people|professionals?|graduates?|students?|members?|founders?|owners?|executives?|managers?|directors?|recruiters?|hiring|coordinators?|supervisors?|agents?|producers?|marketers?|engineers?|designers?|analysts?|consultants?|company|companies|business|businesses|team|staff|firm|agency|agencies|label|labels|brand|brands|sponsors?|partners?|vendors?|suppliers?|shops?|stores?|restaurants?)\b/i,
  },
  {
    key: "instagram",
    label: "public Instagram profiles",
    domains: ["instagram.com"],
    when: /\b(artist|artists|musician|musicians|band|bands|creator|creators|influencer|influencers|photographer|photographers|model|models|dj|djs|singer|songwriter|rapper|makeup|stylist|chef|fitness|dancer|tattoo|boutique|salon|florist|baker|bakery)\b/i,
    // Hiring/agency searches mention "designers" or "producers" as roles, that
    // is a LinkedIn world, not an Instagram one.
    unless: /\b(hiring|recruit|recruiters?|job|jobs|intern|internships?|apply|application|resume|candidates?)\b/i,
  },
  {
    key: "music",
    label: "public music profiles",
    domains: ["bandcamp.com", "soundcloud.com", "songkick.com"],
    when: /\b(music|musician|musicians|band|bands|album|albums|song|songs|playlist|playlists|record label|labels|touring|gig|gigs|sync|licensing|a&r|indie|singer|songwriter|rapper|dj|djs)\b/i,
    // "Venue" and "booking" belong to plenty of non-music worlds (weddings,
    // conferences, catering), so they no longer trigger a music sweep alone.
    unless: /\b(wedding|weddings|conference|conferences|corporate|catering|banquet|reception)\b/i,
  },
  {
    key: "tech",
    label: "public developer profiles",
    domains: ["github.com", "wellfound.com"],
    when: /\b(engineer|engineers|developer|developers|programmer|programmers|software|technical|cto|devops|data scientist|machine learning|ml|ai|open source|startup|startups|founder|founders)\b/i,
    unless: /\b(music|musician|band|artist|fashion|restaurant|realtor|real estate)\b/i,
  },
  {
    // Mostly login-walled, so yield is thin; swept anyway at the user's
    // request because employer/job pages that ARE public are high-signal.
    key: "handshake",
    label: "public Handshake employer and job pages",
    domains: ["joinhandshake.com"],
    when: /\b(intern|internships?|jobs?|entry[- ]?level|new ?grad|students?|campus|university|college|hiring|apply|co-?ops?)\b/i,
  },
  {
    key: "academic",
    label: "university and program pages",
    domains: ["edu"],
    when: /\b(alumni|alumnus|alumna|graduate|graduates|masters?|mba|msel|phd|doctoral|professor|professors|faculty|academic|university|college|school|program|programs|admissions|fellowship|scholarship|research|researchers?|student|students)\b/i,
  },
  {
    key: "press",
    label: "journalist and writer profiles",
    domains: ["muckrack.com", "substack.com", "medium.com"],
    when: /\b(journalist|journalists|writer|writers|reporter|reporters|editor|editors|press|media|blogger|bloggers|critic|critics|columnist|newsletter|publication|magazine)\b/i,
  },
  {
    key: "social",
    label: "public X profiles",
    domains: ["x.com"],
    when: /\b(creator|creators|influencer|influencers|commentator|commentators|thought leader|community|public figure|journalist|founder|founders|investor|investors|vc)\b/i,
  },
  {
    // Reddit is where niches recommend each other by name. A thread titled
    // "who's the best wedding planner in LA" is a container page listing the
    // exact vendors the goal wants, and the multi-person extractor already
    // reads container pages. The profiles themselves carry no contact routes,
    // so the value is the NAMES a thread surfaces; the engine's usual passes
    // then find each one's own site and route.
    key: "reddit",
    label: "community recommendation threads",
    domains: ["reddit.com"],
    when: /\b(recommend|recommendation|recommendations|vendors?|niche|community|communities|local|indie|independent|freelance|freelancers?|small business|word of mouth|best .{0,24}\b(in|near|around)\b)\b/i,
  },
  {
    // Channel about-pages are public and often list a business email; the
    // single biggest gap for music and creator goals.
    key: "youtube",
    label: "YouTube channels",
    domains: ["youtube.com"],
    when: /\b(youtube|youtuber|channel|channels|creator|creators|video|videos|vlogger|podcast|podcaster|reviewer|reviewers|cover|covers|musician|musicians|artist|artists|streamer)\b/i,
  },
  {
    // Event organizers and speakers: pages are public, named, and carry a
    // contact route, exactly the shape networking and partnership goals want.
    key: "events",
    label: "event organizers and speakers",
    domains: ["eventbrite.com", "meetup.com", "lu.ma"],
    when: /\b(event|events|organizer|organizers|host|hosts|meetup|meetups|conference|conferences|summit|workshop|workshops|panel|panels|speaker|speakers|showcase|showcases|open mic|networking)\b/i,
  },
  {
    // Small makers and indie brands with real shop contact routes: the
    // "smaller companies, any industry" prospecting shape.
    key: "makers",
    label: "independent makers and shops",
    domains: ["etsy.com", "faire.com"],
    when: /\b(maker|makers|handmade|artisan|artisans|crafts?|boutique|boutiques|indie brand|indie brands|small (shop|shops|brand|brands|business|businesses)|sellers?|jewelry|candle|candles|apparel|stationery|pottery|prints)\b/i,
  },
  {
    // Local service businesses: venues, planners, studios. Yelp is heavily
    // bot-protected, so this sweep can come back thin; it is a supplement to
    // the open-web queries, never the plan.
    key: "local",
    label: "local business listings",
    domains: ["yelp.com"],
    when: /\b(venue|venues|studio|studios|planner|planners|salon|salons|restaurant|restaurants|caterer|caterers|photographer|photographers|florist|florists|bar|bars|cafe|cafes|shop|shops) .{0,30}\b(in|near|around)\b/i,
  },
  {
    // Startups by stage and niche, founders named; pairs with the tech sweep.
    key: "startups",
    label: "startup directories",
    domains: ["crunchbase.com", "producthunt.com"],
    when: /\b(startup|startups|founder|founders|seed|pre-?seed|series [ab]|saas|early[- ]stage|venture|funded|bootstrapped|launch(ed|ing)?)\b/i,
  },
  {
    // TikTok is the most login-walled platform; direct pages rarely crawl, so
    // this sweep exists for the minority that do, while the roundup-article
    // strategy stays the primary route to TikTok creators.
    key: "tiktok",
    label: "public TikTok profiles",
    domains: ["tiktok.com"],
    when: /\btiktok(er|ers)?\b/i,
  },
];

export function platformSweeps(
  goal: string,
  useCase: string,
  about?: string
): { key: string; label: string; domains: string[] }[] {
  // Match on the goal first (what they asked for), with use case + about as
  // weaker context, so "band members" sweeps music even from a generic profile.
  const primary = `${goal || ""}`;
  const context = `${goal || ""} ${useCase || ""} ${String(about || "").slice(0, 400)}`;
  const picked: { key: string; label: string; domains: string[]; score: number }[] = [];
  for (const p of PLATFORM_SWEEPS) {
    if (p.unless?.test(primary)) continue;
    // A goal-text hit outranks a context-only hit, so the most on-point
    // platforms survive the cap below.
    const score = p.when.test(primary) ? 2 : p.when.test(context) ? 1 : 0;
    if (score) picked.push({ key: p.key, label: p.label, domains: p.domains, score });
  }
  return picked
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(({ key, label, domains }) => ({ key, label, domains }));
}

// Hosts that are review sites, directories, or aggregators, never a target's
// own home. Surfacing one as the find's "website" (a Yelp listing, a
// YellowPages page) points the user somewhere that isn't the company at all.
const DIRECTORY_URL_HOSTS =
  /(^|\.)(yelp|yellowpages|superpages|bbb|mapquest|manta|tripadvisor|foursquare|chamberofcommerce|dnb|zoominfo|glassdoor|indeed|ziprecruiter|angi|thumbtack|houzz|birdeye|alignable|citysearch|merchantcircle|hotfrog|brownbook|cylex|nicelocal|opencorporates|buzzfile|crunchbase|producthunt)\.(com|co|org|net|io)$/i;
const FREEMAIL_DOMAINS =
  /^(gmail|yahoo|ymail|outlook|hotmail|live|msn|aol|icloud|me|proton|protonmail|zoho|gmx|mail|pm)\./i;

// The target's own site inferred from their contact email's domain, the one
// URL we can trust more than a directory listing (freemail excluded).
function siteFromEmailDomain(email: string): string {
  const m = String(email || "")
    .toLowerCase()
    .match(/@([a-z0-9.-]+\.[a-z]{2,})$/i);
  if (!m) return "";
  if (FREEMAIL_DOMAINS.test(m[1])) return "";
  return `https://${m[1]}`;
}

// Never present a directory/review listing as the target's website: prefer the
// domain their real email lives on; otherwise leave the field empty (the
// listing stays visible under sources/evidence, it just isn't "their site").
function sanitizeSiteUrl(url: string, contactEmail: string): string {
  const host = urlHost(url);
  if (host && DIRECTORY_URL_HOSTS.test(host)) {
    return siteFromEmailDomain(contactEmail);
  }
  return url;
}

// Normalize a person's name so "John Smith", "John J. Smith", "Dr. John Smith Jr",
// and "John Jacob Smith" all collapse to the same key. Strips honorifics,
// suffixes, and middle names/initials, then keeps first + last token.
function isRedditHost(host: string): boolean {
  return /(^|\.)reddit\.com$/i.test(host || "");
}
// True when every page that VOUCHES for this find is a Reddit page. The find's
// own url does not exempt it: a website address typed into a thread is still
// only the thread's word until the verification search sees it standing on the
// open web.
function onlyRedditSourced(o: Opportunity): boolean {
  const srcUrls = (o.sources || []).map((x) => String(x?.url || "")).filter(Boolean);
  if (srcUrls.length) return srcUrls.every((u) => isRedditHost(urlHost(u)));
  return isRedditHost(urlHost(o.url || ""));
}

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
    // never actually appears, extractor puts the name first, so this is
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
function normEmail(e: string): string {
  return String(e || "").trim().toLowerCase();
}
// True for role inboxes (careers@, info@, hello@…) that aren't a specific person,
// so entity-resolution can prefer a real personal address over one of these.
const GENERIC_EMAIL_PREFIX =
  /^(careers?|jobs?|hr|recruit(ing|ment)?|talent|info|hello|contact|apply|applications?|resumes?|staffing|people|hiring|admin|support|team|noreply|no-reply|press|media|sales|partnerships?)@/i;
function isPersonalEmail(e: string): boolean {
  const s = normEmail(e);
  return !!s && !GENERIC_EMAIL_PREFIX.test(s);
}
// Clamp an LLM-provided 0..1 component to a valid number, or undefined if absent.
function clamp01(n: any): number | undefined {
  const x = Number(n);
  if (isNaN(x)) return undefined;
  return Math.max(0, Math.min(1, x));
}
// How reachable a candidate is, straight from the contact data we actually have.
// A named personal email is best; a DM handle alone is weakest.
function reachabilityFrom(email?: string, handle?: string, phone?: string): number {
  if (isPersonalEmail(email || "")) return 0.95;
  if (email && String(email).trim()) return 0.7; // usable but generic inbox
  if (phone && String(phone).trim()) return 0.6;
  if (handle && String(handle).trim()) return 0.5; // DM only
  return 0.15;
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

// The GOAL text can declare a job/internship hunt even when the use-case label
// doesn't — e.g. a "Networking" project where the user typed "find internships"
// into the goal box. Without this, that search took the networking path and
// returned only people, never real openings or employers to apply to.
export function goalWantsJobs(goal: string): boolean {
  return /\b(internships?|jobs?|open roles?|open positions?|openings?|apprenticeships?|co-?ops?|new ?grad|entry[- ]?level|now hiring|places? to (work|apply)|companies? (to|i can) (work for|apply to))\b/i.test(
    goal || ""
  );
}

// A job/internship hunt if EITHER the use-case vertical OR the goal text says so.
// This is the switch that turns on the whole job pipeline: half-listings queries,
// employer + posting results, collapse-by-employer, and recruiter-contact attach.
function isJobSearch(useCase: string, goal: string): boolean {
  return isJobUseCase(useCase) || goalWantsJobs(goal);
}

// Generic inbox prefixes, not a specific person, so we still try to find one.
const GENERIC_EMAIL =
  /^(careers?|jobs?|hr|recruit(ing|ment)?|talent|info|hello|contact|apply|applications?|resumes?|staffing|people|hiring|admin|support|team|noreply|no-reply)@/i;

// Is there an actual way to reach this person? A contact VALUE — an address, a
// number, a handle — not the `channel` label, which is only the extractor's
// guess at a route ("Website Form", "Company Portal") and is routinely set on
// results carrying no contact detail at all. A profile URL doesn't count
// either: a bio page you can read is not a way to get in touch.
export function hasAnyContact(o: Opportunity): boolean {
  return (
    !!String(o.contactEmail || "").trim() ||
    !!String(o.contactPhone || "").trim() ||
    !!String(o.contactHandle || "").trim()
  );
}

function hasPersonalEmail(o: Opportunity): boolean {
  return (
    !!o.contactEmail &&
    !!o.contactName &&
    !GENERIC_EMAIL.test(o.contactEmail.trim())
  );
}

// For one opening, hunt for a specific person in recruiting or on the team who an
// applicant could email. Never invents contacts, only what appears in results.
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

// Phase 2 — recursive contact enrichment for ANY search (not just jobs). When a
// strong candidate has no reachable contact, spawn targeted follow-up searches to
// find one: a personal email, LinkedIn, or the right gatekeeper (manager, agent,
// booking, publicist, PR, press/partnerships). Never invents contacts.
async function findContactFor(
  opp: Opportunity,
  goal: string,
  useCase: string
): Promise<{ name: string; role: string; email: string; handle: string; phone: string } | null> {
  const who = (opp.name || "").trim();
  const org = (opp.outlet || "").trim();
  if (!who) return null;
  const isPerson = (opp.targetType || "") === "person";
  const label = `${who}${org && org !== who ? ` (${org})` : ""}`;
  const queries = isPerson
    ? [
        `"${who}"${org ? ` ${org}` : ""} email OR contact`,
        `"${who}"${org ? ` ${org}` : ""} LinkedIn OR manager OR agent OR publicist OR booking contact`,
      ]
    : [
        `${who} contact email OR "get in touch"`,
        `${who} team OR press OR partnerships email`,
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
    `You find ONE real way to reach this target for outreach about: "${goal}". ` +
    (isPerson
      ? `The target is a PERSON. Return the best reachable contact: their own work/personal email, or the email of ` +
        `their manager / agent / publicist / booking or press contact, plus a LinkedIn or @handle if present. `
      : `The target is an ORGANIZATION. Return a real contact route: a named person's email if shown, else the best ` +
        `team/press/partnerships email, plus any handle. `) +
    `Return ONLY JSON {name, role, email, handle, phone}. CRITICAL: never invent an email, name, or phone, use only ` +
    `values that appear VERBATIM in the results. Prefer a specific personal email over a generic inbox ` +
    `(info@, contact@, hello@). If a phone appears verbatim, include it. If nothing reachable is present, return ` +
    `all-empty fields.`;
  const user = `TARGET: ${label}\n\nSEARCH RESULTS:\n${snippets.join("\n\n").slice(0, 6000)}`;
  try {
    const parsed: any = parseJsonLoose(await claudeJson(sys, user));
    const email = String(parsed?.email || "").trim();
    const name = String(parsed?.name || "").trim();
    const handle = String(parsed?.handle || "").trim();
    const role = String(parsed?.role || "").trim();
    const phone = String(parsed?.phone || "").trim();
    if (!email && !handle && !phone) return null;
    return { name, role, email, handle, phone };
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
  personalOverride?: string,
  plan?: GoalPlan | null
): Promise<Partial<Opportunity> & { isRelevant?: boolean } | null> {
  // Fit is judged differently depending on what the user is doing:
  // - Prospecting (sales/leads/partners/investors) OR a goal that says "any
  //   industry": the target lives in a DIFFERENT world than the user, so we
  //   must NOT filter by the user's own field. The GOAL defines the target.
  // - Everything else (networking/jobs/PR): the target IS in the user's field,
  //   so aligning to the user's industry/location is correct.
  const prospecting = isProspectingUseCase(useCase) || goalWantsAnyIndustry(goal);
  // Job/internship hunts accept COMPANIES as targets (for a proactive "please
  // consider me" email), not just postings with a named person, so they get
  // their own fit rules below rather than the person-centric networking ones.
  const jobs = !prospecting && isJobSearch(useCase, goal);
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

  // Core quality gates, apply to every mode. These are about whether the
  // result is a REAL, REACHABLE target, not about fit.
  const core =
    `You are a research assistant. From a web search result, extract a structured record of ONE REAL, SPECIFIC ${noun || "target"} ` +
    `the user could actually reach out to, matching their GOAL and USE CASE. Return ONLY a JSON object, no prose, no markdown. ` +
    `Never invent contact details or facts, leave a field empty if it is not present in the result. ` +
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
    `only mentions a person by name in passing, no personal profile page, no interview, no direct contact channel, set ` +
    `is_relevant to false. For a "person" the source must EITHER be about them OR give a direct contact channel ` +
    `(email or LinkedIn URL / handle). ` +
    `PODCASTS / VIDEO CLIPS: an episode or video where the person is just a guest, with no contact channel, is not reachable; ` +
    `set is_relevant false. ` +
    `PRIVATE INDIVIDUALS: never extract a private person in a personal-life moment (a bride/engaged couple, new parent, ` +
    `patient, homebuyer) found via social groups, forums, or personal posts — that is not a legitimate outreach target; ` +
    `set is_relevant false. Professionals, businesses, organizations, and public-facing creators are valid targets. `;

  // Fit / alignment section, this is the part that differs by mode.
  const jobsRules =
    `JOB / INTERNSHIP SEARCH, BOTH openings AND fittable employers count. A SPECIFIC OPEN POSTING the user can apply to is ` +
    `the BEST kind of result: set is_listing true, put the direct application / posting link in url, name it as the ROLE at ` +
    `the COMPANY, and give it the HIGHEST fit_score. A real COMPANY in the user's field even with NO public listing is also ` +
    `valid (is_listing false): the user will send a proactive note asking to be considered, so target_type "organization" is ` +
    `fully valid, do NOT set is_relevant false just because there's no posted role or named person. Reject only advice/how-to/listicle content, dead links, and companies clearly outside the industries the GOAL ` +
    `allows; when the GOAL says other industries are welcome, industry is NOT a filter and a solid employer in any field ` +
    `counts. SCARCITY RESCUE: when live postings run thin, do NOT come back nearly empty; return fittable employers with a ` +
    `contact route for a proactive cold note instead, with why_it_fits saying plainly that this is an employer to approach, ` +
    `not a confirmed opening. ACCESSIBILITY OVER PRESTIGE: strongly prefer small companies, startups, studios, boutiques, and local firms, ` +
    `they are realistic to hear back from. If the GOAL text says to favor beginner-friendly / small / less-selective ` +
    `employers, give ultra-selective, famous, big-name targets a LOW fit_score even when they're on-industry. WHY_IT_FITS: a ` +
    `specific true detail about the COMPANY (what they do, their size/stage, why they'd be a good place for someone at the ` +
    `user's level) or about the specific role, never phrased in terms of the sender's own resume. REACHABILITY: favor ` +
    `results that expose a contact route (careers/contact page, an email, a named recruiter or team member). ` +
    `PREFER THE ACTUAL EMPLOYER over a job-board aggregator: a specific company's own site is much better than a ` +
    `ZipRecruiter / Indeed / LinkedIn-Jobs / Glassdoor / BuiltIn search or aggregate listing page (which is a list of many ` +
    `jobs, not one reachable employer), give those aggregate list pages a low fit_score. EXCEPTION, CURATED NICHE BOARDS: ` +
    `a trade magazine's marketplace or an industry job page where each posting names its own organization and a direct ` +
    `contact is GOLD, not an aggregator. There, make the best fitting posting the main result and put EVERY other posting ` +
    `that fits the GOAL in more_postings, one entry per posting, each with its own org and contact; missing even one ` +
    `fitting posting on such a page is a miss. ${TUNABLE_LOCATION_ALIGNMENT_CLAUSE} ` +
    `NAMED EMPLOYER OVERRIDE: if the GOAL names a specific company or organization (e.g. "openings at Universal"), the user ` +
    `has chosen that employer deliberately — a real opening at that company or any of its divisions/subsidiaries/imprints is ` +
    `exactly what they asked for. For those results, IGNORE the accessibility-over-prestige preference and do NOT penalize ` +
    `size, fame, or selectivity; and unless the GOAL also names a location, treat a location mismatch as SOFT (moderate ` +
    `fit_score, mention the location in why_it_fits) instead of applying the hard location ceiling above — the user asked ` +
    `for this employer's openings, not openings near them. Results at OTHER companies remain subject to all the usual rules. ` +
    `PEOPLE ARE NOT OPPORTUNITIES: a bare individual's profile or bio (a LinkedIn profile, a staff ` +
    `page, a coordinator, someone who merely WORKS somewhere) is not something the user can apply to; set is_relevant false ` +
    `unless the person is a recruiter or hiring manager tied to a live opening (then name the OPENING, with the person as its ` +
    `contact) or the GOAL explicitly asks for people to reach out to. Every result must be an opening or an employer. ` +
    `fit_score: 0.7+ for an on-industry, accessible employer with a contact route; lower it for big/ultra-competitive names ` +
    `when the user wants accessible ones, for aggregator list pages, and for results missing any contact route; below 0.3 ` +
    `only when clearly off-industry. ` +
    ELIGIBILITY_AND_CRITERIA_CLAUSE;
  const fitRules = prospecting
    ? `TARGET DEFINED BY THE GOAL, NOT THE USER'S FIELD: the user is prospecting, finding external ${noun || "target"}s to ` +
      `pitch, sell to, partner with, or raise from. Do NOT reject a result for being in a different industry than the user. ` +
      `The GOAL states the target profile (size, type, stage, location if any); judge fit against THAT, and ignore the user's ` +
      `own field entirely for filtering. WHAT'S BEING OFFERED comes from ABOUT's actual description of the product/service/ ` +
      `project (even one sentence naming it), the USE CASE label is only a category for this search, never assume it IS ` +
      `the offering (e.g. a "Music PR" use case prospecting for a software tool's customers is selling that tool, not music ` +
      `services, do not bias fit or why_it_fits toward buyers of music-related things just because of the USE CASE label). ` +
      (anyIndustry
        ? `The user has said ANY INDUSTRY is fine, so industry is NOT a filter at all, a bakery, a law firm, and a game studio ` +
          `are all equally valid if they otherwise match the goal. `
        : `Match the target types the goal describes. `) +
      (anywhere
        ? `The user has said the target can be ANYWHERE, so do NOT penalize location. `
        : `LOCATION: only penalize fit_score if the GOAL specifies a location and this result is clearly elsewhere. `) +
      `REACHABILITY MATTERS MOST: since the user needs to actually contact these targets, favor results that expose a way in ` +
      `(a company contact page, an email, a phone number, a named person). A real company with a contact route is a strong ` +
      `fit even in an unrelated industry. REQUIRED CHANNELS: if the GOAL says it needs specific contact channels (e.g. "a phone ` +
      `number", "an email", "a website"), treat those as hard preferences, capture each one that appears (contact_phone, ` +
      `contact_email, url for the website) and give a clearly higher fit_score to results that expose ALL the requested ` +
      `channels, a lower one to results missing some. WHY_IT_FITS: explain why the SENDER's OFFERING (from ABOUT) is a fit for ` +
      `THIS company and give 1-2 CONCRETE use cases, i.e. specific ways this particular company could use what the sender offers, ` +
      `grounded in a true detail about the target's own business (what they do, size/stage, recent growth). Format like: ` +
      `"[true detail about the company], so [the product] could [specific use case for them]". Keep it concrete and tailored, ` +
      `not generic. FORBIDDEN: never phrase why_it_fits in terms of the SENDER's background, employer, career, or industry, do not ` +
      `write things like "a good fit given the sender's X experience" or reference the sender's field/employer at all; if ` +
      `the target's own details don't stand on their own, describe the target's business and a plausible use case instead, or leave why_it_fits empty. ` +
      `fit_score: how well the target matches the GOAL's stated criteria; give 0.7+ to clear matches with a contact route, ` +
      `0.4-0.7 to plausible matches missing a contact detail, below 0.3 only when it clearly is not the kind of target the ` +
      `goal describes. Do NOT lower fit_score just because the industry differs from the user's. ` +
      ELIGIBILITY_AND_CRITERIA_CLAUSE
    : jobs
    ? jobsRules
    : `${TUNABLE_INDUSTRY_ALIGNMENT_CLAUSE} ` +
      `WHY_IT_FITS DISCIPLINE: a specific true detail about THE PERSON'S OWN work, career, or interests tied to the user's ` +
      `field, not about their employer or program. If you can only describe the program they work at, set is_relevant false. ` +
      `${TUNABLE_LOCATION_ALIGNMENT_CLAUSE} ` +
      `TIME WINDOW ALIGNMENT: if the GOAL specifies a semester or year and the posting is clearly for a different window, set ` +
      `is_relevant false, but only when the source explicitly says the wrong window. ` +
      `Reserve fit_score above 0.7 for results matching goal + industry + location; give 0.3 or below when two or more are off. ` +
      ELIGIBILITY_AND_CRITERIA_CLAUSE;

  // Personal calibration wins over the universal baseline above by being the
  // last, most specific instruction, same mechanism coaching/dismissedAdvice
  // already use for drafting. Sourced fresh per request from THIS user's own
  // deny data (see buildPersonalOverride in lib/autotune.ts); never touches
  // shared code, unlike the universal auto-tune cron.
  // The Discovery Planner's blueprint makes fit scoring principled: reject on a
  // violated hard requirement or an excluded target, reward opportunity signals,
  // and weight the score by the plan's ranking factors.
  const planFit = plan
    ? ` DISCOVERY BLUEPRINT for this goal — judge fit against it. ` +
      (plan.required.length || plan.hard_constraints.length
        ? `MUST be true (set is_relevant false if any is clearly violated): ${[...plan.required, ...plan.hard_constraints].join("; ")}. `
        : "") +
      (plan.negative_constraints.length
        ? `EXCLUDE (is_relevant false if it matches): ${plan.negative_constraints.join("; ")}. `
        : "") +
      (plan.opportunity_signals.length
        ? `Raise fit_score for targets showing these opportunity signals (a good time to reach out): ${plan.opportunity_signals.join("; ")}. `
        : "") +
      (plan.ranking_factors.length
        ? `Weight fit_score by these factors: ${plan.ranking_factors
            .map((f) => `${f.factor} (${Math.round(f.weight * 100)}%)`)
            .join(", ")}. `
        : "")
    : "";
  // Belt-and-suspenders: if the plan still carries any industry wording (a stale
  // plan, or the planner disobeying), neutralize it when the user accepts any
  // industry, so planFit can't reject an off-field target for its industry.
  const industryOverride =
    anyIndustry && plan
      ? ` INDUSTRY OVERRIDE: the user accepts ANY industry. If any requirement, constraint, or exclusion above refers to an industry, sector, or field, IGNORE that part — never set is_relevant false or lower fit_score because the target's industry differs from the user's or from those terms. Judge only size, type, reachability, timing, and the goal's non-industry criteria.`
      : "";
  const sys =
    core + fitRules + TRANSIENT_PRESENCE_CLAUSE + planFit + industryOverride +
    (personalOverride ? `\n\n${personalOverride}` : "");
  const fields =
    `Fields: is_relevant (bool), target_type (one of "person", "organization", "other", use "other" for any article/guide/advice/listicle), ` +
    `is_listing (bool: true ONLY when this result is a specific open job/internship posting the user can apply to, with the application/posting link in url; false for a company, a person, or anything else), posting_window (string, ONLY when the source states when this org opens or posts roles, e.g. "Opens each January", "Recruits every fall", "Apply by March 1"; omit otherwise), more_postings (array, ONLY when this SAME page lists SEVERAL distinct fitting postings, each for a different organization or with its own contact — a niche job board, a trade magazine's marketplace: up to 6 additional postings besides the main result, each {"name" (ROLE at ORG), "outlet" (the org), "contact_email", "contact_name", "url" (direct link or this page), "location", "why_it_fits", "fit_score"}; NEVER duplicate the main result, and only include postings that genuinely fit the GOAL; omit otherwise), ` +
    `name (WHO this find is — when the target is a specific named individual, this MUST be that PERSON'S name, e.g. "Stacy Blythe" or "Stacy Blythe, EVP of Promotion", NEVER the company, page headline, or article title like "Big Loud Records, Executive Promotions & Hires". If a real person is named anywhere as the target or the point of contact, title the find by them and put their employer in outlet. Use a company/organization name here ONLY when there is genuinely no specific person), outlet (org/company/publication), ` +
    `channel (how to reach them: one of Email, LinkedIn, Website Form, Company Portal, Phone, Unknown — this is a LABEL for the route, and on its own it is not a way to reach anyone: a result whose only contact information is a channel of "Website Form" or "Company Portal" is DROPPED before the user ever sees it, so spend the effort finding a real address, number, or handle in the source and put it in the fields below), ` +
    `contact_email, contact_name (a named person if shown), contact_role, contact_handle (a LinkedIn URL or @handle), ` +
    `contact_phone (a phone number ONLY if it appears verbatim in the result, for local businesses / lead-gen this is often listed; leave empty otherwise, never invent one), ` +
    `socials (an array of the TARGET'S OWN social profile URLs that appear verbatim in the source — Instagram, Facebook, LinkedIn, TikTok, X/Twitter, YouTube, Threads, SoundCloud, Spotify — up to 6; return the full URLs exactly as shown, never guess or construct a handle that is not printed, empty array if none), ` +
    `url (the TARGET'S OWN primary home — their official website, or their main profile page / LinkedIn if they have no website — NOT the news article, press piece, directory, or listicle you found them through. NEVER a review/directory listing (Yelp, YellowPages, BBB, Mapquest, TripAdvisor and the like) and NEVER a page that merely mentions their name in its URL or title while actually being about something else entirely; when the only link you have is one of those, leave url EMPTY. That evidence belongs in the source, never here), location, ` +
    `timezone (the IANA timezone for their location, e.g. "America/Chicago" for Nashville TN, "Europe/London" for London; empty if the location is unknown or remote/global), ` +
    `fit_score (0 to 1, follow the fit-scoring rules above exactly; do not apply extra industry alignment beyond what those rules say), ` +
    `components (an object grading WHY this is a good opportunity, each 0 to 1: {relevance = how squarely they match the ` +
    `goal/target profile — apply every fit-scoring rule above, INCLUDING any hard ceilings, to relevance exactly as you ` +
    `do to fit_score. COVERAGE: first count the DISTINCT requirements the goal actually asks for — each role or skill, ` +
    `each availability or schedule condition, each location or logistical condition — then score relevance by the ` +
    `FRACTION of them this candidate demonstrably meets, never by how strongly it meets the one it happens to match. ` +
    `Meeting one requirement out of four is roughly 0.25, not 0.6, however good that single match looks: a goal asking ` +
    `for several things at once is asking for someone who is ALL of them, and a candidate answering one facet is a long ` +
    `shot worth showing honestly, not a good fit. Be harshest where the goal names a combination that is rare or ` +
    `self-contradictory — that is precisely when a partial match is most tempting to overrate. An ORGANIZATION offered ` +
    `where the goal asked for a PERSON is a partial match by construction (a lead on where such a person might be ` +
    `found, not the person): cap it at 0.35 unless it also satisfies the goal's other stated requirements. Operating in ` +
    `a field the goal merely mentions is not a requirement met; timing = whether NOW is a good moment to reach out based on recent/upcoming events (funding, ` +
    `hiring, a launch/release, a tour stop, a conference, a new role) — 0.5 when neutral/unknown; momentum = how active ` +
    `and in-motion they are right now (recent press, posts, growth, output)}), ` +
    `signals (an array of up to 5 SHORT concrete evidence phrases that justify the scores and answer "why now / why them", ` +
    `each true and drawn from the source, e.g. "recently raised a seed round", "hiring a marketing lead", "new album out ` +
    `this month", "public booking email", "speaking at a conference"; empty if none), ` +
    `why_it_fits (one specific, true detail used to personalize outreach, follow the WHY_IT_FITS rule above exactly for what it should describe; empty if unknown).`;
  const ctx =
    `USER'S USE CASE: ${useCase}\nUSER GOAL: ${goal}\nABOUT THE USER: ${about}`;
  const learned =
    feedbackBlock(feedback, goal) +
    (anyIndustry && feedback
      ? "\n\nNOTE: the user wants results spanning MANY industries. Treat the kept/denied examples above as signals about " +
        "outreach FIT and quality only, NOT about industry. Do NOT lower fit_score or set is_relevant false just because a " +
        "result's industry differs from those examples — a different industry is exactly what the user wants here."
      : "");
  const user =
    `${ctx}\n${fields}${learned}\n\nSEARCH RESULT:\nTitle: ${cand.title || ""}\nURL: ${cand.url || ""}\nContent: ${String(cand.content || "").slice(0, 2800)}`;
  try {
    return parseJsonLoose(await claudeJson(sys, user));
  } catch (e) {
    if (e instanceof ApiCreditError) throw e; // credits/auth/limit, don't swallow
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
  useCase: string,
  // "creators": social-roundup articles (original behavior; members need a
  // handle/email to be worth keeping since socials are the only route in).
  // "container": the INVESTIGATOR HOP (Phase 2) — lineups, speaker lists,
  // rosters, schedules. Members are kept even with NO contact route, because
  // the page itself is the evidence ("appearing at X on date Y") and the
  // downstream contact-enrichment hop chases their emails afterwards.
  mode: "creators" | "container" = "creators"
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
  const sys = mode === "container"
    ? `You are a research assistant reading a CONTAINER page that lists multiple real people — a festival lineup, ` +
      `conference speaker list, event schedule, panel, artist roster, or member directory. Extract the people on it ` +
      `who genuinely fit the user's GOAL — up to 8, best matches first, never filler. Return ONLY a JSON object with ` +
      `a "people" array, no prose. Each element: {name (the person's real name), handle (a social/profile URL or ` +
      `@handle ONLY if shown on the page; empty otherwise — do not invent), email (only if listed verbatim; empty ` +
      `otherwise), role (who they are: "indie-folk artist", "A&R at X", "keynote speaker"), outlet (their band, ` +
      `company, or affiliation if shown), location (if mentioned), why_it_fits (cite the CONTAINER EVIDENCE — what ` +
      `this page proves about them, e.g. "performing at Riverfront Fest March 14" or "speaking on the sync-licensing ` +
      `panel", plus any detail about the person; this evidence is exactly why they match), fit_score (0..1 against ` +
      `the GOAL: presence on this page is strong evidence when the page itself matches the goal's event/place/time), ` +
      `channel (one of "Email", "Instagram", "TikTok", "YouTube", "X", "LinkedIn", "Website Form", "Unknown" — ` +
      `"Unknown" is fine, contacts are chased separately)}. A person with no contact on the page is still a KEEPER ` +
      `here. Skip organizers/venues/staff unless the goal wants them; skip anyone the goal's constraints exclude.`
    : `You are a research assistant reading a curated ROUNDUP article that lists multiple real social creators / ` +
    `influencers. Extract EVERY named creator from the article that fits the user's GOAL. Return ONLY a JSON ` +
    `object with a "people" array, no prose. Each element: {name (their real name or handle if that's all shown), ` +
    `handle (their @handle or full social URL, e.g. instagram.com/example, tiktok.com/@example, ` +
    `youtube.com/@example, prefer the platform the user's GOAL implies), email (only if the article lists a ` +
    `direct contact email; leave empty otherwise), role (what they do / niche: "beauty creator", "food TikToker", ` +
    `etc.), outlet (the platform they're mostly on or their brand), location (city or country if the article ` +
    `mentions it), why_it_fits (one specific true detail about THIS creator's own content or angle from the ` +
    `article, not the article's premise; empty if unknown), fit_score (0..1 how well this specific creator ` +
    `matches the goal), channel (one of "Instagram", "TikTok", "YouTube", "X", "Email", "Website Form", ` +
    `"Unknown", pick the platform their handle points at)}. Never invent handles or emails; if the article ` +
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
      // Creators need at least a name AND some way to reach them (handle or
      // email) — socials are the only route in. CONTAINER members are kept on
      // name alone: the page itself is the evidence, and the contact-enrichment
      // hop chases a route afterwards.
      if (!name) continue;
      if (mode === "creators" && !handle && !String(p?.email || "").trim()) continue;
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
  plan?: GoalPlan | null; // the Discovery Planner's blueprint for this search
  // Set for a job/internship search when real open postings were thin, so the
  // results are mostly good-fit COMPANIES to approach proactively, not confirmed
  // openings. The UI shows this so we never disguise cold outreach as live jobs.
  notice?: string;
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
  // lib/autotune.ts), takes priority over the universal baseline by being
  // appended last to both the query planner and the extractor's prompts.
  personalOverride?: string,
  // Streaming + cancellation: onOpp fires as each find is confirmed (so the
  // route can stream partial results), and signal lets the caller stop the
  // search early — the user cancels mid-run but keeps what was already scouted,
  // and no further Tavily/Claude calls are spent.
  opts?: {
    onOpp?: (o: Opportunity) => void;
    onProgress?: (msg: string) => void;
    signal?: AbortSignal;
    plan?: GoalPlan | null;
    // Shared people-index lookup (see lib/peopleIndex). Returns a SMALL salted
    // slice of previously-verified people shaped like search results; they are
    // appended to the candidate pool and must re-earn their place through the
    // same extraction, fit scoring, and exposure caps as fresh candidates.
    // Kept as an injected function so the engine stays storage-agnostic.
    indexLookup?: (goal: string) => Promise<{ title: string; url: string; content: string }[]>;
    // Company-index lookup (see lib/companyIndex): known employers matching
    // this goal, so job hunts hit careers pages, not gated boards.
    companiesLookup?: (goal: string) => Promise<{ name: string; host: string }[]>;
  }
): Promise<DiscoverResult> {
  const aborted = () => !!opts?.signal?.aborted;
  const emit = (m: string) => {
    try {
      opts?.onProgress?.(m);
    } catch {
      /* progress is best-effort, never break the search */
    }
  };
  // Step 1: decompose the goal into an evidence-first blueprint (best-effort;
  // falls back to plain query planning if it fails). Reuse a plan the caller
  // already computed (the pre-search "understanding" step) so we don't pay for
  // it twice. Step 2: plan queries from it. Step 3+: gather + extract.
  const plan =
    opts?.plan ?? (await decomposeGoal(goal, about, useCase, personalOverride).catch(() => null));
  // The index is a compass as well as a source: organizations it has already
  // verified for goals like this one are worth searching DIRECTLY, and a
  // dated posting it saw last cycle ("Summer 2027 internship") means the next
  // cycle is what to hunt now. Turn a small index sample into planning
  // guidance; the entries themselves still join the candidate pool later
  // under the same caps as always.
  let indexCompass = "";
  if (opts?.indexLookup && !aborted()) {
    try {
      const known = await opts.indexLookup(goal);
      if (known.length) {
        const year = new Date().getFullYear();
        const orgs = Array.from(
          new Set(
            known
              .map((r) => String(r.title || "").split(/[|·–-]/)[0].trim())
              .filter((t) => t && t.length > 2)
          )
        ).slice(0, 6);
        const dated = known.filter((r) => /\b(20\d{2}|summer|fall|spring|winter)\b/i.test(r.title));
        indexCompass =
          "KNOWN FROM PAST VERIFIED SEARCHES (use as a compass): these organizations previously matched goals like this " +
          `one: ${orgs.join("; ")}. Write one or two queries that go straight at them for their CURRENT openings or ` +
          `pages. ${
            dated.length
              ? `Some past matches were dated postings (a season or year in the title); recurring programs repeat every cycle, so search for the ${year} and ${year + 1} editions by name, not the old year. `
              : ""
          }CADENCE EDGE: entries noting a hiring cadence or months when live postings were seen tell you WHEN each org ` +
          `posts. It is ${new Date().toLocaleString("en-US", { month: "long" })} now; if an org's window is open or ` +
          `about to open, write a query straight at its live postings, being first to catch a fresh posting is the ` +
          `whole edge. Never let these crowd out fresh discovery; the rest of the queries explore as usual.`;
      }
    } catch {
      /* compass is optional */
    }
  }

  const queries = await planQueries(
    goal,
    about,
    useCase,
    feedback,
    salt,
    cohortHint,
    [personalOverride, indexCompass].filter(Boolean).join("\n\n"),
    false,
    plan
  );
  if (plan?.target_type)
    emit(`Read the goal: looking for ${plan.target_type.toLowerCase()}${plan.goal ? ` — ${plan.goal}` : ""}`);
  emit(`Planned ${queries.length} search${queries.length === 1 ? "" : "es"} across the web`);

  // Careers-page strategy: gated boards (LinkedIn, Handshake, Indeed) hide
  // postings behind logins, but employers' OWN sites are open. For job-ish
  // goals, add direct careers-page queries for a salted handful of companies
  // the index already knows fit goals like this one. The list grows itself:
  // every organization any search finds joins it.
  if (opts?.companiesLookup && isJobSearch(useCase, goal) && !aborted()) {
    try {
      const known = await opts.companiesLookup(goal);
      const roleWords = goal
        .toLowerCase()
        .match(/\b(intern(ship)?s?|marketing|publishing|a&r|engineer(ing)?|design(er)?|analyst|assistant|coordinator|producer|social media|sales)\b/g);
      const hint = Array.from(new Set(roleWords || [])).slice(0, 3).join(" ");
      const careersQueries = known.slice(0, 4).map((c) =>
        c.host
          ? `site:${c.host} careers OR jobs ${hint}`.trim()
          : `"${c.name}" careers current openings ${hint}`.trim()
      );
      if (careersQueries.length) {
        emit(
          `Adding the careers pages of ${careersQueries.length} employer${
            careersQueries.length === 1 ? "" : "s"
          } Scout already knows fit goals like this`
        );
        queries.push(...careersQueries);
      }
    } catch {
      /* the index is an accelerant, never a blocker */
    }
  }
  const networking = isNetworkingUseCase(useCase);
  // Skip anyone the user denied by name, never resurface a rejected find,
  // EXCEPT timing-only denies ("no open positions"): those stay watchable so
  // they can come back the moment something opens (see feedbackBlock).
  if (feedback) feedback.reopenCheckIn = Math.random() < 0.34;
  const deniedNames = new Set(
    (feedback?.avoid || [])
      .filter((a) => !isTimingDenyReason(a.reason))
      .map((a) => normName(a.name))
      .filter(Boolean)
  );

  // Per-candidate log of what got skipped and why. Populated at every skip
  // point below so the UI can show a "See what was filtered" panel.
  const skipped: SkippedCandidate[] = [];
  const logSkip = (title: string, url: string, reason: string) => {
    // Cap so a huge candidate pool doesn't balloon the response.
    if (skipped.length < 60) skipped.push({ title: title || "", url: url || "", reason });
    // Stream the interesting rejections (fit calls) live, not the plumbing
    // (duplicates, dead links, obvious advice pages).
    if (!/duplicate|no usable URL|already on |advice \/ how-to|podcast episode|listicle/i.test(reason))
      emit(`Skipped ${title || "a result"}: ${reason}`);
  };

  // Creator/social searches lean entirely on roundup articles, so pull more
  // candidates per query and crawl each page deeper, advanced depth returns
  // richer content, which is exactly what the multi-person listicle extractor
  // reads to pull many creators out of one article. Everything else stays on
  // the cheaper basic depth.
  const creatorSearch = isSocialCreatorSearch(useCase, goal);
  // Pull more pages per query so the net is wide enough to reliably reach the
  // ~10 target even when many candidates get filtered out.
  const perQuery = creatorSearch ? 10 : 10;
  const depth: "basic" | "advanced" = creatorSearch ? "advanced" : "basic";

  // Late passes (the scarcity rescue) relax the extraction bar by appending
  // to this override; the main pass runs with the plain personal override.
  let extractOverride = personalOverride;
  // Which pass is currently extracting; stamped onto every accepted opp so
  // the admin can measure each pass's keep rate against real user decisions.
  let currentPass: "specific" | "broadened" | "rescue" = "specific";

  // 1+2: gather + dedupe candidate pages. Wrapped so a broadening retry can
  // append a fresh batch of candidates from wider queries when the first pass
  // comes up empty.
  const candidates: TavilyResult[] = [];
  const seenLinks = new Set<string>();
  async function gather(passQueries: string[], scope?: { includeDomains: string[] }) {
    // Collect each query's surviving results into its own bucket, then INTERLEAVE
    // them round-robin into `candidates`. Extraction reads candidates in order and
    // stops at maxItems, so a sequential fill let the first query (the raw goal,
    // which for an "any industry" search returns whatever Tavily ranks top — one
    // industry) dominate the front and the later, deliberately-diverse industry
    // queries never got reached. Round-robin guarantees every query — and so every
    // industry angle — lands near the front and makes it into the results.
    const buckets: TavilyResult[][] = [];
    for (const q of passQueries) {
      if (aborted()) break; // user cancelled — stop spending searches
      const bucket: TavilyResult[] = [];
      // The first query is the raw goal plus every clarifying answer, a full
      // paragraph; echoing it verbatim made the progress log an unreadable
      // wall. Show a clipped label and never repeat it on the result line.
      const qLabel = q.length > 72 ? `${q.slice(0, 72).trim()}…` : q;
      emit(`Searching: ${qLabel}`);
      const results = await tavilySearch(q, perQuery, {
        depth,
        ...(scope?.includeDomains ? { includeDomains: scope.includeDomains } : {}),
      });
      emit(`Found ${results.length} result${results.length === 1 ? "" : "s"}`);
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
        seenLinks.add(k); // global dedupe as we collect
        // Machine-readable line for the client's "flipping through sites"
        // deck; friendlyProgress hides it from the step list.
        emit(`@site ${(r.url.match(/^https?:\/\/([^\/?#]+)/i) || [])[1] || ""}|${(r.title || "").slice(0, 80)}`);
        bucket.push(r);
      }
      buckets.push(bucket);
    }
    // Wider candidate pool (was 4x) so a heavily-filtered search still surfaces
    // close to the full ~10, casting a broad first net to learn what fits.
    const cap = maxItems * 6;
    const depthMax = Math.max(0, ...buckets.map((b) => b.length));
    for (let col = 0; col < depthMax && candidates.length < cap; col++) {
      for (const b of buckets) {
        if (col < b.length) {
          candidates.push(b[col]);
          if (candidates.length >= cap) break;
        }
      }
    }
  }
  await gather(queries);

  // ---- Platform sweeps -------------------------------------------------
  // Ordinary web search ranks articles ABOUT people above the people
  // themselves, so profile pages get buried. These extra passes are scoped to
  // one platform at a time, which forces the index to hand back profiles.
  // Everything here is the search index's PUBLIC view of those sites: no
  // logins, no gated data, none of the ban/ToS exposure of scraping a session.
  // Each sweep's results flow through the same extraction, fit scoring,
  // location rules, and cross-user exposure caps as any other candidate.
  const sweepPlan = platformSweeps(goal, useCase, about);
  if (sweepPlan.length && !aborted()) {
    // Same query text every time, only the domain scope changes, so a sweep is
    // one cheap extra query per platform rather than a whole new search plan.
    const sweepQueries = Array.from(
      new Set([goal.replace(/\s+/g, " ").trim().slice(0, 220), ...queries.slice(0, 1)])
    ).slice(0, 2);
    for (const sweep of sweepPlan) {
      if (aborted()) break;
      emit(`Sweeping ${sweep.label}`);
      await gather(sweepQueries, { includeDomains: sweep.domains });
    }
  }

  // ---- Licensed roster pass ---------------------------------------------
  // The open web only knows the people who left a public trace. When a goal
  // names a hard filter a person-directory can match exactly (a school, an
  // employer, a title), the directory can supply the rest of the roster.
  //
  // Spend rule, both halves of it:
  //   ONLY when necessary, the directory is skipped entirely for goals with no
  //   hard filter, and every distinct roster is fetched once and then served
  //   from cache, so repeat asks cost nothing.
  //   ALWAYS when necessary, it runs whenever the goal IS roster-shaped and the
  //   open web did not already produce a comfortable pool, and it runs again as
  //   a rescue below if extraction still comes up short.
  let rosterFilters: PdlFilters | null = null;
  let rosterUsed = false;
  const consultDirectory = async (want: number) => {
    if (!pdlEnabled() || rosterUsed || aborted()) return;
    try {
      if (rosterFilters === null) rosterFilters = await goalToPdlFilters(goal);
      if (!rosterFilters) return; // no hard filter, the web is the right tool
      const { people, total, cached } = await pdlRosterCached(rosterFilters, want);
      if (!people.length) return;
      rosterUsed = true;
      emit(
        `Checking the people directory (${total.toLocaleString()} match this profile${cached ? ", from cache" : ""})`
      );
      for (const c of pdlPeopleAsCandidates(people)) {
        if (c.url && candidates.some((x) => x.url === c.url)) continue;
        candidates.push(c);
      }
    } catch {
      /* the directory is an extra source, never a dependency */
    }
  };
  // The web pass is the default source; consult the directory when it did not
  // return a comfortable pool of its own (or returned nothing at all).
  if (candidates.length < maxItems * 2) {
    await consultDirectory(Math.min(12, Math.max(4, maxItems)));
  }

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

  // ---- Investigator hop (Phase 2) ----
  // A CONTAINER page (lineup, speaker list, roster, schedule) is often the best
  // evidence a person-seeking goal will ever get — but the single extractor
  // turns it into one mediocre find. Fan it out instead: pull the members who
  // fit the goal (contact or not; enrichment chases contacts afterwards).
  // Budgeted: at most 3 container pages per run so a directory-heavy result set
  // can't eat the whole time budget.
  const personSeeking =
    /person|artist|creator|founder|speaker|journalist|investor|host|professor|musician|expert|author/i.test(
      plan?.target_type || ""
    ) || isNetworkingUseCase(useCase);
  const looksLikeContainer = (title: string) =>
    /\b(line-?up|speakers?|performers?|panelists?|roster|exhibitors?|schedule|program|artists (announced|list|playing)|who'?s (playing|speaking)|guest list|directory of)\b/i.test(
      title || ""
    );
  let containerBudget = 3;
  const isContainer = (c: TavilyResult) => {
    if (creatorSearch || !personSeeking || containerBudget <= 0) return false;
    return looksLikeContainer(c.title || "");
  };

  // Extract in small parallel batches so the spike is reasonably fast. Wrapped
  // as a function taking a start index so a broadening retry can process only
  // the freshly-gathered candidates instead of re-extracting the first pass.
  const batchSize = 4;
  async function extractFrom(start: number) {
  for (let i = start; i < candidates.length && opps.length < maxItems; i += batchSize) {
    if (aborted()) break; // user cancelled — keep what's extracted so far
    const batch = candidates.slice(i, i + batchSize);
    const rawResults = await Promise.all(
      batch.map(async (c) => {
        if (isListicle(c)) {
          const people = await extractMultiplePeople(c, goal, about, useCase);
          return { multi: true as const, people, cand: c };
        }
        if (isContainer(c)) {
          containerBudget--;
          emit(`Opening the list on "${String(c.title || "").slice(0, 60)}"…`);
          const people = await extractMultiplePeople(c, goal, about, useCase, "container");
          if (people.length)
            emit(`Pulled ${people.length} ${people.length === 1 ? "person" : "people"} from that list`);
          return { multi: true as const, people, cand: c };
        }
        const rec = await extract(c, goal, about, useCase, feedback, extractOverride, plan);
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
        // A curated board page can carry several fitting postings beyond the
        // main result; each becomes its own record, sharing the page as its
        // source and exempt from host-dedup like listicle members.
        const extra = Array.isArray((r.rec as any)?.more_postings)
          ? (r.rec as any).more_postings.slice(0, 6)
          : [];
        for (const mp of extra) {
          if (!mp || !mp.name) continue;
          flat.push({
            rec: {
              isRelevant: true,
              __member: true,
              is_listing: true,
              name: String(mp.name),
              outlet: String(mp.outlet || ""),
              contact_email: String(mp.contact_email || ""),
              contact_name: String(mp.contact_name || ""),
              contact_role: "",
              location: String(mp.location || ""),
              url: String(mp.url || r.cand.url || ""),
              why_it_fits: String(mp.why_it_fits || ""),
              fit_score: typeof mp.fit_score === "number" ? mp.fit_score : 0.6,
              target_type: "listing",
            } as any,
            cand: r.cand,
          });
        }
        if (extra.length)
          emit(`That page lists ${extra.length + 1} fitting postings, keeping them all`);
        continue;
      }
      if (!r.people.length) {
        // The listicle extractor said "no reachable creators here", log it as
        // a skip so it's visible in the filter panel, don't retry with the
        // single-person extractor.
        logSkip(r.cand.title, r.cand.url, "listicle produced no reachable creators");
        continue;
      }
      for (const p of r.people) {
        // Downstream reads raw snake_case fields off the extracted record;
        // mirror that shape so the multi-person path drops in cleanly.
        // __member marks a multi-extracted person: their "host" is the shared
        // roundup/lineup page, which is EVIDENCE, not identity — so they're
        // exempt from host-dedup (otherwise every member after the first gets
        // dropped as "another find already on {host}").
        flat.push({
          rec: {
            isRelevant: true,
            __member: true,
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
      // channel, there's no real way to reach them, skip. Company Portal / staff
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
      const emailKey = normEmail(r.contact_email || "");
      // A social/profile URL is itself an identity (linkedin.com/in/x, etc.).
      const urlKey = normHandle(r.url || "");
      const host = urlHost(r.url || cand.url);
      if (nm && deniedNames.has(nm)) {
        skippedDupes++;
        logSkip(cand.title, cand.url, `you denied "${r.name}" before`);
        continue; // already rejected this exact one before
      }
      // ---- Entity resolution ----
      // Decide whether this record is the SAME entity as one we already have.
      // Strong keys (email / social handle / profile URL) match confidently. A
      // same-name match is accepted too, but ONLY when nothing contradicts it
      // (two "John Smith"s with different emails or different handles are treated
      // as different people, not merged).
      const dupIdx = opps.findIndex((o) => {
        const oEmail = normEmail(o.contactEmail);
        const oHandle = normHandle(o.contactHandle);
        const oUrlKey = normHandle(o.url);
        if (emailKey && oEmail && emailKey === oEmail) return true;
        if (handleKey && (handleKey === oHandle || handleKey === oUrlKey)) return true;
        if (urlKey && (urlKey === oHandle || urlKey === oUrlKey)) return true;
        if (nm && normName(o.name) === nm) {
          const emailConflict = !!emailKey && !!oEmail && emailKey !== oEmail;
          const handleConflict =
            !!handleKey && !!oHandle && handleKey !== oHandle && handleKey !== oUrlKey;
          return !emailConflict && !handleConflict;
        }
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
        // Accumulate this source (skip an identical URL).
        if (newRef.url && !existing.sources.find((s) => s.url === newRef.url)) {
          existing.sources.push(newRef);
        }
        // Merge evidence: fill gaps, and UPGRADE a generic inbox to a real
        // personal email when a later source surfaces one.
        if (
          r.contact_email &&
          (!existing.contactEmail ||
            (!isPersonalEmail(existing.contactEmail) && isPersonalEmail(r.contact_email)))
        ) {
          existing.contactEmail = r.contact_email;
          existing.contactSource = { title: cand.title || "", url: cand.url || "" };
          if (r.contact_name && !existing.contactName) existing.contactName = r.contact_name;
        }
        if (!existing.contactHandle && r.contact_handle) existing.contactHandle = r.contact_handle;
        if (!existing.contactRole && r.contact_role) existing.contactRole = r.contact_role;
        if (!existing.contactPhone && r.contact_phone) existing.contactPhone = r.contact_phone;
        if (!existing.contactName && r.contact_name) existing.contactName = r.contact_name;
        if (!existing.location && r.location) existing.location = r.location;
        if (!existing.outlet && r.outlet) existing.outlet = r.outlet;
        if (!existing.timezone && r.timezone) existing.timezone = r.timezone;
        // Keep the strongest fit, and the more specific why-it-fits.
        const rFit =
          typeof r.fit_score === "number" ? r.fit_score : parseFloat(r.fit_score);
        if (!isNaN(rFit) && (existing.fitScore == null || rFit > existing.fitScore)) {
          existing.fitScore = rFit;
        }
        const rWhy = noDash(String(r.why_it_fits || "").trim());
        if (rWhy && rWhy.length > (existing.whyItFits || "").length) existing.whyItFits = rWhy;
        // A reachable email upgrades an unreachable channel.
        if (existing.contactEmail && (!existing.channel || /unknown/i.test(existing.channel)))
          existing.channel = "Email";
        emit(`Merged: ${existing.name} now backed by ${existing.sources.length} sources`);
        logSkip(
          cand.title,
          cand.url,
          `merged into "${existing.name}" (now ${existing.sources.length} sources)`
        );
        continue;
      }
      const isMember = !!(r as any).__member;
      if (!isMember && host && knownHosts.has(host)) {
        skippedDupes++;
        logSkip(cand.title, cand.url, `another find already on ${host}`);
        continue;
      }
      if (nm) knownNames.add(nm);
      // Members share their source page's host as evidence, not identity — don't
      // claim it, or the page's remaining members (and its own single-extract
      // result) would be dropped as duplicates.
      if (host && !isMember) knownHosts.add(host);

      let fit = typeof r.fit_score === "number" ? r.fit_score : parseFloat(r.fit_score);
      if (isNaN(fit)) fit = null as any;

      // ---- Computed headline rank (Phase 1: opportunity intelligence) ----
      // Blend the extractor's per-component reads with computed reachability
      // using the tunable weights, instead of trusting one opaque number.
      // Guardrails keep the rules-based behavior the deny data has earned:
      //  - relevance carries every hard rule/ceiling (the prompt says so), and
      //    the headline can never exceed relevance by more than a nudge, so
      //    great timing/reachability can sweeten a match but never rescue a
      //    rule-violating one;
      //  - when the model's rules-based fit is a near-veto (≤0.15), respect it
      //    outright — that's a ceiling clause firing (e.g. wrong location).
      const compRelevance = clamp01(r.components?.relevance);
      const compTiming = clamp01(r.components?.timing);
      const compMomentum = clamp01(r.components?.momentum);
      const compReach = reachabilityFrom(r.contact_email, r.contact_handle, r.contact_phone);
      if (compRelevance != null) {
        const w = rankWeights();
        const weighted =
          w.relevance * compRelevance +
          w.reachability * compReach +
          w.timing * (compTiming ?? 0.5) +
          w.momentum * (compMomentum ?? 0.5);
        // The sweetener is PROPORTIONAL, not flat. The flat +0.2 was rarely the
        // binding constraint — a 62% headline came from the model rating
        // relevance ~0.68, not from the bonus — but once relevance is scored by
        // requirement coverage those numbers land low, and down there the flat
        // version is exactly what props a weak match back up: relevance 0.25
        // blends to 43% on reachability and neutral timing alone. Scaling caps
        // that at 30%, while a strong match is unaffected (0.85 * 1.2 > 1).
        let headline = Math.min(weighted, compRelevance * 1.2);
        if (fit != null && fit <= 0.15) headline = Math.min(headline, fit);
        fit = Math.round(Math.max(0, Math.min(1, headline)) * 100) / 100;
      }

      // Trust the LLM's URL only when we can verify it isn't hallucinated:
      // its host must appear in the source page's content, OR it must sit on
      // the same domain as the Tavily source URL. Otherwise fall back to the
      // real cand.url. Fixes the "Concord Music Publishing → concordgroup
      // insurance.com" style cross-company confusion where the extractor
      // invents a plausible domain from the company name.
      const chosenUrl = sanitizeSiteUrl(
        pickTrustedUrl(String(r.url || ""), cand.url || "", cand.content || ""),
        String(r.contact_email || "")
      );
      opps.push({
        id: `${Date.now()}-${opps.length}`,
        foundPass: currentPass,
        fromIndex: !!(cand as any).__fromIndex,
        // noDash on every LLM-written text field so em/en dashes never show in a
        // find's title, outlet, role, location, or description.
        name: noDash(String(r.name).trim()),
        outlet: noDash(r.outlet || ""),
        url: chosenUrl,
        channel: r.channel || "Unknown",
        contactEmail: r.contact_email || "",
        contactName: noDash(r.contact_name || ""),
        contactRole: noDash(r.contact_role || ""),
        contactHandle: r.contact_handle || "",
        contactPhone: r.contact_phone || "",
        // The page the contact was read from, for verification. Only set when we
        // actually have a contact route to attribute.
        contactSource:
          r.contact_email || r.contact_handle || r.contact_phone
            ? { title: cand.title || "", url: cand.url || "" }
            : undefined,
        socials: Array.isArray(r.socials)
          ? r.socials
              .map((s: any) => String(s || "").trim())
              .filter((s: string) => /^https?:\/\//i.test(s))
              .slice(0, 6)
          : [],
        location: noDash(r.location || ""),
        timezone: r.timezone || "",
        fitScore: fit,
        // Per-signal breakdown (Phase 3). relevance/timing/momentum are the LLM's
        // read; reachability is computed from the contact data we actually hold and
        // is refreshed after Phase 2 enrichment.
        scores: {
          relevance: clamp01(r.components?.relevance) ?? (fit != null ? fit : undefined),
          reachability: reachabilityFrom(r.contact_email, r.contact_handle, r.contact_phone),
          timing: clamp01(r.components?.timing),
          momentum: clamp01(r.components?.momentum),
        },
        signals: Array.isArray(r.signals)
          ? r.signals.map((s: any) => noDash(String(s || "").trim())).filter(Boolean).slice(0, 5)
          : [],
        // A specific open posting is a "listing" (apply); a named contact is a
        // "person"; everything else reachable is a "company" to cold-email.
        targetType: r.is_listing
          ? "listing"
          : String(r.target_type || "").toLowerCase() === "person"
            ? "person"
            : "company",
        whyItFits: noDash(r.why_it_fits || ""), // no em dashes in rendered LLM copy
        postingWindow: noDash(String(r.posting_window || "")).slice(0, 80) || undefined,
        criteria: Array.isArray(r.criteria)
          ? r.criteria
              .map((c: any) => ({
                ask: noDash(String(c?.ask || "")).slice(0, 60),
                answer: noDash(String(c?.answer || "")).slice(0, 80),
              }))
              .filter((c: any) => c.ask && c.answer)
              .slice(0, 5)
          : undefined,
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
      const added = opps[opps.length - 1];
      emit(
        `Kept ${added.name}${added.fitScore != null ? ` — ${Math.round(added.fitScore * 100)}% fit` : ""}`
      );
      opts?.onOpp?.(added); // stream this find to the caller live
    }
  }
  }

  // Blend in a small slice from the shared people index, AFTER the fresh web
  // candidates so the live web stays the majority voice. Capped hard (never
  // more than 6, never more than half the ask) so the index can inform results
  // without homogenizing them across users; each entry still has to pass the
  // same extraction, relevance, fit, and exposure gates as everything else.
  if (opts?.indexLookup && !aborted()) {
    try {
      const idxCap = Math.min(6, Math.max(2, Math.floor(maxItems / 2)));
      const fromIndex = await opts.indexLookup(goal);
      for (const r of fromIndex.slice(0, idxCap)) {
        if (r?.url && candidates.some((c) => c.url === r.url)) continue;
        candidates.push({
          title: r.title || "",
          url: r.url || "",
          content: r.content || "",
          __fromIndex: true,
        } as any);
      }
      if (fromIndex.length) emit("Checking people Scout has verified before");
    } catch {
      /* index is an accelerant, never a dependency */
    }
  }

  await extractFrom(0);

  // Rescue pass: extraction can reject nearly everything the web returned (the
  // "1 find" case). If the goal was roster-shaped and we still have less than
  // half of what was asked for, consult the directory now and extract those.
  if (!aborted() && opps.length < Math.ceil(maxItems / 2) && pdlEnabled() && !rosterUsed) {
    const before = candidates.length;
    await consultDirectory(Math.min(12, Math.max(6, maxItems)));
    if (candidates.length > before) await extractFrom(before);
  }

  // Nothing survived the specific pass? Widen the net once and try again, so a
  // very specific "who is this for" degrades to *some* real results instead of an
  // empty screen. Reuses the same candidate/opp/dedup state and only extracts the
  // freshly-gathered pages. Skipped for creator searches (which depend on
  // roundup listicles, a different strategy) and when there were no queries.
  // Floor: every scout should hand back at least 5 real results. Under that,
  // widen once even if a few survived the specific pass.
  const MIN_FINDS = 5;
  let broadenedQueries = 0;
  if (opps.length < MIN_FINDS && queries.length && !creatorSearch) {
    const alreadyProcessed = candidates.length;
    const broadened = await planQueries(
      goal,
      about,
      useCase,
      feedback,
      salt,
      cohortHint,
      personalOverride,
      true,
      plan
    );
    broadenedQueries = broadened.length;
    currentPass = "broadened";
    await gather(broadened);
    await extractFrom(alreadyProcessed);
    currentPass = "specific";
  }

  // Scarcity rescue: still under the floor after widening. When the goal
  // permits it (and job searches always permit proactive employers), go find
  // the missing finds in OTHER industries instead of coming back short —
  // fresh queries that deliberately span several fields, and an extraction
  // override that accepts honest moderate fits.
  // Not one shot: up to three rounds, each with a fresh salt so the planner
  // takes genuinely new angles instead of re-running the same widening.
  const SCARCITY_PLAN =
    `SCARCITY: the specific pass found under ${MIN_FINDS} results. Write queries that deliberately span SEVERAL ` +
    `DIFFERENT industries and target types the GOAL allows (when the goal welcomes other industries, USE that ` +
    `permission now), favouring small reachable employers and live postings. Do not repeat earlier angles.`;
  for (
    let round = 1;
    round <= 3 && opps.length < MIN_FINDS && queries.length && !creatorSearch && !aborted();
    round++
  ) {
    emit(
      round === 1
        ? `Only ${opps.length} so far; widening into other industries to reach ${MIN_FINDS}`
        : `Still ${opps.length} of ${MIN_FINDS}; taking another set of industries`
    );
    const already = candidates.length;
    const rescueQueries = await planQueries(
      goal,
      about,
      useCase,
      feedback,
      `${salt}:rescue${round}`,
      cohortHint,
      [personalOverride, SCARCITY_PLAN].filter(Boolean).join("\n\n"),
      true,
      plan
    ).catch(() => [] as string[]);
    if (!rescueQueries.length) break;
    extractOverride =
      (personalOverride || "") +
      `\n\nSCARCITY MODE: earlier passes rejected nearly everything and the user is owed at least ${MIN_FINDS} real ` +
      `results. Unless a result is a private individual, a dead link, or advice content, lean toward is_relevant true ` +
      `with an HONEST moderate fit_score (0.35-0.6) and a why_it_fits framed as a proactive outreach target. When the ` +
      `GOAL welcomes other industries, industry is not a reason to reject anything.`;
    currentPass = "rescue";
    await gather(rescueQueries.slice(0, 6));
    await extractFrom(already);
    currentPass = "specific";
    extractOverride = personalOverride;
  }

  // Final salvage: every rescue round still left us under the floor. The pages
  // already read are the material we have, and dozens were rejected against
  // the strict bar — re-read them ONCE under a junk-only bar. Name/host dedup
  // keeps the accepted ones from double-counting, so the only cost is one more
  // extraction pass, no new searches.
  if (opps.length < MIN_FINDS && candidates.length && !creatorSearch && !aborted()) {
    emit(
      `Re-reading ${candidates.length} pages with a wider lens for the last ${MIN_FINDS - opps.length}`
    );
    extractOverride =
      (personalOverride || "") +
      `\n\nFINAL SALVAGE: the user is owed ${MIN_FINDS - opps.length} more result(s) and these already-read pages ` +
      `are the only material left. Any organization or opportunity here that could PLAUSIBLY be approached for the ` +
      `goal comes back is_relevant true with an HONEST fit_score (as low as 0.3 is fine) and a why_it_fits framed as ` +
      `proactive cold outreach. Reject ONLY private individuals, dead or empty pages, and pure advice content with no ` +
      `approachable subject. Never invent facts; a modest fit honestly labelled beats an empty screen.`;
    await extractFrom(0);
    extractOverride = personalOverride;
  }

  // The same company can slip past name/host dedup by appearing both as a generic
  // entry ("Round Hill Music") and a specific posting ("Round Hill Music, Copyright
  // Internship"), often from different pages/hosts. For job/internship hunts, where
  // you want one entry per employer, collapse by company (outlet), keeping the most
  // specific (a posting title beats the bare company name).
  if (isJobSearch(useCase, goal)) {
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

  // Evidence-confidence boost: a candidate corroborated by several INDEPENDENT
  // sources (different hosts) is more trustworthy, so nudge its fit up. Capped and
  // counted by distinct host so three articles from one site don't inflate it.
  for (const o of opps) {
    const hosts = new Set((o.sources || []).map((s) => urlHost(s.url)).filter(Boolean));
    const extra = Math.max(0, hosts.size - 1);
    if (extra > 0 && o.fitScore != null) {
      // Scaled by the fit itself: corroboration says "this candidate is real",
      // not "this candidate matches". Several sources agreeing on someone who
      // answers one part of the goal shouldn't push them up the list.
      o.fitScore = Math.min(1, o.fitScore + Math.min(0.15, extra * 0.05) * o.fitScore);
    }
  }
  // Best-fit first (evidence-boosted).
  opps.sort((a, b) => (b.fitScore || 0) - (a.fitScore || 0));

  // Phase 2 — confidence-gated contact enrichment. The best candidates that lack a
  // reachable contact get targeted follow-up searches to find one (a personal
  // email, LinkedIn, or the right gatekeeper). Runs for EVERY search, not just
  // jobs, and is bounded to the top few so we stay within the time budget.
  const jobSearch = isJobSearch(useCase, goal);
  let enrichSearches = 0;
  if (!aborted()) {
    // Only a few enrichment lookups fit in the time budget, so they go to the
    // finds that need them MOST: anyone with no contact detail at all is about
    // to be dropped by the reachability gate below, while someone who already
    // has a generic inbox is merely being upgraded. Losing a real match to a
    // spent budget is worse than missing a nicer address on one we keep.
    const needContact = opps
      .filter((o) => !hasPersonalEmail(o))
      .sort((a, b) => Number(hasAnyContact(a)) - Number(hasAnyContact(b)))
      .slice(0, 6);
    enrichSearches = needContact.length * 2;
    if (needContact.length)
      emit(`Chasing contacts for ${needContact.length} strong ${needContact.length === 1 ? "match" : "matches"}…`);
    const found = await Promise.all(
      needContact.map((o) =>
        (jobSearch ? findRecruiterContact(o, goal) : findContactFor(o, goal, useCase)).catch(
          () => null
        )
      )
    );
    needContact.forEach((o, i) => {
      const c = found[i] as {
        name?: string;
        role?: string;
        email?: string;
        handle?: string;
        phone?: string;
      } | null;
      if (!c) return;
      if (c.name && !o.contactName) o.contactName = c.name;
      if (c.role && !o.contactRole) o.contactRole = c.role;
      if (c.handle && !o.contactHandle) o.contactHandle = c.handle;
      if (c.phone && !o.contactPhone) o.contactPhone = c.phone;
      // Upgrade to a real email (or a personal one over a generic inbox).
      if (
        c.email &&
        (!o.contactEmail || (!isPersonalEmail(o.contactEmail) && isPersonalEmail(c.email)))
      ) {
        o.contactEmail = c.email;
        if (o.channel === "Company Portal" || o.channel === "Unknown" || !o.channel)
          o.channel = "Email";
      }
      if (c.email || c.handle || c.phone)
        emit(`Found a way to reach ${o.name}${c.email ? ` (${c.email})` : ""}`);
    });
  }

  // Recompute reachability from the FINAL contact data (after Phase 1 merging and
  // Phase 2 enrichment), so the reachability signal reflects what we actually have.
  for (const o of opps) {
    if (o.scores)
      o.scores.reachability = reachabilityFrom(o.contactEmail, o.contactHandle, o.contactPhone);
  }

  // Reachability gate: never surface someone with no way to contact them.
  // Deliberately placed AFTER Phase 2 enrichment, so anyone whose address was
  // about to be found still gets that chance — and deliberately keyed on an
  // actual contact VALUE rather than the `channel` label, which is only ever
  // the extractor's guess at how you might get in touch. A team bio page
  // yielding channel "Website Form" and nothing else is exactly the case this
  // exists to stop: it reads as reachable and isn't.
  {
    const before = opps.length;
    for (let i = opps.length - 1; i >= 0; i--) {
      if (!hasAnyContact(opps[i])) {
        logSkip(opps[i].name, opps[i].url, "no way to contact them — no email, phone, or handle");
        opps.splice(i, 1);
      }
    }
    if (opps.length < before) skippedNotFit += before - opps.length;
  }

  // Minimum-fit floor: never surface a near-zero match. A fit at or below 0.1
  // is a confirmed non-fit (e.g. the wrong-location hard veto lands at 0.01), so
  // showing a "1% fit" is just noise. Casting a wide net is about VARIETY, not
  // scraping the bottom, so drop these outright. Unknown fit (null) is kept.
  const FIT_FLOOR = 0.1;
  {
    const before = opps.length;
    for (let i = opps.length - 1; i >= 0; i--) {
      const f = opps[i].fitScore;
      if (typeof f === "number" && f <= FIT_FLOOR) {
        logSkip(opps[i].name, opps[i].url, `too low a fit (${Math.round(f * 100)}%) to surface`);
        opps.splice(i, 1);
      }
    }
    if (opps.length < before) skippedNotFit += before - opps.length;
  }

  // Hard cap: drop any target already contacted by too many other users recently,
  // so the same inboxes don't get blasted across profiles. Fail-open (if the
  // ledger is unreachable, nothing is dropped).
  //
  // IMPORTANT: only cap PERSONAL outreach (networking, PR, individual contacts).
  // Job/internship postings are MEANT to receive many applicants, so there is no
  // cap on those, everyone can and should apply to the same opening.
  let kept = opps;
  let skippedCapped = 0;
  if (!isJobSearch(useCase, goal) && !aborted()) {
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

  // One directory must not become the whole result list. A single page that
  // names twenty firms ("Directory of ERISA Boutique Law Firms") can out-vote
  // every other source, and the user sees one niche where they asked for a
  // spread; measured live, a wide-variety search came back as nine law firms,
  // eight of them from one lawcrossing.com listing. Cap how many finds any one
  // SOURCE host contributes, strictest when the goal explicitly asks for
  // variety, and keep the highest-fit ones from each host.
  {
    const perHostCap = goalWantsAnyIndustry(goal) ? 2 : 3;
    const hostOfSrc = (o: Opportunity): string => {
      const src = o.sources?.[0]?.url || o.url || "";
      const m = /^https?:\/\/([^\/?#]+)/i.exec(src);
      return m ? m[1].replace(/^www\./, "").toLowerCase() : "";
    };
    const byHost = new Map<string, Opportunity[]>();
    for (const o of kept) {
      const h = hostOfSrc(o);
      (byHost.get(h) || byHost.set(h, []).get(h)!).push(o);
    }
    const over = [...byHost.entries()].filter(([h, list]) => h && list.length > perHostCap);
    if (over.length) {
      const drop = new Set<Opportunity>();
      for (const [, list] of over) {
        const ranked = [...list].sort((a, b) => (b.fitScore ?? 0) - (a.fitScore ?? 0));
        for (const o of ranked.slice(perHostCap)) drop.add(o);
      }
      kept = kept.filter((o) => {
        if (!drop.has(o)) return true;
        logSkip(
          o.name,
          o.url,
          "one source page already contributed enough finds; keeping the list varied"
        );
        return false;
      });
    }
  }

  // Reddit corroboration: a thread is somebody's opinion, not a record, so a
  // find whose ONLY evidence is Reddit must be confirmed by one search of the
  // wider web before it may surface. A find that already merged a non-Reddit
  // source passes for free; the rest get one verification search each (cheap,
  // the per-host cap means at most a few per run), matched by the find's own
  // site appearing or its exact name in a result title. No confirmation, no
  // surfacing.
  if (!aborted() && kept.some((o) => onlyRedditSourced(o))) {
    emit("Double-checking Reddit finds against the wider web");
    const confirmedKept: Opportunity[] = [];
    for (const o of kept) {
      if (!onlyRedditSourced(o)) {
        confirmedKept.push(o);
        continue;
      }
      if (aborted()) {
        confirmedKept.push(o);
        continue; // cancelled mid-check: keep rather than silently drop
      }
      try {
        const q = [o.name, o.outlet, o.location].filter(Boolean).join(" ");
        const results = await tavilySearch(`"${o.name}" ${q === o.name ? "" : q.slice(o.name.length)}`.trim(), 5, { depth: "basic" });
        const ownHost = urlHost(o.url || "");
        const nameKey = normName(o.name);
        const confirmation = results.find((r) => {
          if (isRedditHost(urlHost(r.url))) return false;
          if (ownHost && !isRedditHost(ownHost) && urlHost(r.url) === ownHost) return true;
          return nameKey.length > 3 && normName(r.title).includes(nameKey);
        });
        if (confirmation) {
          o.sources = [
            ...(o.sources || []),
            { url: confirmation.url, title: confirmation.title },
          ].slice(0, 12);
          confirmedKept.push(o);
        } else {
          logSkip(
            o.name,
            o.url,
            "named on Reddit but nowhere else we could confirm; dropped as unverified"
          );
        }
      } catch {
        // The verification search itself failing is not evidence against the
        // find; keep it rather than punishing a network blip.
        confirmedKept.push(o);
      }
    }
    kept = confirmedKept;
  }

  // Fallback disclosure: on a job/internship hunt, if actual open postings came
  // back thin, say so plainly instead of passing companies off as live openings.
  let notice: string | undefined;
  if (isJobSearch(useCase, goal) && kept.length) {
    const listings = kept.filter((o) => o.targetType === "listing").length;
    if (listings < 3 && listings < kept.length) {
      notice =
        listings === 0
          ? "Few active postings matched right now, so these are good-fit companies worth reaching out to directly, not confirmed openings."
          : "Only a couple of active postings matched, so most of these are good-fit companies worth approaching proactively, not confirmed openings.";
    }
  }

  // Partial-match disclosure. When a goal stacks several requirements and
  // nothing clears a middling fit, what came back answers PARTS of the ask —
  // and showing those silently alongside a percentage reads as "here are your
  // matches" when it should read "nobody matches; here's the nearest thing".
  // Say so, rather than leaving the number to carry the caveat alone.
  if (!notice && kept.length) {
    const asks = [...(plan?.required || []), ...(plan?.hard_constraints || [])].length;
    const best = kept.reduce((m, o) => Math.max(m, o.fitScore ?? 0), 0);
    if (asks >= 3 && best > 0 && best < 0.5) {
      notice =
        `Nothing matched everything you asked for. These each answer part of it, ` +
        `so the fit scores are low on purpose — treat them as leads on where to look, not matches.`;
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
    plan,
    notice,
  };
}
