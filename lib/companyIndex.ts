// The company index: a long, growing list of employers Scout has seen, so
// job/internship searches can go straight at company careers pages instead
// of gated job boards (LinkedIn, Handshake, Indeed). Same design rules as
// the people index: fire-and-forget writes, salted rotating reads, never a
// point of failure, works before the table exists.

import { supabaseAdmin } from "./supabaseAdmin";
import type { Opportunity } from "./types";

export interface KnownCompany {
  name: string;
  host: string;
}

function companyKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 80);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

// Hosts that are boards/socials, not the company's own site; a careers-page
// strategy needs the employer's domain, so these never become a row's host.
const NOT_THEIR_SITE =
  /linkedin\.com|indeed\.com|glassdoor|handshake|ziprecruiter|instagram\.com|facebook\.com|x\.com|twitter\.com|tiktok\.com|youtube\.com|greenhouse\.io|lever\.co|myworkdayjobs|linktr\.ee/i;

// Words from the goal worth remembering as industry descriptors.
function goalWords(goal: string): string {
  return Array.from(
    new Set(
      goal
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 3)
    )
  )
    .slice(0, 10)
    .join(" ");
}

// Write path: every engine-found ORGANIZATION joins the list. Private
// individuals never do (no outlet, or person target with no company).
export async function upsertCompanyIndex(opps: Opportunity[], goal: string): Promise<void> {
  if (!supabaseAdmin || !opps.length) return;
  try {
    const words = goalWords(goal);
    const seen = new Set<string>();
    const candidates: { key: string; name: string; host: string }[] = [];
    for (const o of opps) {
      const name = String(o.outlet || (o.targetType !== "person" ? o.name : "") || "").trim();
      if (!name || name.length < 2 || name.length > 80) continue;
      const key = companyKey(name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const host = hostOf(o.url || "");
      candidates.push({ key, name, host: NOT_THEIR_SITE.test(host) ? "" : host });
    }
    if (!candidates.length) return;
    const { data: existing } = await supabaseAdmin
      .from("company_index")
      .select("key, host, industries, seen_count")
      .in("key", candidates.map((c) => c.key));
    const byKey = new Map((existing || []).map((r: any) => [r.key, r]));
    const now = new Date().toISOString();
    const rows = candidates.map((c) => {
      const prev = byKey.get(c.key);
      const mergedWords = Array.from(
        new Set(`${prev?.industries || ""} ${words}`.split(/\s+/).filter(Boolean))
      )
        .slice(0, 40)
        .join(" ");
      return {
        key: c.key,
        name: c.name,
        host: c.host || prev?.host || "",
        industries: mergedWords,
        seen_count: (prev?.seen_count || 0) + 1,
        last_seen_at: now,
      };
    });
    await supabaseAdmin.from("company_index").upsert(rows, { onConflict: "key" });
  } catch {
    /* best-effort by design */
  }
}

// Read path: a small salted slice of companies matching this goal, rotated
// per search so the same handful never dominates everyone's results.
export async function searchCompanyIndex(
  goal: string,
  limit: number,
  salt?: string
): Promise<KnownCompany[]> {
  if (!supabaseAdmin || !goal.trim() || limit <= 0) return [];
  try {
    const words = goal
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2)
      .slice(0, 12);
    if (!words.length) return [];
    const { data } = await supabaseAdmin
      .from("company_index")
      .select("name, host")
      .textSearch("search_tsv", words.join(" or "), { type: "websearch", config: "simple" })
      .limit(limit * 5); // oversample, salt-rotate below
    const pool = data || [];
    if (!pool.length) return [];
    let h = 0;
    const s = String(salt || "");
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return pool
      .map((r: any, i: number) => ({ r, k: (h ^ (i * 2654435761)) >>> 0 }))
      .sort((a, b) => a.k - b.k)
      .slice(0, limit)
      .map(({ r }) => ({ name: String(r.name || ""), host: String(r.host || "") }));
  } catch {
    return [];
  }
}
