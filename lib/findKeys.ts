// Identity keys for a prospect, shared by the client pipeline and the server's
// team pipeline. These live here rather than in the page component because the
// shared_finds table dedups on the key BOTH sides produce: if the browser and
// the cron job normalized names even slightly differently, the same person
// would land twice in a team's shared pipeline.

// Same normalization the discover engine uses so IDs match across the boundary.
// Strips role suffixes (", VP of…", " at Acme", " (Head of X)"), honorifics,
// name suffixes, and middle names/initials, then keeps first + last token.
// So "John Smith", "John J. Smith", "John Smith, Marketing Lead", and
// "Dr. John Smith Jr" all collapse to "johnsmith".
export function normNameKey(s: string): string {
  // Drop everything after the first role separator, then normalize what's left.
  // People/orgs almost never have commas or pipes in their actual name; when
  // they do appear, they always mark a role/title/company suffix that would
  // otherwise poison the "last token" heuristic below.
  const dropRoleSuffix = String(s || "")
    .split(/[,|·•—–]|\s+[-–—]\s+|\s+\bat\b\s+|\s+\bfor\b\s+/i)[0]
    .replace(/\([^)]*\)/g, " ");
  const cleaned = dropRoleSuffix
    .toLowerCase()
    .replace(/\b(dr|mr|mrs|ms|prof|rev|hon|sir)\.?\s+/g, "")
    .replace(/\b(jr|sr|ii|iii|iv|v|phd|md|esq|do|dds|rn|mba|cpa)\.?$/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const parts = cleaned.split(" ").filter(Boolean);
  if (parts.length <= 1) return parts[0] || "";
  return parts[0] + parts[parts.length - 1];
}

export function urlHostKey(u: string): string {
  const m = String(u || "").match(/^https?:\/\/([^/?#]+)/i);
  return m ? m[1].replace(/^www\./, "").toLowerCase() : "";
}

// The same prospect as seen by the whole team. Deliberately WITHOUT a project
// id: local project ids are generated per device, so keying the shared pipeline
// on the local findKey() would file one person under a different key for every
// teammate and defeat the dedup the shared_finds unique index exists to give.
export function sharedFindKey(o: { name?: string; url?: string }): string {
  return `${normNameKey(o?.name || "")}::${urlHostKey(o?.url || "")}`;
}
