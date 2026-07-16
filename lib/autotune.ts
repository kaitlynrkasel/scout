// Closed-loop auto-tuning: reads real deny-reason data from the owner's own
// account, and, only once it crosses a confidence threshold, edits ONE named
// tunable clause in lib/discover.ts and commits it straight to main. No human
// review step, by design (see the chat that asked for "fully autonomous").
// The safety net is scope, not review: this can ONLY ever replace the full
// value of one of the TUNABLE_*_CLAUSE constants below, never arbitrary code,
// and every edit is validated for structural sanity before it's committed.

// Confidence gate at full platform scale (the conservative ceiling).
export const MIN_DECIDED = 20; // sample size floor before any auto-tune can fire
export const MIN_BUCKET_SHARE = 0.3; // a deny-reason bucket must be this share of denials
export const COOLDOWN_DAYS = 7; // minimum time between auto-tunes

export interface TuningThresholds {
  minDecided: number;
  minBucketShare: number;
  cooldownDays: number;
}
const DEFAULT_THRESHOLDS: TuningThresholds = {
  minDecided: MIN_DECIDED,
  minBucketShare: MIN_BUCKET_SHARE,
  cooldownDays: COOLDOWN_DAYS,
};

// Sensitivity scales with how many people the platform has. While it's small,
// there is little data, so learn from LESS of it and improve faster; as users
// grow, tighten automatically toward the conservative ceiling so one noisy
// account can't move shared code once many people depend on it. The universal
// auto-tune cron passes the live user count here each run.
export function tuningThresholds(totalUsers: number): TuningThresholds {
  if (totalUsers <= 15) return { minDecided: 8, minBucketShare: 0.25, cooldownDays: 2 };
  if (totalUsers <= 75) return { minDecided: 14, minBucketShare: 0.28, cooldownDays: 4 };
  return DEFAULT_THRESHOLDS;
}

// Personal calibration is per-user and never ships shared code, so it can be
// more sensitive than the universal gate: kick in on a user's own history
// sooner. Fixed low floor (no cooldown, it's rebuilt fresh each search).
const PERSONAL_THRESHOLDS: TuningThresholds = {
  minDecided: 8,
  minBucketShare: 0.25,
  cooldownDays: 0,
};

// The only two edit sites this system is allowed to touch. Each name must
// match an `export const NAME = \`...\`;` statement in lib/discover.ts, 
// exactly one backtick-delimited string, so regex extraction/replacement is
// unambiguous. Adding a new tunable clause means: (1) extract it into a named
// const in discover.ts the same way, (2) add an entry here.
export interface TunableSlot {
  constName: string;
  label: string;
  // Which bucketed deny-reason label(s) this clause is responsible for, 
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
  {
    // NUMERIC slot, not prose: the headline rank is computed from weighted
    // components (see TUNABLE_RANK_WEIGHTS in lib/discover.ts). When timing- or
    // contact-driven denials dominate, the right fix is shifting WEIGHT toward
    // that component, not another prose clause. The value must stay a valid
    // JSON object with keys relevance/reachability/timing/momentum (weights are
    // re-normalized and fall back to defaults if malformed, so a bad edit can't
    // break ranking).
    constName: "TUNABLE_RANK_WEIGHTS",
    label: "Headline rank weights (relevance/reachability/timing/momentum)",
    reasonBuckets: ["Wrong timing", "No way to contact"],
  },
];

// ---- Signal computation (server-side twin of learnedFromFinds in page.tsx,
// duck-typed against the DB row shape so this file has no client-component
// import) ----
interface MinimalFind {
  status: string;
  denyReason?: string;
  sentAt?: number;
  opp?: {
    fitScore?: number | null;
    channel?: string;
    contactEmail?: string;
    scores?: { timing?: number; momentum?: number; reachability?: number };
  };
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

// Does this signal clear the bar to fire an auto-tune at all? Thresholds default
// to the conservative ceiling; the cron passes user-count-scaled ones instead.
export function meetsThreshold(
  signal: TuningSignal,
  th: TuningThresholds = DEFAULT_THRESHOLDS
): boolean {
  return (
    signal.decided >= th.minDecided &&
    !!signal.topBucket &&
    signal.topBucket.share >= th.minBucketShare
  );
}

// Which tunable slot corresponds to the dominant deny-reason bucket, if any.
export function slotForSignal(signal: TuningSignal): TunableSlot | null {
  if (!signal.topBucket) return null;
  return (
    TUNABLE_SLOTS.find((s) => s.reasonBuckets.includes(signal.topBucket!.label)) || null
  );
}

// ---- Phase 4: reply-driven positive learning ----
// The deny-driven tuner above only ever gets STRICTER (it learns exclusively
// from rejections). This is the counterweight: when a user's real REPLIES show
// a pattern — replies cluster on personal-email contacts, or on candidates with
// hot timing — nudge the corresponding rank weight UP, deterministically (no
// LLM involved; arithmetic on TUNABLE_RANK_WEIGHTS).
export interface ReplyNudge {
  key: "reachability" | "timing";
  replied: number;
  evidence: string; // human-readable "what the replies showed"
}

const PERSONAL_EMAIL_RE =
  /^(careers?|jobs?|hr|recruit|talent|info|hello|contact|apply|admin|support|team|press|media|sales)@/i;
const REPLY_NUDGE_MIN_REPLIES = 5;

export function computeReplyNudge(finds: MinimalFind[]): ReplyNudge | null {
  const WEEK = 7 * 86400000;
  const now = Date.now();
  const replied = finds.filter((f) => f.status === "replied");
  if (replied.length < REPLY_NUDGE_MIN_REPLIES) return null;
  const silent = finds.filter(
    (f) => f.status === "sent" && f.sentAt && now - f.sentAt > WEEK
  );
  const personal = (f: MinimalFind) => {
    const e = String(f.opp?.contactEmail || "").trim();
    return !!e && !PERSONAL_EMAIL_RE.test(e);
  };
  const share = (arr: MinimalFind[]) =>
    arr.length ? arr.filter(personal).length / arr.length : null;

  const rShare = share(replied)!;
  const sShare = share(silent);
  if (rShare >= 0.7 && (sShare == null || rShare - sShare >= 0.2)) {
    return {
      key: "reachability",
      replied: replied.length,
      evidence: `${Math.round(rShare * 100)}% of replies came from contacts with a personal email address`,
    };
  }

  const avgTiming = (arr: MinimalFind[]) => {
    const vals = arr
      .map((f) => f.opp?.scores?.timing)
      .filter((v): v is number => typeof v === "number");
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };
  const rT = avgTiming(replied);
  const sT = avgTiming(silent);
  if (rT != null && rT >= 0.6 && (sT == null || rT - sT >= 0.15)) {
    return {
      key: "timing",
      replied: replied.length,
      evidence: `replies clustered on candidates with strong timing signals (avg ${Math.round(rT * 100)}% vs ${
        sT != null ? Math.round(sT * 100) + "%" : "n/a"
      } for unanswered outreach)`,
    };
  }
  return null;
}

// Deterministically shift TUNABLE_RANK_WEIGHTS toward `key`: +delta to the
// winning component, taken proportionally from the others, everything clamped
// to [0.05, 0.60] and re-normalized to sum 1. Returns the new JSON string, or
// null when the current value is unparseable or the weight is saturated.
export function nudgeWeights(
  currentJson: string,
  key: "relevance" | "reachability" | "timing" | "momentum",
  delta = 0.05
): string | null {
  let w: Record<string, number>;
  try {
    w = JSON.parse(currentJson);
  } catch {
    return null;
  }
  const keys = ["relevance", "reachability", "timing", "momentum"] as const;
  if (keys.some((k) => !Number.isFinite(Number(w[k])))) return null;
  if (Number(w[key]) >= 0.6) return null; // saturated — nothing to learn further
  const next: Record<string, number> = {};
  const othersMass = keys.filter((k) => k !== key).reduce((a, k) => a + Number(w[k]), 0);
  for (const k of keys) {
    next[k] =
      k === key
        ? Number(w[k]) + delta
        : Number(w[k]) - delta * (Number(w[k]) / (othersMass || 1));
  }
  for (const k of keys) next[k] = Math.min(0.6, Math.max(0.05, next[k]));
  const sum = keys.reduce((a, k) => a + next[k], 0);
  for (const k of keys) next[k] = Math.round((next[k] / sum) * 1000) / 1000;
  return JSON.stringify(next);
}

// ---- Individual calibration (personal, not committed to code) ----
// The universal auto-tune above edits shared code for everyone, gated high
// (20+ decided, 30%+ bucket share, 7-day cooldown) because a bad edit ships
// to every user. This is the OTHER tier: a per-request prompt override built
// fresh from THIS user's own signal, injected at the end of discover()'s
// prompts (see lib/discover.ts) so it wins over the universal baseline by
// being the most specific, most recent instruction, same mechanism
// coaching/dismissedAdvice already use for drafting. No LLM call, no commit,
// nothing to review: it's just data, formatted as a directive, gone the
// moment the request finishes. Reuses the SAME threshold as a floor so it
// never fires on a handful of noisy decisions.
export function buildPersonalOverride(signal: TuningSignal): string {
  if (!meetsThreshold(signal, PERSONAL_THRESHOLDS)) return "";
  const b = signal.topBucket!;
  const fitNote =
    signal.keptFit != null && signal.deniedFit != null
      ? ` This user's kept/denied avg fit is ${Math.round(signal.keptFit * 100)}%/${Math.round(signal.deniedFit * 100)}%.`
      : "";
  return (
    `PERSONAL CALIBRATION for this specific user (their own decision history, this takes priority over the general ` +
    `rules above, but YIELDS to any TEAM CALIBRATION): of their last ${signal.decided} decided finds, "${b.label}" is the ` +
    `reason ${Math.round(b.share * 100)}% of the time they pass (${b.count} instances). Weigh this failure mode more ` +
    `heavily for this search than the general instruction above.${fitNote}`
  );
}

// ---- Team calibration (company workspaces) ----
// The third and HIGHEST-priority tier, for users in a company. It aggregates
// the deny/keep signal across EVERYONE on the team: teammates pursue the same
// kinds of targets, so their collective decisions are the strongest steer.
// Precedence is team > personal > scout-wide (see discover.ts, where these are
// appended so the LLM reads team first and is told it overrides the rest).
export function buildTeamOverride(signal: TuningSignal): string {
  if (!meetsThreshold(signal, PERSONAL_THRESHOLDS)) return "";
  const b = signal.topBucket!;
  const fitNote =
    signal.keptFit != null && signal.deniedFit != null
      ? ` The team's kept/denied avg fit is ${Math.round(signal.keptFit * 100)}%/${Math.round(signal.deniedFit * 100)}%.`
      : "";
  return (
    `TEAM CALIBRATION for this user's company (aggregated across EVERYONE on the team, from what they collectively keep ` +
    `and pass on). This is the HIGHEST priority: it OVERRIDES the personal calibration and the general rules whenever they ` +
    `conflict. Across the team's last ${signal.decided} decided finds, "${b.label}" is the reason ${Math.round(
      b.share * 100
    )}% of the time they pass (${b.count} instances). The whole team is chasing the same kinds of targets, so weigh this ` +
    `shared failure mode most heavily of all.${fitNote}`
  );
}

// ---- Safe extraction / replacement of one tunable const's value ----
// Matches `export const NAME =\n  \`...content...\`;`, content must not
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

// Structural sanity check on the WHOLE file after a slot replacement, this
// is what stands in for human review. Fails closed: any doubt, skip the commit.
export function sanityCheck(original: string, revised: string): { ok: boolean; reason?: string } {
  if (!revised.trim()) return { ok: false, reason: "revised file is empty" };
  const lenRatio = revised.length / original.length;
  if (lenRatio < 0.85 || lenRatio > 1.15) {
    return { ok: false, reason: `file size changed by ${Math.round((lenRatio - 1) * 100)}%, expected a small in-place edit` };
  }
  // Every export the file had before must still be there, a corrupted edit
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
  // Backtick count must stay even, an unterminated template literal is the
  // single most likely way a naive edit breaks the build.
  const backticks = (revised.match(/`/g) || []).length;
  if (backticks % 2 !== 0) {
    return { ok: false, reason: "unbalanced backticks after edit" };
  }
  return { ok: true };
}
