// Shared "why did you pass" bucketing. Deny reasons are free-text (canonical
// chip labels, often with a custom elaboration appended, plus typos), so raw
// string counting scatters "Wrong industry", "Wrong industry, not sports
// business", and "Wrong industry - she doesn't work in sports" into three rows.
// Bucketing by concept collapses them into one honest tally. Used by both the
// user dashboard and the owner Insights view so the two always agree.

const CONCEPT_BUCKETS: { label: string; test: RegExp }[] = [
  { label: "Wrong location", test: /\b(location|city|region|country|state|area|place|based|distant|near|far|remote|abroad|foreign|domestic|zip)\b/i },
  { label: "Wrong industry", test: /\b(industry|field|sector|niche|market|space|vertical|business|not sports|not music|not film)\b/i },
  { label: "Wrong role or level", test: /\b(role|level|junior|senior|entry|position|title|seniority|fitness|too small|too big|too senior|too junior|not.*business side)\b/i },
  { label: "Wrong timing", test: /\b(timing|deadline|closed|expired|past|stale|next year|next semester|fall|spring|summer|winter|20\d\d|didn'?t match my inquiry)\b/i },
  { label: "No way to contact", test: /\b(no email|no phone|no way to (contact|reach)|can'?t reach|dm only|form only|unreachable)\b/i },
  { label: "Not a real prospect", test: /\b(not a (real )?prospect|not legit|spam|fake|placeholder|listicle|aggregator)\b/i },
  { label: "Genre / topic mismatch", test: /\b(country music|rock|pop|jazz|hip.?hop|genre|topic|subject|don'?t like working)\b/i },
  { label: "Values / org mismatch", test: /\b(religious|christian|church|faith|political|nonprofit|values|ethic)\b/i },
  { label: "Already reached out", test: /\balready\b|\bcontacted\b|\bknow them\b|\breached out\b/i },
];

// Map one raw reason to its concept label. Falls through to a normalized form of
// the raw text (lowercased, punctuation/apostrophes stripped) so unbucketed
// near-duplicates and typos still merge instead of splitting.
export function bucketDenyReason(raw: string): string {
  const r = String(raw || "").trim();
  if (!r) return "(no reason given)";
  for (const b of CONCEPT_BUCKETS) if (b.test.test(r)) return b.label;
  return r
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
