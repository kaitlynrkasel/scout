// The shared people index: engine-found people persist here so every search
// compounds the next one. Server-only (service role).
//
// Anti-homogenization contract (the product rule this file exists to honor):
// the index INFORMS searches, it must never make different users' results
// converge. Enforced here and at the call sites:
//   - read path returns at most a small minority of a search's candidates
//   - only records seen within FRESH_DAYS surface
//   - the eligible pool is sampled with a per-search salt, so two users with
//     the same goal draw different slices
//   - seen_count is confidence metadata, never a ranking boost
//   - index candidates re-earn their place through the same fit scoring,
//     location rules, and exposure caps as fresh web candidates
// Privacy: ONLY public-web engine results are written. Manual/imported
// contacts are user-private and must never be passed to upsertPeopleIndex.

import { supabaseAdmin } from "./supabaseAdmin";
import type { Opportunity } from "./types";

const FRESH_DAYS = 90;

function normEmail(s: string): string {
  return String(s || "").trim().toLowerCase();
}
function normHandleOrUrl(s: string): string {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(www\.)?/, "")
    .replace(/\/+$/, "");
}

// Stable identity for dedupe across sightings.
export function personKey(o: Opportunity): string {
  const email = normEmail(o.contactEmail);
  if (email) return `e:${email}`;
  const handle = normHandleOrUrl(o.contactHandle);
  if (handle) return `h:${handle}`;
  const name = String(o.name || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const host = normHandleOrUrl(o.url).split("/")[0];
  return `n:${name}::${host}`;
}

// Merge a fresh sighting over a stored record: newest role/why win (they age),
// but a known contact route is never blanked by a sighting that lacks it.
function mergeOpp(stored: any, fresh: Opportunity): any {
  return {
    ...stored,
    ...fresh,
    contactEmail: fresh.contactEmail || stored?.contactEmail || "",
    contactHandle: fresh.contactHandle || stored?.contactHandle || "",
    contactPhone: fresh.contactPhone || stored?.contactPhone || "",
    url: fresh.url || stored?.url || "",
    location: fresh.location || stored?.location || "",
  };
}

// Write path: fire-and-forget after a successful engine run. Errors are
// swallowed, the index is an accelerant, never a point of failure (and the
// code must keep working before the table exists).
export async function upsertPeopleIndex(opps: Opportunity[]): Promise<void> {
  if (!supabaseAdmin || !opps.length) return;
  try {
    const keys = opps.map(personKey);
    const { data: existing } = await supabaseAdmin
      .from("people_index")
      .select("key, opp, sources, seen_count")
      .in("key", keys);
    const byKey = new Map((existing || []).map((r: any) => [r.key, r]));
    const now = new Date().toISOString();
    const seen = new Set<string>();
    const rows: any[] = [];
    opps.forEach((o, i) => {
      const k = keys[i];
      if (seen.has(k)) return; // same person twice in one run
      seen.add(k);
      const prev = byKey.get(k);
      const prevSources: any[] = Array.isArray(prev?.sources) ? prev.sources : [];
      const freshSources = (o.sources || []).filter(
        (s) => s.url && !prevSources.some((p) => p.url === s.url)
      );
      rows.push({
        key: k,
        opp: mergeOpp(prev?.opp, o),
        sources: [...prevSources, ...freshSources].slice(0, 12),
        seen_count: (prev?.seen_count || 0) + 1,
        last_seen_at: now,
      });
    });
    await supabaseAdmin.from("people_index").upsert(rows, { onConflict: "key" });
  } catch {
    /* best-effort by design */
  }
}

// Read path: a small, salted, fresh slice of index matches for this goal,
// shaped like search results so the engine scores them exactly like fresh
// candidates. Never more than `limit` (call sites keep this a small minority).
export async function searchPeopleIndex(
  goal: string,
  limit: number,
  salt?: string
): Promise<{ title: string; url: string; content: string }[]> {
  if (!supabaseAdmin || !goal.trim() || limit <= 0) return [];
  try {
    const words = goal
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2)
      .slice(0, 12);
    if (!words.length) return [];
    const cutoff = new Date(Date.now() - FRESH_DAYS * 86400000).toISOString();
    const { data } = await supabaseAdmin
      .from("people_index")
      .select("key, opp, sources, seen_count, last_seen_at")
      .textSearch("search_tsv", words.join(" or "), { type: "websearch", config: "simple" })
      .gte("last_seen_at", cutoff)
      .limit(limit * 4); // oversample, then salt-rotate below
    const pool = data || [];
    if (!pool.length) return [];
    // Deterministic per-search shuffle: the same search sees a stable slice,
    // different searches/users draw different ones. seen_count is deliberately
    // ignored here, popularity must not become priority.
    let h = 0;
    const s = String(salt || "");
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    const picked = pool
      .map((r: any, i: number) => ({ r, k: (h ^ (i * 2654435761)) >>> 0 }))
      .sort((a, b) => a.k - b.k)
      .slice(0, limit)
      .map((x) => x.r);
    return picked.map((r: any) => {
      const o = r.opp || {};
      const src = (Array.isArray(r.sources) && r.sources[0]?.url) || o.url || "";
      return {
        title: `${o.name || ""}${o.contactRole ? ` - ${o.contactRole}` : ""}${o.outlet ? ` at ${o.outlet}` : ""}`,
        url: o.url || src,
        content:
          `Known from Scout's prior verified searches (seen ${r.seen_count}x, last ${String(r.last_seen_at).slice(0, 10)}). ` +
          [
            o.name && `Name: ${o.name}.`,
            o.contactRole && `Role: ${o.contactRole}.`,
            o.outlet && `Organization: ${o.outlet}.`,
            o.location && `Location: ${o.location}.`,
            o.contactEmail && `Email: ${o.contactEmail}.`,
            o.contactHandle && `Profile: ${o.contactHandle}.`,
            o.whyItFits && `Notes: ${o.whyItFits}`,
          ]
            .filter(Boolean)
            .join(" ")
            .slice(0, 900),
      };
    });
  } catch {
    return []; // table missing or query error: searches proceed purely fresh
  }
}
