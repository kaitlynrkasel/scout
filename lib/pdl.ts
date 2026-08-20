// People Data Labs: licensed person data, used ONLY where the open web runs
// out. Two jobs:
//   1. Roster search, the thing public-web search structurally cannot do:
//      "everyone whose education lists Babson College", not just the alumni
//      who happen to have press coverage.
//   2. Enrichment of a known person (paid plans only, see below).
//
// Free-tier reality, measured against the live API: names, LinkedIn URLs, job
// titles, companies, and education come back as real values; emails, phones,
// and locations come back as booleans (an existence flag, not the value). So
// on the free tier PDL supplies WHO, and Scout's own engine still supplies the
// contact route. That division is fine, and the code below treats any boolean
// contact field as "unknown" so a masked flag can never leak into a find.
//
// Everything here is opt-in: with no PDL_API_KEY set, every function no-ops and
// searches behave exactly as before.

import { claudeJson, parseJsonLoose } from "./claude";
import type { Opportunity } from "./types";

const BASE = "https://api.peopledatalabs.com/v5";

export function pdlEnabled(): boolean {
  return !!process.env.PDL_API_KEY;
}

// A value PDL masked behind a boolean is not a value.
function realStr(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export interface PdlFilters {
  school?: string;
  degree?: string;
  major?: string;
  title?: string;
  company?: string;
  industry?: string;
  locality?: string;
  region?: string;
  country?: string;
}

// Turn a free-text goal into structured PDL filters, or null when the goal
// isn't roster-shaped (no school/company/title to filter on). Keeping this a
// separate cheap Claude call means the roster path only fires when it can
// actually beat a web search.
const FILTER_SYS = `You convert a people-search goal into structured database filters.

Return ONLY JSON: {"roster": true|false, "filters": {...}}

Set roster=true ONLY when the goal names at least one HARD filter a person database can match exactly: a specific school, a specific company, a specific job title/role, or a specific industry. Vague goals ("interesting people in music", "anyone who might help") are roster=false.

filters may contain any of: school (exact institution name), degree (e.g. "master of science", "master of business administration", "bachelors"), major (field of study), title (job title keywords), company (employer name), industry, locality (city), region (state/province), country.

Rules: use lowercase. Only include a filter the goal actually states, never invent one. Prefer the school's formal name ("babson college", not "babson").

A PROGRAM NAME IS NOT A MAJOR. Degree programs have marketing names ("Entrepreneurial Leadership", "Integrated Marketing", "Business Analytics") that almost nobody writes as their field of study, so putting one in the major filter matches nobody. When the goal names a program or its initials, set degree to the degree TYPE only ("master of science", "master of business administration", "bachelors") and leave major empty. Use major only when the goal names a plain field of study people actually list, like "computer science", "marketing", or "finance".`;

export async function goalToPdlFilters(goal: string): Promise<PdlFilters | null> {
  if (!goal.trim() || !process.env.ANTHROPIC_API_KEY) return null;
  try {
    const out = await claudeJson(FILTER_SYS, `GOAL: ${goal.slice(0, 600)}`, 400);
    const parsed = parseJsonLoose<{ roster?: boolean; filters?: PdlFilters }>(out);
    if (!parsed?.roster || !parsed.filters) return null;
    const f = parsed.filters;
    const clean: PdlFilters = {};
    for (const k of ["school", "degree", "major", "title", "company", "industry", "locality", "region", "country"] as const) {
      const v = realStr((f as any)[k]).toLowerCase();
      if (v) (clean as any)[k] = v;
    }
    // Needs at least one hard identity filter to be worth a roster call.
    if (!clean.school && !clean.company && !clean.title && !clean.industry) return null;
    return clean;
  } catch {
    return null;
  }
}

function buildSql(f: PdlFilters): string {
  const where: string[] = [];
  const esc = (s: string) => s.replace(/'/g, "''");
  if (f.school) where.push(`education.school.name='${esc(f.school)}'`);
  if (f.degree) where.push(`education.degrees='${esc(f.degree)}'`);
  if (f.major) where.push(`education.majors='${esc(f.major)}'`);
  if (f.title) where.push(`job_title LIKE '%${esc(f.title)}%'`);
  if (f.company) where.push(`job_company_name='${esc(f.company)}'`);
  if (f.industry) where.push(`job_company_industry='${esc(f.industry)}'`);
  if (f.locality) where.push(`location_locality='${esc(f.locality)}'`);
  if (f.region) where.push(`location_region='${esc(f.region)}'`);
  if (f.country) where.push(`location_country='${esc(f.country)}'`);
  return `SELECT * FROM person WHERE ${where.join(" AND ")}`;
}

export interface PdlPerson {
  name: string;
  title: string;
  company: string;
  linkedin: string;
  schools: string[];
  majors: string[];
  summary: string;
}

// Roster search with progressive relaxation: the most specific filter set
// often matches nobody (a program's marketing name rarely matches how people
// write their major), so drop the narrowest filters one at a time until the
// directory has someone. Order matters, identity filters (school, company,
// title) are kept longest because they are what makes the roster relevant.
export async function pdlRosterSearch(
  filters: PdlFilters,
  size = 10
): Promise<{ people: PdlPerson[]; total: number }> {
  // Soft filters are the ones most likely to match nobody because the goal's
  // wording will not match how the directory stores them (a program name that
  // is not a major, a loose industry word like "startups", a metro the person
  // lists differently). Drop them one at a time, narrowest first, and keep the
  // identity filters (school, company, title) that make the roster relevant.
  const SOFT: (keyof PdlFilters)[] = ["major", "industry", "locality", "region", "degree", "country"];
  const attempts: PdlFilters[] = [filters];
  let working: PdlFilters = { ...filters };
  for (const k of SOFT) {
    if (working[k] === undefined) continue;
    const { [k]: _drop, ...rest } = working;
    working = rest as PdlFilters;
    // Stop before we relax away the last identity filter.
    if (!working.school && !working.company && !working.title) break;
    attempts.push({ ...working });
  }
  for (const attempt of attempts) {
    const out = await pdlRosterOnce(attempt, size);
    if (out.people.length) return out;
  }
  return { people: [], total: 0 };
}

async function pdlRosterOnce(
  filters: PdlFilters,
  size: number
): Promise<{ people: PdlPerson[]; total: number }> {
  const key = process.env.PDL_API_KEY;
  if (!key) return { people: [], total: 0 };
  try {
    const params = new URLSearchParams({
      sql: buildSql(filters),
      size: String(Math.min(Math.max(size, 1), 25)),
    });
    const r = await fetch(`${BASE}/person/search?${params}`, {
      headers: { "X-Api-Key": key },
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) return { people: [], total: 0 };
    const body = await r.json();
    const rows: any[] = Array.isArray(body?.data) ? body.data : [];
    const people = rows
      .map((p) => {
        const schools = ((p.education || []) as any[])
          .map((e) => realStr(e?.school?.name))
          .filter(Boolean);
        const majors = ((p.education || []) as any[])
          .flatMap((e) => (Array.isArray(e?.majors) ? e.majors : []))
          .map((m: unknown) => realStr(m))
          .filter(Boolean);
        return {
          name: realStr(p.full_name),
          title: realStr(p.job_title),
          company: realStr(p.job_company_name),
          linkedin: realStr(p.linkedin_url),
          schools: Array.from(new Set(schools)).slice(0, 4),
          majors: Array.from(new Set(majors)).slice(0, 5),
          summary: realStr(p.summary),
        };
      })
      .filter((p) => p.name && (p.linkedin || p.company));
    return { people, total: Number(body?.total) || people.length };
  } catch {
    return { people: [], total: 0 };
  }
}

// Shape roster hits like search results so the engine scores them through the
// exact same extraction, fit, location, and exposure gates as web candidates.
export function pdlPeopleAsCandidates(
  people: PdlPerson[]
): { title: string; url: string; content: string }[] {
  return people.map((p) => {
    const li = p.linkedin ? (p.linkedin.startsWith("http") ? p.linkedin : `https://${p.linkedin}`) : "";
    return {
      title: [p.name, p.title, p.company && `at ${p.company}`].filter(Boolean).join(" - "),
      url: li,
      content: [
        `${p.name}${p.title ? `, ${p.title}` : ""}${p.company ? ` at ${p.company}` : ""}.`,
        p.schools.length ? `Education: ${p.schools.join("; ")}.` : "",
        p.majors.length ? `Studied: ${p.majors.join(", ")}.` : "",
        li ? `LinkedIn profile: ${li}.` : "",
        p.summary ? p.summary.slice(0, 300) : "",
        "Source: licensed people directory (verified education and employment records).",
      ]
        .filter(Boolean)
        .join(" ")
        .slice(0, 900),
    };
  });
}

// Enrich one known person. On the free tier the contact fields come back
// masked, so this returns only what is genuinely present, callers should treat
// an empty result as "no new contact route found" and fall back to the engine.
export async function pdlEnrich(opts: {
  name?: string;
  company?: string;
  linkedin?: string;
}): Promise<Partial<Opportunity> | null> {
  const key = process.env.PDL_API_KEY;
  if (!key) return null;
  const params = new URLSearchParams();
  if (opts.linkedin) params.set("profile", opts.linkedin.replace(/^https?:\/\//, ""));
  else if (opts.name) {
    params.set("name", opts.name);
    if (opts.company) params.set("company", opts.company);
  } else return null;
  try {
    const r = await fetch(`${BASE}/person/enrich?${params}`, {
      headers: { "X-Api-Key": key },
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) return null;
    const body = await r.json();
    const p = body?.data;
    if (!p) return null;
    const email =
      realStr(p.work_email) ||
      realStr(p.recommended_personal_email) ||
      realStr((Array.isArray(p.personal_emails) ? p.personal_emails[0] : "") as string);
    const patch: Partial<Opportunity> = {};
    if (email) patch.contactEmail = email;
    const phone = realStr(p.mobile_phone);
    if (phone) patch.contactPhone = phone;
    const li = realStr(p.linkedin_url);
    if (li) patch.contactHandle = li.startsWith("http") ? li : `https://${li}`;
    const loc = realStr(p.location_name);
    if (loc) patch.location = loc;
    const role = realStr(p.job_title);
    if (role) patch.contactRole = role;
    return Object.keys(patch).length ? patch : null;
  } catch {
    return null;
  }
}
