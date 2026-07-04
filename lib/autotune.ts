// Closed-loop auto-tuning: reads real deny-reason data from the owner's own
// account, and — only once it crosses a confidence threshold — edits ONE named
// tunable clause in lib/discover.ts and commits it straight to main. No human
// review step, by design (see the chat that asked for "fully autonomous").
// The safety net is scope, not review: this can ONLY ever replace the full
// value of one of the TUNABLE_*_CLAUSE constants below, never arbitrary code,
// and every edit is validated for structural sanity before it's committed.

// Confidence gate — tune these three numbers to change how reckless this is.
export const MIN_DECIDED = 20; // sample size floor before any auto-tune can fire
export const MIN_BUCKET_SHARE = 0.3; // a deny-reason bucket must be this share of denials
export const COOLDOWN_DAYS = 7; // minimum time between auto-tunes

// The only two edit sites this system is allowed to touch. Each name must
// match an `export const NAME = \`...\`;` statement in lib/discover.ts —
// exactly one backtick-delimited string, so regex extraction/replacement is
// unambiguous. Adding a new tunable clause means: (1) extract it into a named
// const in discover.ts the same way, (2) add an entry here.
export interface TunableSlot {
  constName: string;
  label: string;
  // Which bucketed deny-reason label(s) this clause is responsible for —
  // used to decide which slot to edit when a bucket dominates.
  reasonBuckets: string[];
}
export const TUNABLE_SLOTS: TunableSlot[] = [
  {
    constName: "TUNABLE_INDUSTRY_ALIGNMENT_CLAUSE",
    label: "Industry alignment penalty (non-prospecting fitRules)",
    reasonBuckets: ["Wrong industry", "Genre / topic mismatch"],
  },
  {
    constName: "TUNABLE_LOCATION_ALIGNMENT_CLAUSE",
    label: "Location alignment penalty (non-prospecting fitRules)",
    reasonBuckets: ["Wrong location"],
  },
];

// ---- Signal computation (server-side twin of learnedFromFinds in page.tsx,
// duck-typed against the DB row shape so this file has no client-component
// import) ----
interface MinimalFind {
  status: string;
  denyReason?: string;
  opp?: { fitScore?: number | null; channel?: string };
}

const CONCEPT_BUCKETS: { label: string; test: RegExp }[] = [
  { label: "Wrong location", test: /\b(location|city|region|country|state|area|place|based|distant|near|far|remote|abroad|foreign|domestic)\b/i },
  { label: "Wrong industry", test: /\b(industry|field|sector|niche|category|market|space|vertical)\b/i },
  { label: "Wrong role or level", test: /\b(role|level|junior|senior|entry|position|title|seniority|too small|too big|too senior|too junior|wrong seniority)\b/i },
  { label: "Wrong timing", test: /\b(time|timing|deadline|closed|expired|past|future|old|stale|next year|next semester|fall|spring|summer|winter)\b/i },
  { label: "No way to contact", test: /\b(contact|reach|email|way|closed|no email|no phone|dm only|form only)\b/i },
  { label: "Genre / topic mismatch", test: /\b(country music|rock|pop|jazz|genre|topic|category|subject)\b/i },
  { label: "Already reached out", test: /\balready\b|\bcontacted\b|\bknow them\b/i },
];
function bucketReason(r: string): string {
  for (const b of CONCEPT_BUCKETS) if (b.test.test(r)) return b.label;
  return r;
}

export interface TuningSignal {
  decided: number;
  denied: number;
  keptFit: number | null;
  deniedFit: number | null;
  topBucket: { label: string; count: number; share: number } | null;
  allBuckets: [string, number][];
}

export function computeTuningSignal(finds: MinimalFind[]): TuningSignal {
  const decided = finds.filter((f) => f.status !== "new");
  const denied = decided.filter((f) => f.status === "denied");
  const kept = decided.filter(
    (f) => f.status === "drafted" || f.status === "sent" || f.status === "replied"
  );
  const avgFit = (arr: MinimalFind[]) => {
    const fs = arr.map((f) => f.opp?.fitScore).filter((v): v is number => typeof v === "number");
    return fs.length ? fs.reduce((a, b) => a + b, 0) / fs.length : null;
  };
  const bucketCounts: Record<string, number> = {};
  for (const f of denied) {
    const raw = (f.denyReason || "").trim();
    if (!raw) continue;
    const key = bucketReason(raw);
    bucketCounts[key] = (bucketCounts[key] || 0) + 1;
  }
  const allBuckets = Object.entries(bucketCounts).sort((a, b) => b[1] - a[1]);
  const bucketedTotal = allBuckets.reduce((a, [, n]) => a + n, 0);
  const top = allBuckets[0];
  const topBucket =
    top && bucketedTotal > 0
      ? { label: top[0], count: top[1], share: top[1] / bucketedTotal }
      : null;

  return {
    decided: decided.length,
    denied: denied.length,
    keptFit: avgFit(kept),
    deniedFit: avgFit(denied),
    topBucket,
    allBuckets,
  };
}

// Does this signal clear the bar to fire an auto-tune at all?
export function meetsThreshold(signal: TuningSignal): boolean {
  return (
    signal.decided >= MIN_DECIDED &&
    !!signal.topBucket &&
    signal.topBucket.share >= MIN_BUCKET_SHARE
  );
}

// Which tunable slot corresponds to the dominant deny-reason bucket, if any.
export function slotForSignal(signal: TuningSignal): TunableSlot | null {
  if (!signal.topBucket) return null;
  return (
    TUNABLE_SLOTS.find((s) => s.reasonBuckets.includes(signal.topBucket!.label)) || null
  );
}

// ---- Individual calibration (personal, not committed to code) ----
// The universal auto-tune above edits shared code for everyone, gated high
// (20+ decided, 30%+ bucket share, 7-day cooldown) because a bad edit ships
// to every user. This is the OTHER tier: a per-request prompt override built
// fresh from THIS user's own signal, injected at the end of discover()'s
// prompts (see lib/discover.ts) so it wins over the universal baseline by
// being the most specific, most recent instruction — same mechanism
// coaching/dismissedAdvice already use for drafting. No LLM call, no commit,
// nothing to review: it's just data, formatted as a directive, gone the
// moment the request finishes. Reuses the SAME threshold as a floor so it
// never fires on a handful of noisy decisions.
export function buildPersonalOverride(signal: TuningSignal): string {
  if (!meetsThreshold(signal)) return "";
  const b = signal.topBucket!;
  const fitNote =
    signal.keptFit != null && signal.deniedFit != null
      ? ` This user's kept/denied avg fit is ${Math.round(signal.keptFit * 100)}%/${Math.round(signal.deniedFit * 100)}%.`
      : "";
  return (
    `PERSONAL CALIBRATION for this specific user (their own decision history — this takes priority over the general ` +
    `rules above when they conflict): of their last ${signal.decided} decided finds, "${b.label}" is the reason ` +
    `${Math.round(b.share * 100)}% of the time they pass (${b.count} instances). Weigh this failure mode more heavily ` +
    `for this search than the general instruction above.${fitNote}`
  );
}

// ---- Safe extraction / replacement of one tunable const's value ----
// Matches `export const NAME =\n  \`...content...\`;` — content must not
// itself contain a backtick (enforced by generateNewClause below).
function slotRegex(constName: string): RegExp {
  return new RegExp(`export const ${constName} =\\s*\`([\\s\\S]*?)\`;`);
}

export function extractSlotValue(fileText: string, constName: string): string | null {
  const m = fileText.match(slotRegex(constName));
  return m ? m[1] : null;
}

export function replaceSlotValue(
  fileText: string,
  constName: string,
  newValue: string
): string | null {
  const re = slotRegex(constName);
  if (!re.test(fileText)) return null;
  // Escape $ so String.replace doesn't treat it as a capture-group reference.
  const safe = newValue.replace(/\$/g, "$$$$");
  return fileText.replace(re, `export const ${constName} =\n  \`${safe}\`;`);
}

// Structural sanity check on the WHOLE file after a slot replacement — this
// is what stands in for human review. Fails closed: any doubt, skip the commit.
export function sanityCheck(original: string, revised: string): { ok: boolean; reason?: string } {
  if (!revised.trim()) return { ok: false, reason: "revised file is empty" };
  const lenRatio = revised.length / original.length;
  if (lenRatio < 0.85 || lenRatio > 1.15) {
    return { ok: false, reason: `file size changed by ${Math.round((lenRatio - 1) * 100)}%, expected a small in-place edit` };
  }
  // Every export the file had before must still be there — a corrupted edit
  // that clobbers a function boundary would drop one of these.
  const exportNames = Array.from(original.matchAll(/export (?:async )?function (\w+)/g)).map(
    (m) => m[1]
  );
  for (const name of exportNames) {
    if (!revised.includes(`function ${name}`)) {
      return { ok: false, reason: `export "${name}" is missing from the revised file` };
    }
  }
  for (const slot of TUNABLE_SLOTS) {
    if (!revised.includes(`export const ${slot.constName}`)) {
      return { ok: false, reason: `${slot.constName} is missing from the revised file` };
    }
  }
  // Backtick count must stay even — an unterminated template literal is the
  // single most likely way a naive edit breaks the build.
  const backticks = (revised.match(/`/g) || []).length;
  if (backticks % 2 !== 0) {
    return { ok: false, reason: "unbalanced backticks after edit" };
  }
  return { ok: true };
}
