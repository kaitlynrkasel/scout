import type { Template, TemplateKey } from "./types";

// The "one engine, multiple templates" core. Each template is the same kind of
// config object your Internship Scout used (PROFILES) and your Anna Belt Scout
// used (CONFIG_DEFAULTS) — just data. Adding a new vertical = adding an entry here.

export const TEMPLATES: Record<TemplateKey, Template> = {
  networking: {
    key: "networking",
    label: "Networking",
    blurb: "Find people in a field and write warm coffee-chat outreach.",
    targetNoun: "people",
    goalPlaceholder: "e.g. brand partnerships leads at consumer beauty startups",
    aboutPlaceholder:
      "A sentence or two about you — who you are and what you're hoping to learn.",
    exampleGoal: "brand partnerships leads at consumer beauty and wellness startups",
    exampleAbout:
      "I run marketing for a small indie beauty brand and I'm hoping to learn from people doing partnerships and PR at bigger consumer brands.",
    queryTails: [
      "{goal} LinkedIn",
      "people who work in {goal}",
      "{goal} contact",
      "{goal} email",
      "{goal} team members",
    ],
    draftStyle:
      "A warm, genuine, peer-to-peer note that shares specific interest in this person's work and softly asks for a quick call or coffee. NOT a job pitch. Short and human.",
  },
  jobs: {
    key: "jobs",
    label: "Job / Internship Search",
    blurb: "Find openings and write tailored cover-letter outreach.",
    targetNoun: "openings",
    goalPlaceholder: "e.g. remote marketing internships at growth-stage startups",
    aboutPlaceholder:
      "Your background, skills, school/role, and what you're looking for.",
    exampleGoal: "find me a job or internship in my field",
    exampleAbout:
      "A professional with a few years of experience in marketing and communications, strong in social media, writing, and campaign strategy — open to full-time roles and stretch internships that build a new specialty.",
    queryTails: [
      "{goal} apply",
      "{goal} hiring",
      "{goal} internship 2026",
      "{goal} careers",
      "{goal} job posting",
    ],
    draftStyle:
      "A tailored cover-letter / outreach email connecting the candidate's real experience to this specific role, with a soft ask to be considered. Warm but professional.",
  },
  musicpr: {
    key: "musicpr",
    label: "Music PR / Playlisting",
    blurb: "Find curators, blogs, and press and write pitch outreach.",
    targetNoun: "outlets",
    goalPlaceholder: "e.g. indie folk Spotify playlist curators accepting submissions",
    aboutPlaceholder:
      "The artist and the release you're promoting, plus the genre and influences.",
    exampleGoal: "indie folk-rock playlist curators and blogs accepting submissions",
    exampleAbout:
      "Promoting Anna Belt, a Nashville singer-songwriter (folk-rock, indie), new single out now, for fans of Stevie Nicks and Maggie Rogers.",
    queryTails: [
      "{goal} submit",
      "submit music to {goal}",
      "{goal} contact email",
      "{goal} accepting submissions 2026",
      "{goal} curator",
    ],
    draftStyle:
      "A warm, humble, non-salesy pitch for fans of the artist's influences, with a specific personalized line and a soft ask to be considered. NO hype.",
  },
};

export const TEMPLATE_LIST: Template[] = Object.values(TEMPLATES);

// The use case is now free text. These are just autocomplete suggestions; typing
// anything else is fine, the engine reads it and adapts.
export const USE_CASE_SUGGESTIONS = [
  "Networking",
  "Job / Internship search",
  "Music PR / Playlisting",
  "Sales / lead generation",
  "Recruiting / hiring",
  "Press & media outreach",
  "Fundraising / investors",
  "Partnerships & business development",
  "Influencer marketing",
  "Freelance clients",
  "Real estate leads",
  "Event planning & speakers",
  "Podcast guest booking",
  "Community building",
];

// Best-effort match of a free-text use case to one of the deep presets. Returns
// null for anything else (the engine then behaves generically + reads the text).
export function resolveTemplate(useCase: string): Template | null {
  const s = String(useCase || "").toLowerCase();
  if (/music|playlist|\ba&r\b|record label|song|artist/.test(s)) return TEMPLATES.musicpr;
  if (/job|intern|career|hiring|new grad|co-?op/.test(s)) return TEMPLATES.jobs;
  if (/network|coffee|mentor|connect|advice/.test(s)) return TEMPLATES.networking;
  return null;
}

// Prospecting / lead-gen / biz-dev use cases: the user is reaching out on
// behalf of a company, product, or project to EXTERNAL targets, not making a
// personal ask. Shared by discover.ts (targets live in a different industry
// than the user, so don't filter by the user's field) and draft.ts (the
// sender's personal resume/bio/career history is usually irrelevant to a
// business pitch, unlike networking/job-search/PR outreach where it's the point).
export function isProspectingUseCase(useCase: string): boolean {
  return /\b(sales|lead|prospect|pitch|sell|selling|client|customer|partner|partnership|sponsor|sponsorship|investor|fundrais|business development|biz ?dev|b2b|vendor|supplier|wholesale|distributor|retailer|buyer|advertis|outreach to (businesses|companies|brands)|cold (email|outreach|call))/i.test(
    useCase || ""
  );
}

export const GENERIC = {
  targetNoun: "people",
  blurb: "Scout reads your use case and finds who fits.",
  goalPlaceholder: "e.g. the people or opportunities you want to reach",
  exampleGoal: "",
  draftStyle:
    "A warm, genuine, personal message that fits the sender's goal, with a clear but soft ask. Human and specific, never salesy.",
  queryTails: [
    "{goal}",
    "{goal} contact",
    "{goal} email",
    "{goal} how to reach",
    "{goal} apply",
  ],
};

// Display info for a free-text use case (preset when matched, generic otherwise).
export function ucInfo(useCase: string) {
  const t = resolveTemplate(useCase);
  if (t)
    return {
      targetNoun: t.targetNoun,
      blurb: t.blurb,
      goalPlaceholder: t.goalPlaceholder,
      exampleGoal: t.exampleGoal,
      key: t.key as string,
    };
  return {
    targetNoun: GENERIC.targetNoun,
    blurb: GENERIC.blurb,
    goalPlaceholder: GENERIC.goalPlaceholder,
    exampleGoal: GENERIC.exampleGoal,
    key: "",
  };
}

// A normalized key so "Networking"/"networking" bucket together, and custom use
// cases get their own stable bucket.
export function ucKey(useCase: string): string {
  const t = resolveTemplate(useCase);
  return t ? t.key : String(useCase || "").trim().toLowerCase() || "general";
}
