// Read a specific internship/job posting, pull out every application component
// the applicant must provide, and draft each written one in the applicant's voice
// using what Scout knows about them (profile bio/resume, coaching, past edits).

import { claudeJson, parseJsonLoose, noDash } from "./claude";
import { ApiCreditError } from "./apiErrors";
import { safeUrl, gatherPages } from "./pageText";

// kinds Scout can DRAFT (written prose) vs. ones the applicant must supply.
const WRITABLE = new Set(["cover_letter", "essay", "short_answer", "form_field"]);

export interface AppComponent {
  title: string;
  kind: string; // cover_letter | essay | short_answer | form_field | resume | portfolio | link | reference | other
  prompt: string; // the exact question / what they're asking for
  constraints: string; // word/char limit, format, etc. (may be empty)
  required: boolean;
  draft?: string; // drafted text for writable components
  action?: string; // for non-writable: what the applicant should do
}

export interface ApplicationResult {
  overview: string; // one-line summary of the role/posting
  howToApply: string; // where/how to submit, deadlines
  components: AppComponent[];
  scannedPages: number;
}

// What the applicant should do for a component we can't write for them.
function actionFor(kind: string, title: string): string {
  switch (kind) {
    case "resume":
      return "Attach your resume (Scout can tailor it from your profile on request).";
    case "portfolio":
      return "Add a link to your portfolio or work samples.";
    case "link":
      return `Provide the requested link: ${title}.`;
    case "reference":
      return "Provide the requested references (names, roles, contact info).";
    default:
      return `Provide: ${title}.`;
  }
}

export async function draftApplication(opts: {
  url: string;
  name?: string;
  outlet?: string;
  about: string;
  useCase?: string;
  coaching?: string[];
  editPairs?: { before: string; after: string }[];
}): Promise<ApplicationResult> {
  const u = safeUrl(opts.url);
  if (!u) throw new Error("This opening has no page to read.");

  const { text, pages } = await gatherPages(u, { maxFollow: 3 });
  if (!text.trim()) throw new Error("That posting had no readable text.");

  // ---- 1) Extract the application's structure ----
  const exSys =
    `You read a specific internship/job posting and list EVERY component the applicant must submit. ` +
    `Return ONLY JSON {overview, howToApply, components:[{title, kind, prompt, constraints, required}]}. ` +
    `kind is one of: cover_letter, essay, short_answer, form_field, resume, portfolio, link, reference, other. ` +
    `Use "essay"/"short_answer" for written questions (include the EXACT question text in prompt and any word/char ` +
    `limit or format in constraints). Use "cover_letter" when they ask for one. Use resume/portfolio/link/reference for ` +
    `things the applicant supplies rather than writes. ONLY list what THIS posting actually asks for; never invent a ` +
    `requirement. If the posting lists no specific components, return components as an empty array. ` +
    `overview = one plain sentence on the role. howToApply = where/how to submit plus any deadline, if stated.`;
  const exUser =
    `POSTING: ${String(opts.name || "").trim()}${opts.outlet ? ` at ${opts.outlet}` : ""}\n\nPAGE TEXT:\n${text}`;

  let structure: any = null;
  try {
    structure = parseJsonLoose(await claudeJson(exSys, exUser));
  } catch (e) {
    if (e instanceof ApiCreditError) throw e;
    structure = null;
  }
  const rawComponents: any[] = Array.isArray(structure?.components)
    ? structure.components
    : [];

  const components: AppComponent[] = rawComponents
    .map((c) => ({
      title: String(c?.title || "").trim() || "Application item",
      kind: String(c?.kind || "other").trim().toLowerCase(),
      prompt: String(c?.prompt || "").trim(),
      constraints: String(c?.constraints || "").trim(),
      required: c?.required !== false,
    }))
    .filter((c) => c.title || c.prompt);

  // ---- 2) Draft every writable component from the applicant's profile ----
  const writable = components.filter((c) => WRITABLE.has(c.kind));
  if (writable.length) {
    const coach = (opts.coaching || []).filter(Boolean).slice(0, 8);
    const edits = (opts.editPairs || []).filter((x) => x && x.after).slice(0, 3);
    const drSys =
      `You draft internship/job application materials in the applicant's own voice, using ONLY the true facts in ` +
      `their profile. Warm, specific, genuine, never generic or salesy. NEVER use em-dashes or en-dashes; use commas ` +
      `and periods. Respect every stated word/character limit and format. Answer the EXACT question asked. Do NOT ` +
      `fabricate experience, names, dates, or achievements the profile does not support; if the profile lacks something, ` +
      `write what is supportable and leave a clearly marked [add: ...] placeholder rather than inventing. ` +
      `Return ONLY JSON {drafts:[{title, text}]} with one entry per item, in the same order.` +
      (coach.length
        ? `\n\nApply this coaching the applicant approved:\n` + coach.map((c) => `- ${c}`).join("\n")
        : "") +
      (edits.length
        ? `\n\nMatch how they rewrite drafts (study BEFORE to AFTER, copy the style not the content):\n` +
          edits
            .map((x, i) => `${i + 1}. BEFORE: ${x.before.slice(0, 300)}\n   AFTER: ${x.after.slice(0, 300)}`)
            .join("\n\n")
        : "");
    const items = writable
      .map(
        (c, i) =>
          `${i + 1}. TITLE: ${c.title}\n   KIND: ${c.kind}\n   QUESTION/ASK: ${c.prompt || c.title}\n   CONSTRAINTS: ${c.constraints || "none stated"}`
      )
      .join("\n\n");
    const drUser =
      `ABOUT THE APPLICANT (their profile, the only basis for facts):\n${opts.about || "(no profile provided)"}\n\n` +
      `ROLE: ${String(opts.name || "").trim()}${opts.outlet ? ` at ${opts.outlet}` : ""}\n\n` +
      `DRAFT EACH OF THESE APPLICATION ITEMS:\n${items}`;

    let drafted: any = null;
    try {
      drafted = parseJsonLoose(await claudeJson(drSys, drUser));
    } catch (e) {
      if (e instanceof ApiCreditError) throw e;
      drafted = null;
    }
    const drafts: any[] = Array.isArray(drafted?.drafts) ? drafted.drafts : [];
    writable.forEach((c, i) => {
      // Match by order, fall back to title.
      const d =
        drafts[i] ||
        drafts.find((x) => String(x?.title || "").trim().toLowerCase() === c.title.toLowerCase());
      if (d?.text) c.draft = noDash(String(d.text));
    });
  }

  // Attach a to-do action to the components Scout can't write.
  for (const c of components) {
    if (!WRITABLE.has(c.kind)) c.action = actionFor(c.kind, c.title);
  }

  return {
    overview: noDash(String(structure?.overview || "")),
    howToApply: noDash(String(structure?.howToApply || "")),
    components,
    scannedPages: pages,
  };
}
