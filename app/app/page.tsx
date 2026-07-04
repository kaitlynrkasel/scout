"use client";

import { useEffect, useRef, useState } from "react";
import { ucInfo, ucKey, USE_CASE_SUGGESTIONS } from "@/lib/templates";
import type { Draft, Opportunity, OutreachTemplate, SourceRef } from "@/lib/types";
import type { Session } from "@supabase/supabase-js";
import AuthScreen from "./AuthScreen";
import CornerDog from "./CornerDog";
import { Reveal, CountUp, FadeIn } from "./motion";
import { ActivityChart, PipelineBar, MatchGauge, Sparkline } from "./charts";
import Tutorial, { type TourStep } from "./Tutorial";
import ImportOutreach from "./ImportOutreach";
import { fileToText } from "@/lib/fileText";
import {
  guessTimezone,
  isBusinessHours,
  localTimeLabel,
  nextBusinessLabel,
} from "@/lib/businessHours";
import {
  authEnabled,
  supabase,
  loadProfile as dbLoadProfile,
  saveProfile as dbSaveProfile,
  loadState as dbLoadState,
  saveState as dbSaveState,
  type AppState,
} from "@/lib/supabase";

const OUTREACH_KINDS = [
  "Email",
  "LinkedIn message",
  "Instagram DM",
  "TikTok DM",
  "X / Twitter DM",
  "Text message",
  "Cover letter",
  "Other",
];

// Suggested categories of search, seeded from the profile's use case. Users can
// add their own and remove any of these, so the options become their own.
// Keyed by ucKey() — the deep presets have tailored sets; anything else falls
// back to GENERIC_SUGGESTIONS.
const SUGGESTED: Record<string, { name: string; goal: string }[]> = {
  networking: [
    { name: "Coffee chats", goal: "professionals in my field open to a quick coffee or call" },
    { name: "Mentors", goal: "experienced people in my field open to mentoring" },
    { name: "Peers", goal: "people at a similar career stage in my field to connect with" },
    { name: "Industry leaders", goal: "well-known, respected leaders in my industry" },
  ],
  jobs: [
    { name: "Internships", goal: "internships in my field accepting applications" },
    { name: "Recruiters", goal: "recruiters and hiring managers in my field" },
    { name: "Coffee chats", goal: "people doing the job I want, for advice" },
    { name: "Part-time roles", goal: "part-time jobs in my field hiring now" },
  ],
  musicpr: [
    { name: "Playlist curators", goal: "playlist curators accepting submissions" },
    { name: "Press & blogs", goal: "music blogs and press that cover artists like me" },
    { name: "Radio", goal: "radio shows and stations that play my kind of music" },
    { name: "Cowriters", goal: "songwriters open to cowriting" },
  ],
};

// Fallback categories for any free-text use case that isn't one of the presets.
const GENERIC_SUGGESTIONS: { name: string; goal: string }[] = [
  { name: "Warm intros", goal: "people connected to my goal who could make a warm introduction" },
  { name: "Decision makers", goal: "the people who decide about what I'm reaching out about" },
  { name: "Peers", goal: "people doing similar work I can connect and share notes with" },
  { name: "Partners", goal: "people or organizations who could partner with me" },
];

// A stable per-user seed so discovery varies results between people (less overlap,
// less spam). Signed-in users key off their email; others get a persistent
// per-browser id.
function outreachSalt(accountEmail?: string): string {
  if (accountEmail) return accountEmail;
  try {
    let s = localStorage.getItem("scout_salt");
    if (!s) {
      s = Math.random().toString(36).slice(2, 12);
      localStorage.setItem("scout_salt", s);
    }
    return s;
  } catch {
    return "anon";
  }
}

// A compact, aggregate "people like you" directive for the query planner, derived
// from the cohort patterns. Empty when there's no real cohort yet.
function cohortHintFrom(community: CommunityStats | null): string {
  const c = community?.cohort;
  if (!c) return "";
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const bits: string[] = [];
  const top = c.patterns.channels?.[0];
  if (top) bits.push(`reach people most through ${top.channel} (${pct(top.keptRate)} acted on)`);
  if (c.patterns.fitKept != null) bits.push(`favor a strong, specific fit around ${pct(c.patterns.fitKept)}`);
  if (!bits.length) return "";
  return `Others doing "${c.useCase}" like this user tend to ${bits.join(" and ")}. Lean toward targets like that, while still keeping results niche and varied.`;
}

// Drop duplicate categories within the same project (same trimmed, case-folded
// name), keeping the first. Cleans up any dupes seeded across earlier sessions.
function dedupeCats<T extends { name: string; projectId: string }>(cats: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const c of cats) {
    const key = `${c.projectId}::${String(c.name || "").trim().toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

// Suggested categories for a use case: tailored set for a preset, generic otherwise.
function suggestionsFor(useCase: string): { name: string; goal: string }[] {
  return SUGGESTED[ucKey(useCase)] || GENERIC_SUGGESTIONS;
}

// Bump this when a stored payload's shape changes. `runSchemaMigrations` below
// reads the recorded version, walks any per-version steps, and writes the
// current one back. Keeps localStorage evolvable without silently corrupting
// data when the on-disk shape drifts from what the code expects.
const SCHEMA_VERSION = 1;
const SCHEMA_KEY = "scout_schema_version";

const TPL_KEY = "scout_templates";
const PROFILE_KEY = "scout_profile";
const CAT_KEY = "scout_categories";
const PROJECTS_KEY = "scout_projects";
const ACTIVE_KEY = "scout_active_project";
const ACT_KEY = "scout_activity";
const FINDS_KEY = "scout_finds";
const KIND_KEY = "scout_kind";
const COACH_KEY = "scout_coaching"; // approved dashboard tips applied to every draft
const EDITS_KEY = "scout_edit_pairs"; // learn-from-edits before/after voice deltas
const RESUME_KEY = "scout_resume_file"; // resume file (name + data URL) for attaching
const SIG_KEY = "scout_signature"; // email signature appended to drafts
const TOUR_KEY = "scout_tutorial_seen"; // "1" once the intro tour is finished or skipped

// Guided intro tour. Each step spotlights a sidebar item (matched by its
// data-tour id) and switches to that tab so the real screen shows behind.
const TOUR_STEPS: TourStep[] = [
  {
    tab: "dashboard",
    title: "Welcome to Scout",
    body: "Scout finds the right people and opportunities, then drafts warm, personalized outreach in your own voice. Here's a 60-second tour of how it works.",
  },
  {
    tab: "dashboard",
    target: "nav-dashboard",
    title: "Your Dashboard",
    body: "Your home base — a snapshot of activity, saved templates, and coaching tips that sharpen every draft over time.",
  },
  {
    tab: "outreach",
    target: "nav-outreach",
    title: "Find people & draft outreach",
    body: "Describe who you're trying to reach and Scout discovers matches, then drafts a message for each one in your voice. This is where most of your work happens.",
  },
  {
    tab: "outreach",
    target: "project-switcher",
    title: "Projects: one workspace per goal",
    body: "A project is a self-contained workspace — one per client, brand, or goal. Each keeps its own categories, finds, and context so pitches sound like they're really about that project.",
  },
  {
    tab: "outreach",
    target: "category-switcher",
    title: "Categories: presets for each kind of search",
    body: "Inside a project, categories are reusable search presets — e.g. \"brand partnerships\" vs \"press writers\" vs \"software engineering internships.\" Pick one to shape who Scout looks for, or type your own goal for a one-off search.",
  },
  {
    tab: "finds",
    target: "nav-finds",
    title: "Review your Finds",
    body: "Everyone Scout surfaces lands here. Approve the good ones, deny the rest, and send drafts straight from your connected mailbox.",
  },
  {
    tab: "templates",
    target: "nav-templates",
    title: "Save Templates",
    body: "Keep reusable message templates per channel, project, or category. Scout blends them with your voice so drafts start from something you trust.",
  },
  {
    tab: "profile",
    target: "nav-profile",
    title: "Set up your Profile",
    body: "Add your name and a short bio so Scout knows who's reaching out and can write as you. Connect Gmail or Outlook here to send in one click.",
  },
  {
    tab: "dashboard",
    title: "You're all set",
    body: "Start on the Outreach tab to run your first search. You can replay this tour anytime from “Take a tour” at the bottom of the sidebar.",
  },
];

// One-time rename of the old "cue_*" localStorage keys to "scout_*", so existing
// per-browser users keep their profile, projects, and finds after the rebrand.
// Copies each old value to the new key only when the new one isn't set yet, then
// drops the old key. Safe to call on every load (a no-op once migrated).
function migrateLegacyKeys() {
  try {
    const map: Record<string, string> = {
      cue_templates: TPL_KEY,
      cue_profile: PROFILE_KEY,
      cue_categories: CAT_KEY,
      cue_projects: PROJECTS_KEY,
      cue_active_project: ACTIVE_KEY,
      cue_activity: ACT_KEY,
      cue_finds: FINDS_KEY,
      cue_kind: KIND_KEY,
    };
    for (const [oldKey, newKey] of Object.entries(map)) {
      const val = localStorage.getItem(oldKey);
      if (val === null) continue;
      if (localStorage.getItem(newKey) === null) localStorage.setItem(newKey, val);
      localStorage.removeItem(oldKey);
    }
  } catch {}
}

// Walk any pending schema migrations, then record the current version. Add a
// case here when a stored payload's shape changes: read the old value, rewrite
// it, and set the version so the migration only runs once.
function runSchemaMigrations() {
  try {
    const raw = localStorage.getItem(SCHEMA_KEY);
    const stored = raw ? Number(raw) : 0;
    if (Number.isNaN(stored) || stored >= SCHEMA_VERSION) {
      // Still record the current version so the next migration has a floor.
      if (stored !== SCHEMA_VERSION) localStorage.setItem(SCHEMA_KEY, String(SCHEMA_VERSION));
      return;
    }
    // Future migrations go here, e.g.:
    // if (stored < 2) { /* rewrite FINDS_KEY entries to add a new field */ }
    localStorage.setItem(SCHEMA_KEY, String(SCHEMA_VERSION));
  } catch {}
}

interface Activity {
  searches: number;
  found: number;
  drafts: number;
  copies: number;
}
const ZERO_ACTIVITY: Activity = { searches: 0, found: 0, drafts: 0, copies: 0 };

// A competitiveness self-rating shapes internship / job discovery so a first-time
// applicant is pointed at accessible programs, not moonshot ones.
type Competitiveness = "any" | "beginner" | "intermediate" | "competitive";
type CompanySize = "any" | "small" | "big";

interface Profile {
  name: string;
  bio: string;
  useCase: string; // free text; matched to a preset when it can be, else read as-is
  linkedin?: string;
  // Optional personalization. Stored locally only for now (the Supabase
  // `profiles` row keeps its original columns; these ride along in the browser's
  // scout_profile blob and flow into aboutText so the LLM can use them).
  age?: number;
  college?: string;
  location?: string;
  companySize?: CompanySize;
  competitiveness?: Competitiveness;
}

// Natural-language directives the LLM respects when they're appended to the
// user's goal. Keeps the API surface unchanged.
const COMPETITIVENESS_HINTS: Record<Exclude<Competitiveness, "any">, string> = {
  beginner:
    "Focus on beginner-friendly opportunities: open to freshmen/sophomores or early-career applicants, minimal prerequisites, low-to-moderate selectivity. Avoid ultra-selective programs (e.g. Google STEP, Meta University, Jane Street, top hedge-fund/consulting internships).",
  intermediate:
    "Focus on mid-tier opportunities: growing companies and established mid-size firms, standard interview loops, open to applicants with a few projects or a prior internship.",
  competitive:
    "Focus on highly competitive, prestigious opportunities: top-tier tech / finance / consulting internships (FAANG, Jane Street, McKinsey, etc.), selective research programs, and elite fellowships.",
};
const COMPANY_SIZE_HINTS: Record<Exclude<CompanySize, "any">, string> = {
  small: "Prefer small companies, startups, and early-stage teams (under ~200 people).",
  big: "Prefer large, established companies and well-known brands (Fortune 500, big tech, major agencies).",
};
// A project is a self-contained workspace: its own use case, its own context
// (e.g. the specific artist you're reaching out for), and its own categories.
// A manager runs one project per artist; a job seeker might have just one.
interface Project {
  id: string;
  name: string;
  useCase: string;
  context: string; // who this outreach is for — fed into discovery + drafting
}
interface Category {
  id: string;
  name: string;
  goal: string;
  projectId: string; // categories belong to a project
}

// A find is a saved person/opportunity you can work through: draft, deny, mark
// contacted, and log replies. Finds accumulate across searches, per project.
type FindStatus = "new" | "drafted" | "sent" | "replied" | "denied";
interface Find {
  id: string; // stable dedup key: project + normalized name + host
  projectId: string;
  categoryId?: string; // which category's search surfaced this (for template scope)
  status: FindStatus;
  opp: Opportunity;
  draft?: Draft;
  addedAt: number;
  gmailThreadId?: string; // set when sent/drafted via Gmail — enables reply tracking
  outlookThreadId?: string; // Outlook conversation id — enables reply tracking
  denyReason?: string; // why the user passed on this find
  requirements?: string; // what this target asks for (pasted or found by deep-scan)
  sentAt?: number; // when the outreach actually went out (drives follow-up timing)
  lastFollowUpAt?: number; // when the most recent follow-up nudge was drafted/sent
  scanned?: boolean; // deep-scan has already run on this find's site
  pinned?: boolean; // pinned to the top of the finds list
  scheduledSendAt?: string; // ISO timestamp: when the queued send will fire (via cron)
  // Meeting / interview prep — factual highlights about the contact + outlet,
  // fetched via a fresh Tavily + Claude pass after the user updates status to
  // "sent" or "replied". Persists so re-opening the find shows the same facts.
  meetingPrep?: {
    generatedAt: string; // ISO timestamp
    facts: Array<{
      category: string;
      fact: string;
      source?: { title: string; url: string };
    }>;
  };
  application?: {
    overview?: string;
    howToApply?: string;
    components: any[]; // { title, kind, prompt, constraints, required, draft?, action? }
    generatedAt: number;
  };
}

// Does this use case look like a job / internship hunt? Mirrors the server's
// isJobUseCase so the client can offer full-application drafting for those.
function isJobUseCaseClient(useCase: string): boolean {
  return /\b(job|intern|hiring|hire|recruit|new ?grad|co-?op|career|apply|application)/i.test(
    useCase || ""
  );
}

// Quick reasons offered when passing on a find (plus free-text "Other").
const DENY_REASONS = [
  "Wrong industry",
  "Wrong role or level",
  "Wrong location",
  "No way to contact",
  "Not a real prospect",
  "Already reached out",
];

// Same normalization the discover engine uses so IDs match across the boundary.
// Strips role suffixes (", VP of…", " at Acme", " (Head of X)"), honorifics,
// name suffixes, and middle names/initials — then keeps first + last token.
// So "John Smith", "John J. Smith", "John Smith, Marketing Lead", and
// "Dr. John Smith Jr" all collapse to "johnsmith".
function normNameKey(s: string): string {
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
function urlHostKey(u: string): string {
  const m = String(u || "").match(/^https?:\/\/([^/?#]+)/i);
  return m ? m[1].replace(/^www\./, "").toLowerCase() : "";
}
// LinkedIn / Twitter / Instagram handles collapse to the same identity across
// different articles, so we can dedup even when spellings of the name differ.
function normHandleKey(h: string): string {
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
// The stable dedup key for a find. Kept as project + name + host for backward
// compatibility with finds already saved under the old key format. Cross-article
// merging (same person, different URL) is handled inside mergeFinds() so old
// IDs don't break.
function findKey(projectId: string, o: Opportunity): string {
  return `${projectId}::${normNameKey(o.name)}::${urlHostKey(o.url)}`;
}

// Aggregate community benchmarks + what's-working patterns from /api/community-stats.
interface CommunityStats {
  users: number;
  avgDenyRate: number | null;
  avgFinds: number | null;
  avgDrafts: number | null;
  avgFitKept: number | null;
  patterns?: {
    decidedFinds: number;
    channels: { channel: string; total: number; keptRate: number }[];
    fitKept: number | null;
    fitDenied: number | null;
    contextEffect: { withContext: number | null; withoutContext: number | null } | null;
  };
  // "People like you": patterns from users who share your use case (loose cohort).
  cohort?: {
    users: number;
    useCase: string;
    patterns: {
      decidedFinds: number;
      channels: { channel: string; total: number; keptRate: number }[];
      fitKept: number | null;
      fitDenied: number | null;
      contextEffect: { withContext: number | null; withoutContext: number | null } | null;
    };
  } | null;
}

const FIND_STATUSES: { key: FindStatus | "all"; label: string }[] = [
  { key: "new", label: "New" },
  { key: "drafted", label: "Drafted" },
  { key: "sent", label: "Sent" },
  { key: "replied", label: "Replied" },
  { key: "denied", label: "Denied" },
  { key: "all", label: "All" },
];

// Labels for the manual status control on each find.
const STATUS_OPTIONS: { key: FindStatus; label: string }[] = [
  { key: "new", label: "New" },
  { key: "drafted", label: "Drafted" },
  { key: "sent", label: "Sent" },
  { key: "replied", label: "Replied" },
  { key: "denied", label: "Not a fit" },
];

interface ScoutToolProps {
  initialProfile: Profile;
  onSaveProfile: (p: Profile) => void;
  onLogout?: () => void;
  showLogout?: boolean;
  // Returns the current Supabase access token, used to call the Gmail routes.
  // Absent in per-browser (no-auth) mode, which hides the Gmail features.
  getToken?: () => Promise<string | null>;
  // Account-synced app state (templates/projects/categories/activity). When
  // present, ScoutTool hydrates from it instead of localStorage and saves back.
  initialState?: AppState | null;
  onSaveState?: (state: AppState) => void;
  accountEmail?: string; // the signed-in user's email, for the Account section
}

// ---- Auth shell: login vs. tool; loads the profile from the account (or, if
// Supabase isn't configured yet, falls back to per-browser storage). ----
export default function AppShell() {
  return authEnabled ? <AuthedShell /> : <LocalShell />;
}

function Loading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-warm-fade">
      <div className="h-8 w-8 animate-spin rounded-full border-[3px] border-warm-border border-t-coral" />
    </div>
  );
}

function LocalShell() {
  const [ready, setReady] = useState(false);
  const [initial, setInitial] = useState<Profile>({ name: "", bio: "", useCase: "Networking" });
  useEffect(() => {
    try {
      const p = localStorage.getItem(PROFILE_KEY);
      if (p) setInitial({ name: "", bio: "", useCase: "Networking", ...JSON.parse(p) });
    } catch {}
    setReady(true);
  }, []);
  if (!ready) return <Loading />;
  return (
    <ScoutTool
      initialProfile={initial}
      onSaveProfile={(n) => {
        try {
          localStorage.setItem(PROFILE_KEY, JSON.stringify(n));
        } catch {}
      }}
    />
  );
}

function AuthedShell() {
  const [session, setSession] = useState<Session | null>(null);
  const [checked, setChecked] = useState(false);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [initial, setInitial] = useState<Profile>({ name: "", bio: "", useCase: "Networking" });
  const [initialState, setInitialState] = useState<AppState | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The latest state payloads pending a debounced write. Kept in refs so the
  // visibilitychange flush below can find them regardless of which render
  // last called onSaveProfile / onSaveState.
  const pendingProfile = useRef<Profile | null>(null);
  const pendingState = useRef<AppState | null>(null);

  // When the tab is about to go away (backgrounded, minimized, phone locked,
  // navigated), fire any pending saves immediately. visibilitychange==hidden
  // is the reliable cross-browser signal — beforeunload gets killed on mobile.
  useEffect(() => {
    if (!supabase) return;
    const flush = () => {
      if (document.visibilityState !== "hidden") return;
      const uid = session?.user?.id;
      if (!uid) return;
      if (saveTimer.current && pendingProfile.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
        const n = pendingProfile.current;
        pendingProfile.current = null;
        dbSaveProfile(uid, {
          name: n.name,
          bio: n.bio,
          useCase: n.useCase,
          linkedin: n.linkedin || "",
        });
      }
      if (stateTimer.current && pendingState.current) {
        clearTimeout(stateTimer.current);
        stateTimer.current = null;
        const s = pendingState.current;
        pendingState.current = null;
        dbSaveState(uid, s);
      }
    };
    document.addEventListener("visibilitychange", flush);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", flush);
      window.removeEventListener("pagehide", flush);
    };
  }, [session?.user?.id]);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setChecked(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s);
      setChecked(true);
      if (!s) setProfileLoaded(false);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const uid = session?.user?.id;
  useEffect(() => {
    if (!uid) return;
    let cancelled = false;
    setProfileLoaded(false);
    Promise.all([dbLoadProfile(uid), dbLoadState(uid)]).then(([p, s]) => {
      if (cancelled) return;
      // Merge the extras from three places, prefer server state over
      // localStorage (the fallback is only for the migration from the
      // browser-only era; after this ships, the server state is the
      // source of truth).
      const remoteExtras = s?.profileExtras || {};
      let localExtras: NonNullable<AppState["profileExtras"]> = {};
      try {
        const raw = localStorage.getItem(PROFILE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (typeof parsed.age === "number") localExtras.age = parsed.age;
          if (typeof parsed.college === "string") localExtras.college = parsed.college;
          if (typeof parsed.location === "string") localExtras.location = parsed.location;
          if (typeof parsed.companySize === "string") localExtras.companySize = parsed.companySize;
          if (typeof parsed.competitiveness === "string")
            localExtras.competitiveness = parsed.competitiveness;
        }
      } catch {
        /* localStorage unavailable — nothing to migrate */
      }
      const raw = { ...localExtras, ...remoteExtras };
      // AppState stores companySize/competitiveness as string; narrow to the
      // Profile enums here so we don't leak an unexpected value into state.
      const allowedSize = new Set<CompanySize>(["any", "small", "big"]);
      const allowedComp = new Set<Competitiveness>([
        "any",
        "beginner",
        "intermediate",
        "competitive",
      ]);
      const mergedExtras: Partial<Profile> = {};
      if (typeof raw.age === "number") mergedExtras.age = raw.age;
      if (typeof raw.college === "string") mergedExtras.college = raw.college;
      if (typeof raw.location === "string") mergedExtras.location = raw.location;
      if (raw.companySize && allowedSize.has(raw.companySize as CompanySize))
        mergedExtras.companySize = raw.companySize as CompanySize;
      if (raw.competitiveness && allowedComp.has(raw.competitiveness as Competitiveness))
        mergedExtras.competitiveness = raw.competitiveness as Competitiveness;
      setInitial(
        p
          ? {
              name: p.name,
              bio: p.bio,
              useCase: p.useCase || "Networking",
              linkedin: p.linkedin || "",
              ...mergedExtras,
            }
          : { name: "", bio: "", useCase: "Networking", linkedin: "", ...mergedExtras }
      );
      setInitialState(s);
      setProfileLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [uid]);

  if (!checked) return <Loading />;
  if (!session) return <AuthScreen />;
  if (!profileLoaded) return <Loading />;
  return (
    <ScoutTool
      key={session.user.id}
      initialProfile={initial}
      onSaveProfile={(n) => {
        pendingProfile.current = n;
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
          const payload = pendingProfile.current;
          pendingProfile.current = null;
          saveTimer.current = null;
          if (!payload) return;
          dbSaveProfile(session.user.id, {
            name: payload.name,
            bio: payload.bio,
            useCase: payload.useCase,
            linkedin: payload.linkedin || "",
          });
        }, 250);
      }}
      onLogout={() => supabase?.auth.signOut()}
      showLogout
      getToken={async () => {
        const { data } = await supabase!.auth.getSession();
        return data.session?.access_token ?? null;
      }}
      initialState={initialState}
      onSaveState={(s) => {
        pendingState.current = s;
        if (stateTimer.current) clearTimeout(stateTimer.current);
        stateTimer.current = setTimeout(() => {
          const payload = pendingState.current;
          pendingState.current = null;
          stateTimer.current = null;
          if (!payload) return;
          dbSaveState(session.user.id, payload);
        }, 250);
      }}
      accountEmail={session.user.email || ""}
    />
  );
}

function ScoutTool({
  initialProfile,
  onSaveProfile,
  onLogout,
  showLogout,
  getToken,
  initialState,
  onSaveState,
  accountEmail,
}: ScoutToolProps) {
  const [tab, setTab] = useState<
    "outreach" | "finds" | "dashboard" | "team" | "templates" | "profile" | "account" | "settings"
  >("dashboard");

  // ---- Outreach state ----
  const [tourOpen, setTourOpen] = useState(false); // intro tour overlay open?
  const [importOpen, setImportOpen] = useState(false); // CSV import modal open?
  // Is the signed-in user on the owner allowlist? Drives whether the Account
  // tab shows an "Admin" link into /admin. The Insights view itself lives on
  // its own route so customers never see any hint of it in the sidebar.
  const [isOwner, setIsOwner] = useState(false);
  // Per-search competitiveness override (defaults to the profile setting). "" =
  // inherit from profile; anything else overrides for this search only.
  const [searchComp, setSearchComp] = useState<"" | Competitiveness>("");
  const [catId, setCatId] = useState<string>(""); // selected category, "" = custom
  const [editingCats, setEditingCats] = useState(false); // category manager open?
  const [editingProjects, setEditingProjects] = useState(false); // project manager open?
  const [goal, setGoal] = useState("");
  const [discovering, setDiscovering] = useState(false);
  // When discovery started (ms epoch), so the progress bar can resume at the
  // right % after tab switches — SearchProgress is scoped to the Outreach tab
  // and remounts when the user comes back.
  const [discoverStartedAt, setDiscoverStartedAt] = useState<number | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState("");
  const [apiReason, setApiReason] = useState<string | null>(null); // 'credits'|'auth'|'rate'
  const [opps, setOpps] = useState<Opportunity[]>([]);
  // Per-candidate skip log surfaced from /api/discover, so the user (or you
  // while iterating on the extract prompt) can see exactly what got filtered.
  const [skipped, setSkipped] = useState<Array<{ title: string; url: string; reason: string }>>([]);
  const [showSkipped, setShowSkipped] = useState(false);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [drafts, setDrafts] = useState<Draft[]>([]);
  // Which outreach kind each draft is currently written for. Keyed by
  // opportunityId. Defaults to the auto-picked channel when unset.
  const [draftKind, setDraftKind] = useState<Record<string, string>>({});
  // opportunityId currently being re-drafted after a kind change.
  const [redraftBusyId, setRedraftBusyId] = useState("");
  const [stats, setStats] = useState("");
  const [expanded, setExpanded] = useState(false);

  // ---- Persisted state ----
  const [myTemplates, setMyTemplates] = useState<OutreachTemplate[]>([]);
  const [mtChannel, setMtChannel] = useState(OUTREACH_KINDS[0]);
  const [mtText, setMtText] = useState("");
  const [mtProjectId, setMtProjectId] = useState(""); // "" = all projects (global)
  const [mtCategoryId, setMtCategoryId] = useState(""); // "" = all categories in project
  const [profile, setProfile] = useState<Profile>(initialProfile);
  const [categories, setCategories] = useState<Category[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [activity, setActivity] = useState<Activity>(ZERO_ACTIVITY);
  const [finds, setFinds] = useState<Find[]>([]);
  const [findFilter, setFindFilter] = useState<FindStatus | "all">("new");
  const [findDraftingId, setFindDraftingId] = useState(""); // find being drafted
  // Coaching directives the user approved (applied to every draft) + the
  // before/after voice deltas learned from drafts they hand-edited.
  const [coaching, setCoaching] = useState<string[]>([]);
  const [editPairs, setEditPairs] = useState<{ before: string; after: string }[]>([]);
  // True after the user edits a draft while other un-sent drafts still exist —
  // Scout can re-write those with the freshly-learned voice. Cleared once the
  // user runs the refresh (or has no other drafts left to update).
  const [voiceRefreshAvailable, setVoiceRefreshAvailable] = useState(false);
  const [refreshingVoice, setRefreshingVoice] = useState(false);
  const [resumeFile, setResumeFile] = useState<{ name: string; dataUrl: string } | null>(null);
  const [signature, setSignature] = useState(""); // email signature appended to drafts
  const [scanningId, setScanningId] = useState(""); // find being deep-scanned
  const [followUpId, setFollowUpId] = useState(""); // find getting a follow-up draft
  const [applyingId, setApplyingId] = useState(""); // find getting a full application draft

  // ---- Gmail connection ----
  const [gmail, setGmail] = useState<{
    connected: boolean;
    email?: string;
    sendMode?: "draft" | "send";
  }>({ connected: false });
  const [gmailBusyId, setGmailBusyId] = useState(""); // draft being sent/drafted
  const [gmailSent, setGmailSent] = useState<Record<string, "draft" | "send">>({});
  const [gmailNote, setGmailNote] = useState(""); // message after the OAuth return

  // ---- Outlook connection (mirrors Gmail) ----
  const [outlook, setOutlook] = useState<{
    connected: boolean;
    email?: string;
    sendMode?: "draft" | "send";
  }>({ connected: false });
  const [outlookNote, setOutlookNote] = useState(""); // message after the OAuth return

  // ---- Community benchmarks (aggregate, everyone else) + account ----
  const [community, setCommunity] = useState<CommunityStats | null>(null);
  const [accountBusy, setAccountBusy] = useState("");
  const [accountNote, setAccountNote] = useState("");

  // True once initial hydration finishes, so the sync effect doesn't fire mid-load.
  const hydratedRef = useRef(false);

  // Load everything, then make sure at least one project exists (migrating any
  // pre-project categories into a default project the first time). When signed
  // in with account-synced state, hydrate from that; otherwise from localStorage
  // (per-browser mode, or an account's very first login which then seeds the DB).
  useEffect(() => {
    migrateLegacyKeys();
    runSchemaMigrations();
    const prof: Profile = initialProfile;
    let cats: Category[] = [];
    let projs: Project[] = [];
    let active = "";
    let tpls: OutreachTemplate[] = [];
    let act: Partial<Activity> | null = null;
    let savedFinds: Find[] = [];
    let coach: string[] = [];
    let edits: { before: string; after: string }[] = [];
    let resume: { name: string; dataUrl: string } | null = null;
    let sig = "";

    if (initialState && (initialState.projects?.length || initialState.templates?.length)) {
      cats = initialState.categories || [];
      projs = initialState.projects || [];
      active = initialState.activeId || "";
      tpls = initialState.templates || [];
      act = initialState.activity || null;
      savedFinds = initialState.finds || [];
      coach = initialState.coaching || [];
      edits = initialState.editPairs || [];
      resume = initialState.resumeFile || null;
      sig = initialState.signature || "";
    } else {
      try {
        const c = localStorage.getItem(CAT_KEY);
        if (c) cats = JSON.parse(c);
      } catch {}
      try {
        const p = localStorage.getItem(PROJECTS_KEY);
        if (p) projs = JSON.parse(p);
      } catch {}
      try {
        active = localStorage.getItem(ACTIVE_KEY) || "";
      } catch {}
      try {
        const t = localStorage.getItem(TPL_KEY);
        if (t) tpls = JSON.parse(t);
      } catch {}
      try {
        const a = localStorage.getItem(ACT_KEY);
        if (a) act = JSON.parse(a);
      } catch {}
      try {
        const f = localStorage.getItem(FINDS_KEY);
        if (f) savedFinds = JSON.parse(f);
      } catch {}
      try {
        const c = localStorage.getItem(COACH_KEY);
        if (c) coach = JSON.parse(c);
      } catch {}
      try {
        const e = localStorage.getItem(EDITS_KEY);
        if (e) edits = JSON.parse(e);
      } catch {}
      try {
        const rf = localStorage.getItem(RESUME_KEY);
        if (rf) resume = JSON.parse(rf);
      } catch {}
      try {
        sig = localStorage.getItem(SIG_KEY) || "";
      } catch {}
    }
    setMyTemplates(tpls);
    if (act) setActivity({ ...ZERO_ACTIVITY, ...act });
    setFinds(Array.isArray(savedFinds) ? savedFinds : []);
    setCoaching(Array.isArray(coach) ? coach : []);
    setEditPairs(Array.isArray(edits) ? edits : []);
    setResumeFile(resume && resume.dataUrl ? resume : null);
    setSignature(typeof sig === "string" ? sig : "");

    if (!projs.length) {
      // First run under the projects model. Create one empty project that
      // invites the user to name it and set their own use case — no seeded
      // name from the profile, no inherited use case. Categories still seed
      // from a blank use case (falls to GENERIC_SUGGESTIONS) so the user has
      // something to work from immediately.
      const def: Project = {
        id: `proj-${Date.now()}`,
        name: "Untitled project",
        useCase: "",
        context: "",
      };
      const migrated = cats.map((c: any) => ({
        id: c.id,
        name: c.name,
        goal: c.goal,
        projectId: def.id,
      }));
      cats = migrated.length ? migrated : seedForProject(def.id, def.useCase);
      projs = [def];
      active = def.id;
      saveProjectsRaw(projs);
      saveActiveRaw(active);
      saveCats(cats);
    }
    if (!projs.some((p) => p.id === active)) active = projs[0].id;

    // Clean up any duplicate categories from earlier seeding before showing them.
    const cleaned = dedupeCats(cats);
    if (cleaned.length !== cats.length) {
      cats = cleaned;
      try {
        localStorage.setItem(CAT_KEY, JSON.stringify(cats));
      } catch {}
    }

    setProfile(prof);
    setProjects(projs);
    setActiveId(active);
    setCategories(cats);

    const proj = projs.find((p) => p.id === active) || projs[0];
    const mine = cats.filter((c) => c.projectId === proj.id);
    if (mine.length) {
      setCatId(mine[0].id);
      setGoal(mine[0].goal);
    } else {
      setCatId("");
      setGoal(ucInfo(proj.useCase).exampleGoal);
    }
  }, []);

  // Once hydrated, mirror app state to the account (debounced by the parent) so
  // templates, projects, categories, and activity follow the user across devices.
  useEffect(() => {
    if (!onSaveState || !hydratedRef.current) return;
    onSaveState({
      templates: myTemplates,
      projects,
      categories,
      activeId,
      activity,
      finds,
      coaching,
      editPairs,
      resumeFile,
      signature,
      // Ride the extras along in the JSON blob so they survive a redeploy.
      // The profiles table only has name/bio/useCase/linkedin; everything else
      // lived in localStorage before this — which meant it evaporated on any
      // fresh hydrate.
      profileExtras: {
        age: profile.age,
        college: profile.college,
        location: profile.location,
        companySize: profile.companySize,
        competitiveness: profile.competitiveness,
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myTemplates, projects, categories, activeId, activity, finds, coaching, editPairs, resumeFile, signature, profile.age, profile.college, profile.location, profile.companySize, profile.competitiveness]);

  // Flip the hydrated flag AFTER the sync effect's first (skipped) run, so the
  // sync only fires on genuine post-load changes, never on the initial values.
  useEffect(() => {
    hydratedRef.current = true;
  }, []);

  // Auto-launch the intro tour once, for first-time users. Runs after mount so
  // the sidebar targets exist to spotlight.
  useEffect(() => {
    try {
      if (!localStorage.getItem(TOUR_KEY)) {
        const t = setTimeout(() => setTourOpen(true), 400);
        return () => clearTimeout(t);
      }
    } catch {
      /* localStorage unavailable — skip the tour rather than crash */
    }
  }, []);

  // Probe /api/admin/whoami on load. Server never leaks the allowlist —
  // returns { owner: false } for anyone not on it, so a normal customer
  // gets no hint the admin surface exists.
  useEffect(() => {
    if (!getToken) return;
    let cancelled = false;
    (async () => {
      try {
        const token = await getToken();
        if (!token) return;
        const res = await fetch("/api/admin/whoami", {
          headers: { authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        const body = await res.json();
        if (!cancelled) setIsOwner(!!body?.owner);
      } catch {
        /* silent — user is just treated as non-owner */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [getToken]);


  function startTour() {
    setTourOpen(true);
  }

  // Download everything Scout has stored for this user as one JSON file.
  // Runs entirely client-side — nothing leaves the browser except the download.
  function exportMyData() {
    try {
      const payload = {
        exportedAt: new Date().toISOString(),
        profile,
        projects,
        categories,
        finds,
        templates: myTemplates,
        coaching,
        editPairs,
        signature,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `scout-export-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      setError(e?.message || "Couldn't export your data.");
    }
  }
  function endTour() {
    setTourOpen(false);
    try {
      localStorage.setItem(TOUR_KEY, "1");
    } catch {
      /* ignore */
    }
  }

  function seedForProject(projectId: string, uc: string): Category[] {
    return suggestionsFor(uc).map((s, i) => ({
      id: `sug-${projectId}-${i}`,
      name: s.name,
      goal: s.goal,
      projectId,
    }));
  }
  const saveTpls = (n: OutreachTemplate[]) => {
    setMyTemplates(n);
    try {
      localStorage.setItem(TPL_KEY, JSON.stringify(n));
    } catch {}
  };
  // Merge a partial update into the profile using a functional state update, so
  // several field updates fired in a row (e.g. resume autofill setting bio, then
  // name, then use case) never clobber each other via a stale closure.
  const patchProfile = (patch: Partial<Profile>) => {
    setProfile((prev) => {
      const next = { ...prev, ...patch };
      onSaveProfile(next);
      return next;
    });
  };
  const saveCats = (n: Category[]) => {
    setCategories(n);
    try {
      localStorage.setItem(CAT_KEY, JSON.stringify(n));
    } catch {}
  };
  const saveFinds = (n: Find[]) => {
    setFinds(n);
    try {
      localStorage.setItem(FINDS_KEY, JSON.stringify(n));
    } catch {}
  };
  const saveCoaching = (n: string[]) => {
    setCoaching(n);
    try {
      localStorage.setItem(COACH_KEY, JSON.stringify(n));
    } catch {}
  };
  // Approve a dashboard tip: dedupe, keep the most recent 8 (draft.ts caps there).
  const addCoaching = (tip: string) => {
    const t = String(tip || "").trim();
    if (!t) return;
    saveCoaching([t, ...coaching.filter((c) => c.toLowerCase() !== t.toLowerCase())].slice(0, 8));
  };
  const removeCoaching = (tip: string) => {
    saveCoaching(coaching.filter((c) => c !== tip));
  };
  const saveEditPairs = (n: { before: string; after: string }[]) => {
    setEditPairs(n);
    try {
      localStorage.setItem(EDITS_KEY, JSON.stringify(n));
    } catch {}
  };
  const saveResumeFile = (n: { name: string; dataUrl: string } | null) => {
    setResumeFile(n);
    try {
      if (n) localStorage.setItem(RESUME_KEY, JSON.stringify(n));
      else localStorage.removeItem(RESUME_KEY);
    } catch {}
  };
  const saveSignature = (n: string) => {
    setSignature(n);
    try {
      localStorage.setItem(SIG_KEY, n);
    } catch {}
  };
  // Keep an uploaded resume FILE (as a data URL) so it can be attached to emails.
  // Capped at ~5MB so we don't bloat account state; larger files are declined.
  async function storeResumeFile(file: File) {
    if (file.size > 5 * 1024 * 1024) {
      setError("That resume file is over 5MB. Attach a smaller file.");
      return;
    }
    const dataUrl: string = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result || ""));
      r.onerror = () => reject(new Error("read failed"));
      r.readAsDataURL(file);
    });
    if (dataUrl) saveResumeFile({ name: file.name, dataUrl });
  }
  // Record how the user rewrote a draft. Only keep it if the change is real
  // (not a trivial tweak) so we teach voice, not noise. Newest 6 retained.
  const recordEdit = (before: string, after: string, editedFindId?: string) => {
    const a = String(after || "").trim();
    const b = String(before || "").trim();
    if (!a || a === b) return;
    // Skip near-identical edits (a couple of chars) to avoid teaching noise.
    if (Math.abs(a.length - b.length) < 8 && a.slice(0, 40) === b.slice(0, 40)) return;
    saveEditPairs([{ before: b, after: a }, ...editPairs].slice(0, 6));
    // If the user still has other un-sent drafts, offer to re-write them with
    // this freshly-learned voice. Only "drafted" finds are eligible — sent or
    // replied ones already went out and shouldn't change.
    const otherDrafts = finds.filter(
      (f) => f.id !== editedFindId && f.status === "drafted" && f.draft?.body
    );
    if (otherDrafts.length > 0) setVoiceRefreshAvailable(true);
  };
  // Bump real activity counters (searches run, people found, drafts written,
  // drafts copied to send). Honest usage, no invented metrics.
  const bumpActivity = (patch: Partial<Activity>) => {
    setActivity((prev) => {
      const next: Activity = {
        searches: prev.searches + (patch.searches || 0),
        found: prev.found + (patch.found || 0),
        drafts: prev.drafts + (patch.drafts || 0),
        copies: prev.copies + (patch.copies || 0),
      };
      try {
        localStorage.setItem(ACT_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  };
  // Load Gmail connection status once (and after returning from the OAuth flow).
  const refreshGmail = async () => {
    if (!getToken) return;
    const token = await getToken();
    if (!token) return;
    try {
      const r = await fetch("/api/gmail/status", {
        headers: { authorization: `Bearer ${token}` },
      });
      if (r.ok) setGmail(await r.json());
    } catch {}
  };
  // Load Outlook connection status once (and after returning from the OAuth flow).
  const refreshOutlook = async () => {
    if (!getToken) return;
    const token = await getToken();
    if (!token) return;
    try {
      const r = await fetch("/api/outlook/status", {
        headers: { authorization: `Bearer ${token}` },
      });
      if (r.ok) setOutlook(await r.json());
    } catch {}
  };
  // Load aggregate community benchmarks (averages only, no individual data).
  const refreshCommunity = async () => {
    if (!getToken) return;
    const token = await getToken();
    if (!token) return;
    try {
      const r = await fetch(
        `/api/community-stats?useCase=${encodeURIComponent(activeUseCase || "")}`,
        { headers: { authorization: `Bearer ${token}` } }
      );
      if (r.ok) setCommunity(await r.json());
    } catch {}
  };

  // Change the account password (Supabase handles it with the current session).
  const changePassword = async (pw: string) => {
    if (!supabase || pw.length < 6) {
      setAccountNote("Password must be at least 6 characters.");
      return;
    }
    setAccountBusy("password");
    setAccountNote("");
    const { error } = await supabase.auth.updateUser({ password: pw });
    setAccountBusy("");
    setAccountNote(error ? error.message : "Password updated.");
  };

  // Permanently delete the account and all data, then sign out.
  const deleteAccount = async () => {
    if (!getToken) return;
    const token = await getToken();
    if (!token) return;
    setAccountBusy("delete");
    try {
      const r = await fetch("/api/account/delete", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      const j = await r.json();
      if (r.ok) {
        await supabase?.auth.signOut();
      } else {
        setAccountNote(j.error || "Couldn't delete the account.");
      }
    } catch (e: any) {
      setAccountNote(e?.message || "Couldn't delete the account.");
    } finally {
      setAccountBusy("");
    }
  };

  useEffect(() => {
    refreshGmail();
    refreshOutlook();
    refreshCommunity();
    // Handle the return from Google's / Microsoft's consent screen.
    try {
      const p = new URLSearchParams(window.location.search);
      const g = p.get("gmail");
      if (g) {
        setTab("profile");
        setGmailNote(
          g === "connected"
            ? "Gmail connected."
            : g === "norefresh"
            ? "Almost there, reconnect and allow access to finish."
            : "Couldn't connect Gmail. Please try again."
        );
      }
      const o = p.get("outlook");
      if (o) {
        setTab("profile");
        setOutlookNote(
          o === "connected"
            ? "Outlook connected."
            : o === "norefresh"
            ? "Almost there, reconnect and allow access to finish."
            : "Couldn't connect Outlook. Please try again."
        );
      }
      if (g || o) {
        const u = new URL(window.location.href);
        u.searchParams.delete("gmail");
        u.searchParams.delete("outlook");
        window.history.replaceState({}, "", u.toString());
      }
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setGmailMode = async (mode: "draft" | "send") => {
    if (!getToken) return;
    setGmail((g) => ({ ...g, sendMode: mode })); // optimistic
    const token = await getToken();
    if (!token) return;
    await fetch("/api/gmail/mode", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ mode }),
    });
  };

  const connectGmail = async () => {
    if (!getToken) return;
    const token = await getToken();
    if (!token) return;
    const r = await fetch("/api/gmail/auth", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    const j = await r.json();
    if (j.url) window.location.href = j.url;
    else setError(j.error || "Couldn't start the Gmail connection.");
  };

  const disconnectGmail = async () => {
    if (!getToken) return;
    const token = await getToken();
    if (!token) return;
    await fetch("/api/gmail/disconnect", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    setGmail({ connected: false });
  };

  // Create a draft in / send from the user's Gmail for one message. Returns the
  // mode ("draft"/"send") on success, or null on failure. Also stores the Gmail
  // thread id on the matching pipeline find (and flips it to sent when sending),
  // so replies in that thread can be tracked later.
  const sendViaGmail = async (
    d: Draft,
    threadId?: string
  ): Promise<"draft" | "send" | null> => {
    if (!getToken) return null;
    const token = await getToken();
    if (!token) return null;
    setError("");
    setGmailBusyId(d.opportunityId);
    // Attach the resume only when this email opted in AND we actually have one.
    const attachment =
      d.channelType === "email" && d.attachResume && resumeFile
        ? { name: resumeFile.name, dataUrl: resumeFile.dataUrl }
        : undefined;
    try {
      const r = await fetch("/api/gmail/send", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          to: d.to,
          subject: d.subject,
          body: d.body,
          threadId: threadId || undefined,
          attachment,
        }),
      });
      const j = await parseApiResponse(r);
      if (r.ok && !j?.error) {
        setGmailSent((s) => ({ ...s, [d.opportunityId]: j.mode }));
        bumpActivity({ copies: 1 });
        setFinds((prev) => {
          const next = prev.map((f) =>
            f.draft?.opportunityId === d.opportunityId
              ? {
                  ...f,
                  gmailThreadId: j.threadId || f.gmailThreadId,
                  status: (j.mode === "send" ? "sent" : f.status) as FindStatus,
                  sentAt: j.mode === "send" && !f.sentAt ? Date.now() : f.sentAt,
                }
              : f
          );
          try {
            localStorage.setItem(FINDS_KEY, JSON.stringify(next));
          } catch {}
          return next;
        });
        return j.mode as "draft" | "send";
      }
      reportError(j);
      return null;
    } catch (e: any) {
      setError(e?.message || "Gmail request failed.");
      return null;
    } finally {
      setGmailBusyId("");
    }
  };

  // ---- Outlook actions (mirror Gmail) ----
  const setOutlookMode = async (mode: "draft" | "send") => {
    if (!getToken) return;
    setOutlook((o) => ({ ...o, sendMode: mode })); // optimistic
    const token = await getToken();
    if (!token) return;
    await fetch("/api/outlook/mode", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ mode }),
    });
  };

  const connectOutlook = async () => {
    if (!getToken) return;
    const token = await getToken();
    if (!token) return;
    const r = await fetch("/api/outlook/auth", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    const j = await r.json();
    if (j.url) window.location.href = j.url;
    else setError(j.error || "Couldn't start the Outlook connection.");
  };

  const disconnectOutlook = async () => {
    if (!getToken) return;
    const token = await getToken();
    if (!token) return;
    await fetch("/api/outlook/disconnect", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    setOutlook({ connected: false });
  };

  // Create a draft in / send from the user's Outlook for one message. Shares the
  // mailbox busy/sent state so the send buttons work for whichever provider is on.
  const sendViaOutlook = async (d: Draft): Promise<"draft" | "send" | null> => {
    if (!getToken) return null;
    const token = await getToken();
    if (!token) return null;
    setError("");
    setGmailBusyId(d.opportunityId);
    try {
      const r = await fetch("/api/outlook/send", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ to: d.to, subject: d.subject, body: d.body }),
      });
      const j = await parseApiResponse(r);
      if (r.ok && !j?.error) {
        setGmailSent((s) => ({ ...s, [d.opportunityId]: j.mode }));
        bumpActivity({ copies: 1 });
        setFinds((prev) => {
          const next = prev.map((f) =>
            f.draft?.opportunityId === d.opportunityId
              ? {
                  ...f,
                  outlookThreadId: j.threadId || f.outlookThreadId,
                  status: (j.mode === "send" ? "sent" : f.status) as FindStatus,
                }
              : f
          );
          try {
            localStorage.setItem(FINDS_KEY, JSON.stringify(next));
          } catch {}
          return next;
        });
        return j.mode as "draft" | "send";
      }
      reportError(j);
      return null;
    } catch (e: any) {
      setError(e?.message || "Outlook request failed.");
      return null;
    } finally {
      setGmailBusyId("");
    }
  };

  // The mailbox used for one-click send/draft: Gmail if connected, else Outlook.
  const activeMailbox = gmail.connected
    ? {
        connected: true,
        email: gmail.email,
        sendMode: gmail.sendMode,
        provider: "gmail" as const,
        label: "Gmail",
      }
    : outlook.connected
    ? {
        connected: true,
        email: outlook.email,
        sendMode: outlook.sendMode,
        provider: "outlook" as const,
        label: "Outlook",
      }
    : {
        connected: false,
        email: "",
        sendMode: "draft" as const,
        provider: null,
        label: "",
      };

  // threadId threads a Gmail follow-up into an existing conversation (Outlook
  // threading isn't wired yet, so it ignores it).
  const sendViaMailbox = (
    d: Draft,
    threadId?: string
  ): Promise<"draft" | "send" | null> =>
    activeMailbox.provider === "outlook" ? sendViaOutlook(d) : sendViaGmail(d, threadId);

  const saveProjectsRaw = (n: Project[]) => {
    try {
      localStorage.setItem(PROJECTS_KEY, JSON.stringify(n));
    } catch {}
  };
  const saveProjects = (n: Project[]) => {
    setProjects(n);
    saveProjectsRaw(n);
  };
  const saveActiveRaw = (id: string) => {
    try {
      localStorage.setItem(ACTIVE_KEY, id);
    } catch {}
  };

  function resetResults() {
    setOpps([]);
    setSelected({});
    setDrafts([]);
    setStats("");
    setError("");
    setApiReason(null);
    setSkipped([]);
    setShowSkipped(false);
  }

  // Read a fetch Response safely: prefers JSON but falls back to a friendly
  // error object when the body is HTML/text (Vercel serverless timeout,
  // Anthropic error page, network middleware). Turns "Unexpected token 'A'…"
  // into a real message the user can act on.
  async function parseApiResponse(res: Response): Promise<any> {
    const text = await res.text().catch(() => "");
    // Empty body — trust the HTTP status.
    if (!text.trim()) {
      if (res.ok) return {};
      return {
        error:
          res.status === 504 || res.status === 408
            ? "The server took too long to respond. Try a narrower goal, or run it again."
            : `Request failed (HTTP ${res.status}).`,
      };
    }
    // Try JSON first — every well-behaved route returns it.
    try {
      return JSON.parse(text);
    } catch {
      // The body is HTML / plain text. Extract a short snippet so the user
      // can tell what happened without being buried in a stack trace.
      const snippet = text
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 180);
      const looksTimeout = /timed?\s?out|took too long|504|gateway/i.test(snippet);
      return {
        error: looksTimeout
          ? "The server took too long to respond. Try a narrower goal, or run it again."
          : `Server error: ${snippet || `HTTP ${res.status}`}`,
      };
    }
  }

  // Show the message from a failed API response, flagging credit/key/limit issues.
  function reportError(data: any) {
    setError(data?.error || "Something went wrong. Please try again.");
    setApiReason(data?.credit ? data.reason || "credits" : null);
  }

  // From the Profile tab: set the personal default use case (used for new
  // projects) and apply it to the project you're currently in.
  function changeUseCase(uc: string) {
    patchProfile({ useCase: uc });
    if (activeId) setProjectUseCase(activeId, uc);
  }

  // Set a project's use case; seed its categories if it has none yet.
  function setProjectUseCase(id: string, uc: string) {
    saveProjects(projects.map((p) => (p.id === id ? { ...p, useCase: uc } : p)));
    if (!categories.some((c) => c.projectId === id)) {
      const seeded = seedForProject(id, uc);
      saveCats([...categories, ...seeded]);
      if (id === activeId && seeded.length) {
        setCatId(seeded[0].id);
        setGoal(seeded[0].goal);
      }
    }
  }

  // ---- Projects ----
  function selectProject(id: string) {
    setActiveId(id);
    saveActiveRaw(id);
    setEditingProjects(false);
    const proj = projects.find((p) => p.id === id);
    const mine = categories.filter((c) => c.projectId === id);
    if (mine.length) {
      setCatId(mine[0].id);
      setGoal(mine[0].goal);
    } else {
      setCatId("");
      setGoal(proj ? ucInfo(proj.useCase).exampleGoal : "");
    }
    resetResults();
  }

  function addProject(name: string) {
    const nm = name.trim();
    if (!nm) return;
    const activeProj = projects.find((p) => p.id === activeId);
    const useCase = activeProj ? activeProj.useCase : profile.useCase;
    const proj: Project = { id: `proj-${Date.now()}`, name: nm, useCase, context: "" };
    saveProjects([...projects, proj]);
    const seeded = seedForProject(proj.id, useCase);
    saveCats([...categories, ...seeded]);
    setActiveId(proj.id);
    saveActiveRaw(proj.id);
    setCatId(seeded[0]?.id || "");
    setGoal(seeded[0]?.goal || "");
    resetResults();
  }

  function renameProject(id: string, name: string) {
    const nm = name.trim();
    if (!nm) return;
    saveProjects(projects.map((p) => (p.id === id ? { ...p, name: nm } : p)));
  }

  function removeProject(id: string) {
    if (projects.length <= 1) return; // always keep at least one project
    const nextProjects = projects.filter((p) => p.id !== id);
    saveProjects(nextProjects);
    saveCats(categories.filter((c) => c.projectId !== id));
    if (activeId === id) selectProject(nextProjects[0].id);
  }

  function setProjectContext(id: string, context: string) {
    saveProjects(projects.map((p) => (p.id === id ? { ...p, context } : p)));
  }

  // Prefill identity fields after Scout reads a resume. Keeps a name the user
  // already typed; sets the inferred use case (which reseeds its categories).
  // Bio is set separately (immediately) so nothing is lost if parsing fails.
  function autofillIdentity(
    name?: string,
    useCase?: string,
    extras?: {
      age?: number | null;
      education?: string;
      location?: string;
      companySize?: string;
      competitiveness?: string;
    }
  ) {
    // Only fill fields the user hasn't set — a resume drop never overwrites
    // something they typed. Every field is optional coming from the API.
    setProfile((prev) => {
      const next: Profile = { ...prev };
      let changed = false;
      if (name && name.trim() && !(prev.name && prev.name.trim())) {
        next.name = name.trim();
        changed = true;
      }
      if (
        typeof extras?.age === "number" &&
        Number.isFinite(extras.age) &&
        !prev.age
      ) {
        next.age = extras.age;
        changed = true;
      }
      if (extras?.education && extras.education.trim() && !(prev.college && prev.college.trim())) {
        next.college = extras.education.trim();
        changed = true;
      }
      if (extras?.location && extras.location.trim() && !(prev.location && prev.location.trim())) {
        next.location = extras.location.trim();
        changed = true;
      }
      const size = extras?.companySize;
      if (
        (size === "any" || size === "small" || size === "big") &&
        (!prev.companySize || prev.companySize === "any")
      ) {
        next.companySize = size;
        changed = true;
      }
      const comp = extras?.competitiveness;
      if (
        (comp === "any" || comp === "beginner" || comp === "intermediate" || comp === "competitive") &&
        (!prev.competitiveness || prev.competitiveness === "any")
      ) {
        next.competitiveness = comp;
        changed = true;
      }
      if (!changed) return prev;
      onSaveProfile(next);
      return next;
    });
    if (useCase && useCase.trim()) changeUseCase(useCase.trim());
  }

  function selectCategory(id: string) {
    setCatId(id);
    const c = categories.find((x) => x.id === id);
    if (c) setGoal(c.goal);
    resetResults();
  }

  // "+ Save Search": save the current goal text as a new named category in the
  // active project.
  function addCategory() {
    const name = window.prompt("Name this search:", "");
    if (!name || !name.trim()) return;
    const c: Category = {
      id: `cat-${Date.now()}`,
      name: name.trim(),
      goal: goal,
      projectId: activeId,
    };
    saveCats([...categories, c]);
    setCatId(c.id);
  }

  // Category manager (pencil): add a fresh empty category and select it.
  function addCategoryNamed(name: string) {
    const nm = name.trim();
    if (!nm) return;
    const c: Category = {
      id: `cat-${Date.now()}`,
      name: nm,
      goal: "",
      projectId: activeId,
    };
    saveCats([...categories, c]);
    setCatId(c.id);
    setGoal("");
    resetResults();
  }

  // Add a category to a SPECIFIC project (used by the Profile editor, where you
  // may be editing a project that isn't the active one). An optional goal lets
  // the caller pass a known search goal (from a suggestion or derived from the
  // name) so discovery understands what the category is looking for.
  function addCategoryToProject(projectId: string, name: string, goal = "") {
    const nm = name.trim();
    if (!nm) return;
    // Don't add a category this project already has (same name, case-insensitive).
    const exists = categories.some(
      (c) => c.projectId === projectId && c.name.trim().toLowerCase() === nm.toLowerCase()
    );
    if (exists) return;
    const c: Category = {
      id: `cat-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: nm,
      goal: goal || "",
      projectId,
    };
    saveCats([...categories, c]);
  }

  // Reorder a project's categories to match the given id order (drag and drop).
  function reorderCategoriesInProject(projectId: string, orderedIds: string[]) {
    const mine = categories.filter((c) => c.projectId === projectId);
    const byId = new Map(mine.map((c) => [c.id, c] as const));
    const seq = orderedIds.map((id) => byId.get(id)).filter(Boolean) as Category[];
    for (const c of mine) if (!orderedIds.includes(c.id)) seq.push(c); // safety
    let i = 0;
    // Rewrite this project's slots in place, leaving other projects untouched.
    const next = categories.map((c) => (c.projectId === projectId ? seq[i++] : c));
    saveCats(next);
  }

  // Delete several categories at once (multi-select). Keeps the active category
  // valid if it was among those removed.
  function removeCategoriesBulk(ids: string[]) {
    const set = new Set(ids);
    const next = categories.filter((c) => !set.has(c.id));
    saveCats(next);
    if (set.has(catId)) {
      const mine = next.filter((c) => c.projectId === activeId);
      if (mine.length) {
        setCatId(mine[0].id);
        setGoal(mine[0].goal);
      } else {
        setCatId("");
      }
    }
  }

  // Ask the API to turn a typed category name into a concrete search goal so
  // discovery knows who to look for. Falls back to the raw name on any failure.
  async function deriveCategoryGoal(name: string, useCase: string): Promise<string> {
    try {
      const res = await fetch("/api/category-goal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, useCase, about: aboutText }),
      });
      const j = await parseApiResponse(res);
      return (j && j.goal) || name;
    } catch {
      return name;
    }
  }

  // Category manager (pencil): rename a category in the dropdown.
  function renameCategory(id: string, name: string) {
    const nm = name.trim();
    if (!nm) return;
    saveCats(categories.map((c) => (c.id === id ? { ...c, name: nm } : c)));
  }

  function removeCategory(id: string) {
    const next = categories.filter((c) => c.id !== id);
    saveCats(next);
    if (catId === id) {
      const mine = next.filter((c) => c.projectId === activeId);
      if (mine.length) {
        setCatId(mine[0].id);
        setGoal(mine[0].goal);
      } else {
        setCatId("");
      }
    }
  }

  function addTemplate() {
    if (!mtText.trim()) return;
    saveTpls([
      {
        id: `${Date.now()}`,
        channel: mtChannel,
        text: mtText.trim(),
        // Only record a scope when one was chosen; a category implies its project.
        ...(mtProjectId ? { projectId: mtProjectId } : {}),
        ...(mtProjectId && mtCategoryId ? { categoryId: mtCategoryId } : {}),
      },
      ...myTemplates,
    ]);
    setMtText("");
  }

  // Which templates apply when drafting for a given project + category. Global
  // templates (no projectId) always apply; project-scoped ones apply to that
  // project; category-scoped ones only when that exact category is in play.
  function templatesFor(projectId: string, categoryId?: string): OutreachTemplate[] {
    return myTemplates.filter((t) => {
      if (t.projectId && t.projectId !== projectId) return false;
      if (t.categoryId && t.categoryId !== (categoryId || "")) return false;
      return true;
    });
  }

  const activeProject = projects.find((p) => p.id === activeId) || projects[0] || null;
  const activeUseCase = activeProject ? activeProject.useCase : profile.useCase;
  const uc = ucInfo(activeUseCase);
  const myCats = activeProject
    ? categories.filter((c) => c.projectId === activeProject.id)
    : [];
  const aboutText = [
    profile.name,
    profile.bio,
    profile.linkedin ? "LinkedIn: " + profile.linkedin : "",
    profile.age ? `Age: ${profile.age}` : "",
    profile.college ? `Education: ${profile.college}` : "",
    profile.location ? `Location: ${profile.location}` : "",
    profile.companySize && profile.companySize !== "any"
      ? `Prefers ${profile.companySize === "small" ? "small companies / startups" : "large, established companies"}`
      : "",
    profile.competitiveness && profile.competitiveness !== "any"
      ? `Self-rated as a ${profile.competitiveness} applicant`
      : "",
    activeProject && activeProject.context
      ? "This outreach is on behalf of / for: " + activeProject.context
      : "",
  ]
    .filter(Boolean)
    .join(". ")
    .trim();
  // A light gate: a name OR a bio is enough to start. Resume and LinkedIn are
  // optional — they just make outreach more personal.
  const profileComplete = !!(profile.name.trim() || profile.bio.trim());

  // Finds belonging to the active project (newest first), and the count still to work.
  const myFinds = activeProject
    ? finds.filter((f) => f.projectId === activeProject.id)
    : [];
  const newFindCount = myFinds.filter((f) => f.status === "new").length;

  // ---- Finds pipeline ----
  // Add newly discovered people to the active project's finds (deduped, keeping
  // any status/draft already set). Returns how many were genuinely new.
  function mergeFinds(newOpps: Opportunity[]): number {
    // Two dedup layers: exact id match (same person + same host, historic key)
    // AND normalized-name/handle match against every find in this project. The
    // second catches "same person, different article" cases — for those we
    // MERGE the incoming article into the existing find's sources instead of
    // adding a second row.
    const existingIds = new Set(finds.map((f) => f.id));
    const byName = new Map<string, Find>();
    const byHandle = new Map<string, Find>();
    for (const f of finds) {
      if (f.projectId !== activeId) continue;
      const nm = normNameKey(f.opp.name);
      if (nm) byName.set(nm, f);
      const hk = normHandleKey(f.opp.contactHandle || "");
      if (hk) byHandle.set(hk, f);
    }
    const fresh: Find[] = [];
    const updates = new Map<string, Find>(); // id → updated Find (source-merged)
    for (const o of newOpps) {
      const id = findKey(activeId, o);
      if (existingIds.has(id)) continue;
      const nm = normNameKey(o.name);
      const hk = normHandleKey(o.contactHandle || "");
      const matched =
        (nm && byName.get(nm)) || (hk && byHandle.get(hk)) || null;
      if (matched) {
        // Same person, different article — append this URL as another source
        // on the matched find rather than surface a duplicate row.
        const target = updates.get(matched.id) || matched;
        const currentSources: SourceRef[] = target.opp.sources
          ? [...target.opp.sources]
          : [
              {
                title: target.opp.sourceTitle,
                url: target.opp.url,
                snippet: target.opp.sourceSnippet,
              },
            ];
        const newRef: SourceRef = {
          title: o.sourceTitle,
          url: o.url,
          snippet: o.sourceSnippet,
        };
        if (newRef.url && !currentSources.find((s) => s.url === newRef.url)) {
          currentSources.push(newRef);
        }
        // Also add all sources from the incoming opp (in case discover already
        // multi-source'd it) — same URL check keeps things clean.
        if (o.sources) {
          for (const s of o.sources) {
            if (s.url && !currentSources.find((c) => c.url === s.url)) {
              currentSources.push(s);
            }
          }
        }
        updates.set(matched.id, {
          ...target,
          opp: {
            ...target.opp,
            sources: currentSources,
            // Backfill any contact detail we didn't have before.
            contactEmail: target.opp.contactEmail || o.contactEmail,
            contactHandle: target.opp.contactHandle || o.contactHandle,
            contactRole: target.opp.contactRole || o.contactRole,
            location: target.opp.location || o.location,
          },
        });
        continue;
      }
      existingIds.add(id);
      if (nm) byName.set(nm, {} as Find); // placeholder to dedup within this batch
      if (hk) byHandle.set(hk, {} as Find);
      fresh.push({
        id,
        projectId: activeId,
        categoryId: catId || undefined,
        status: "new",
        opp: o,
        addedAt: Date.now(),
      });
    }
    if (fresh.length || updates.size) {
      const merged = finds.map((f) => updates.get(f.id) || f);
      saveFinds([...fresh, ...merged]);
    }
    return fresh.length;
  }

  // Merge pre-built Find records (from the CSV importer) into the existing
  // pipeline, skipping anything that would collide with an id already saved.
  // Returns the count actually added so the importer can report it.
  function importFinds(imported: Find[]): number {
    const existing = new Set(finds.map((f) => f.id));
    const fresh: Find[] = [];
    for (const f of imported) {
      if (existing.has(f.id)) continue;
      existing.add(f.id);
      fresh.push(f);
    }
    if (fresh.length) saveFinds([...fresh, ...finds]);
    return fresh.length;
  }

  function setFindStatus(id: string, status: FindStatus) {
    saveFinds(
      finds.map((f) =>
        f.id === id
          ? {
              ...f,
              status,
              // Stamp when it first goes to "sent" so follow-up timing has a clock.
              sentAt: status === "sent" && !f.sentAt ? Date.now() : f.sentAt,
            }
          : f
      )
    );
  }
  // Mark contacted from the button — same as setting status to sent.
  function markContacted(id: string) {
    setFindStatus(id, "sent");
    const f = finds.find((x) => x.id === id);
    if (f) recordExposure(f.opp); // contacted -> feed the shared ledger
  }
  // Pin/unpin a find so it sorts to the top of the list.
  function togglePin(id: string) {
    saveFinds(finds.map((f) => (f.id === id ? { ...f, pinned: !f.pinned } : f)));
  }
  // Toggle whether this find's email draft attaches the resume.
  function setFindAttach(find: Find, on: boolean) {
    saveFinds(
      finds.map((f) =>
        f.id === find.id && f.draft ? { ...f, draft: { ...f.draft, attachResume: on } } : f
      )
    );
  }

  // Save a hand-edited draft AND learn the before→after delta for future drafts.
  function editFindDraft(find: Find, subject: string, body: string) {
    const prevBody = find.draft?.body || "";
    recordEdit(prevBody, body, find.id);
    saveFinds(
      finds.map((f) =>
        f.id === find.id && f.draft
          ? {
              ...f,
              draft: {
                ...f.draft,
                subject: subject,
                body: body,
              },
            }
          : f
      )
    );
  }
  // Re-draft every un-sent ("drafted") find with the current voice edits +
  // coaching, so past drafts benefit from what Scout just learned. Sent and
  // replied finds are left alone — they already went out. Batched through
  // /api/draft (capped at 8 per call) to stay within the time budget.
  async function refreshDraftsWithVoice() {
    const eligible = finds.filter((f) => f.status === "drafted" && f.draft?.body);
    if (!eligible.length) {
      setVoiceRefreshAvailable(false);
      return;
    }
    setError("");
    setRefreshingVoice(true);
    try {
      const updated = new Map<string, Draft>(); // findId -> new draft
      for (let i = 0; i < eligible.length; i += 8) {
        const batch = eligible.slice(i, i + 8);
        const res = await fetch("/api/draft", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            opportunities: batch.map((f) => ({
              ...f.opp,
              requirements: f.requirements || "",
            })),
            about: aboutText,
            useCase: activeUseCase,
            // Use each find's own template scope where possible; fall back to
            // the active project's templates for the batch.
            templates: templatesFor(activeId, catId),
            coaching,
            editPairs,
            signature,
          }),
        });
        const data = await parseApiResponse(res);
        if (!res.ok || data?.error) {
          reportError(data);
          return;
        }
        const byOpp = new Map<string, Draft>(
          (data.drafts || []).map((d: Draft) => [d.opportunityId, d])
        );
        for (const f of batch) {
          const nd = byOpp.get(f.opp.id);
          if (nd) updated.set(f.id, nd);
        }
      }
      if (updated.size) {
        saveFinds(
          finds.map((f) =>
            updated.has(f.id) ? { ...f, draft: updated.get(f.id)! } : f
          )
        );
      }
      setVoiceRefreshAvailable(false);
    } catch (e: any) {
      setError(e?.message || "Couldn't refresh your drafts.");
    } finally {
      setRefreshingVoice(false);
    }
  }

  // Deny a find and record why (reason optional).
  function denyFindWithReason(id: string, reason: string) {
    saveFinds(
      finds.map((f) =>
        f.id === id
          ? { ...f, status: "denied" as FindStatus, denyReason: reason.trim() || f.denyReason || "" }
          : f
      )
    );
  }
  function setFindReason(id: string, reason: string) {
    saveFinds(finds.map((f) => (f.id === id ? { ...f, denyReason: reason.trim() } : f)));
  }
  function removeFind(id: string) {
    saveFinds(finds.filter((f) => f.id !== id));
  }

  // Tell the shared ledger this user is pursuing a contact, so it isn't
  // over-surfaced to everyone else. Fire-and-forget; no-op for signed-out users.
  // Only personal outreach counts — job/internship openings are meant to get many
  // applicants, so they're never capped and never recorded.
  const recordExposure = (opp: Opportunity) => {
    if (!getToken || isJobUseCaseClient(activeUseCase)) return;
    getToken()
      .then((token) => {
        if (!token) return;
        fetch("/api/exposure/record", {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({
            opp: {
              contactEmail: opp.contactEmail,
              name: opp.name,
              outlet: opp.outlet,
              url: opp.url,
            },
          }),
        }).catch(() => {});
      })
      .catch(() => {});
  };

  // Deep-scan a find's site for a specific contact + submission requirements.
  // Ask Scout to prep the user for a meeting / interview with this contact.
  // Runs fresh Tavily searches on the person + their outlet and returns
  // categorized facts — not questions to ask. Gated at the UI layer to
  // status "sent" or later, so this doubles as an incentive to keep statuses
  // current (see the button visibility rules in FindCard).
  const [meetingPrepId, setMeetingPrepId] = useState("");
  async function generateMeetingPrep(find: Find) {
    setError("");
    setMeetingPrepId(find.id);
    try {
      const res = await fetch("/api/meeting-prep", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          opp: find.opp,
          about: aboutText,
          useCase: activeUseCase,
        }),
      });
      const data = await parseApiResponse(res);
      if (!res.ok || data?.error) {
        reportError(data);
        return;
      }
      const facts = Array.isArray(data.facts) ? data.facts : [];
      if (!facts.length) {
        setError(
          "Scout couldn't find enough fresh info to prep. Try again in a few days once there's more on the web."
        );
        return;
      }
      saveFinds(
        finds.map((f) =>
          f.id === find.id
            ? {
                ...f,
                meetingPrep: {
                  generatedAt: data.generatedAt || new Date().toISOString(),
                  facts,
                },
              }
            : f
        )
      );
    } catch (e: any) {
      setError(e?.message || "Meeting prep failed.");
    } finally {
      setMeetingPrepId("");
    }
  }

  async function deepScanFind(find: Find) {
    if (!find.opp.url) {
      setRepliesNote("This find has no page to scan.");
      return;
    }
    setScanningId(find.id);
    setRepliesNote("");
    try {
      const res = await fetch("/api/deep-scan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: find.opp.url,
          name: find.opp.name,
          outlet: find.opp.outlet,
          goal,
          useCase: activeUseCase,
        }),
      });
      const j = await parseApiResponse(res);
      if (!res.ok || j?.error) {
        setRepliesNote(j?.error || "Couldn't scan that site.");
        return;
      }
      const c = j.contact || {};
      const gotContact = !!(c.email || c.name || c.handle);
      const gotReqs = !!(j.requirements || "").trim();
      saveFinds(
        finds.map((f) => {
          if (f.id !== find.id) return f;
          const opp = { ...f.opp };
          // Only fill gaps — never overwrite a contact we already trust.
          if (c.email && !opp.contactEmail) opp.contactEmail = c.email;
          if (c.name && !opp.contactName) opp.contactName = c.name;
          if (c.role && !opp.contactRole) opp.contactRole = c.role;
          if (c.handle && !opp.contactHandle) opp.contactHandle = c.handle;
          if (c.email && (!opp.channel || /unknown/i.test(opp.channel)))
            opp.channel = "Email";
          return {
            ...f,
            opp,
            requirements: gotReqs ? j.requirements : f.requirements,
            scanned: true,
          };
        })
      );
      setRepliesNote(
        gotContact || gotReqs
          ? `Scanned ${find.opp.name}.${gotContact ? " Found a contact." : ""}${
              gotReqs ? " Pulled their requirements." : ""
            } Draft again to use it.`
          : `Scanned ${find.opp.name}, but found no specific contact or requirements on the page.`
      );
    } catch (e: any) {
      setRepliesNote(e?.message || "Couldn't scan that site.");
    } finally {
      setScanningId("");
    }
  }

  // Read a specific internship/job posting and draft every written application
  // component (cover letter, essays, short answers) from the user's profile.
  async function draftApplicationFor(find: Find) {
    if (!find.opp.url) {
      setRepliesNote("This opening has no link to read.");
      return;
    }
    setApplyingId(find.id);
    setRepliesNote("");
    try {
      const res = await fetch("/api/application", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: find.opp.url,
          name: find.opp.name,
          outlet: find.opp.outlet,
          about: aboutText,
          useCase: activeUseCase,
          coaching,
          editPairs,
        }),
      });
      const j = await parseApiResponse(res);
      if (!res.ok || j?.error) {
        setRepliesNote(j?.error || "Couldn't read that application.");
        return;
      }
      const components = Array.isArray(j.components) ? j.components : [];
      saveFinds(
        finds.map((f) =>
          f.id === find.id
            ? {
                ...f,
                application: {
                  overview: j.overview || "",
                  howToApply: j.howToApply || "",
                  components,
                  generatedAt: Date.now(),
                },
              }
            : f
        )
      );
      const drafted = components.filter((c: any) => c.draft).length;
      setRepliesNote(
        components.length
          ? `Read ${find.opp.name}'s application: ${components.length} ${
              components.length === 1 ? "item" : "items"
            }${drafted ? `, drafted ${drafted} for you` : ""}. See the card.`
          : `Read ${find.opp.name}, but couldn't find specific application requirements on the page.`
      );
    } catch (e: any) {
      setRepliesNote(e?.message || "Couldn't read that application.");
    } finally {
      setApplyingId("");
    }
  }

  // Draft a short follow-up nudge for a sent-but-unanswered find. If it went out
  // via Gmail, the nudge is written as an in-thread reply.
  async function followUpFind(find: Find) {
    setFollowUpId(find.id);
    setRepliesNote("");
    try {
      const res = await fetch("/api/draft-followup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          opp: find.opp,
          about: aboutText,
          useCase: activeUseCase,
          firstMessage: find.draft ? { subject: find.draft.subject, body: find.draft.body } : null,
          inThread: !!find.gmailThreadId,
        }),
      });
      const j = await parseApiResponse(res);
      if (!res.ok || j?.error) {
        setRepliesNote(j?.error || "Couldn't draft a follow-up.");
        return;
      }
      const followDraft: Draft = {
        opportunityId: find.opp.id,
        to: find.draft?.to || find.opp.contactEmail || "",
        channelType: find.draft?.channelType || "email",
        subject: j.subject || (find.draft?.subject ? `Re: ${find.draft.subject}` : ""),
        body: j.body || "",
        whyItFits: find.opp.whyItFits,
      };
      saveFinds(
        finds.map((f) =>
          f.id === find.id
            ? { ...f, draft: followDraft, lastFollowUpAt: Date.now() }
            : f
        )
      );
      bumpActivity({ drafts: 1 });
      setRepliesNote(
        `Wrote a follow-up to ${find.opp.name}. It's on the card, ready to ${
          find.gmailThreadId && gmail.connected ? "send in-thread" : "copy or send"
        }.`
      );
    } catch (e: any) {
      setRepliesNote(e?.message || "Couldn't draft a follow-up.");
    } finally {
      setFollowUpId("");
    }
  }

  // Draft a message for a single find and store it on that find.
  async function draftFind(find: Find) {
    setError("");
    setFindDraftingId(find.id);
    try {
      const res = await fetch("/api/draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          opportunities: [{ ...find.opp, requirements: find.requirements || "" }],
          about: aboutText,
          useCase: activeUseCase,
          templates: templatesFor(find.projectId, find.categoryId),
          coaching,
          editPairs,
          signature,
        }),
      });
      const data = await parseApiResponse(res);
      if (!res.ok || data?.error) {
        reportError(data);
        return;
      }
      const draft: Draft | undefined = (data.drafts || [])[0];
      if (draft) {
        saveFinds(
          finds.map((f) =>
            f.id === find.id ? { ...f, draft, status: "drafted" } : f
          )
        );
        bumpActivity({ drafts: 1 });
        recordExposure(find.opp); // pursuing this contact -> feed the shared ledger
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setFindDraftingId("");
    }
  }

  // Send/draft a find's message via Gmail. sendViaGmail patches the find itself
  // (thread id + sent status), so nothing more to do here.
  async function sendFindViaGmail(find: Find) {
    if (!find.draft) return;
    // If this find already has a thread (e.g. a follow-up on an earlier send),
    // thread the new message into it instead of starting a new one.
    await sendViaMailbox(find.draft, find.gmailThreadId);
  }

  // Queue this find's draft for future sending via the active mailbox. The
  // /api/cron/send-scheduled endpoint (fired by Vercel Cron every 15 min)
  // drains due rows and calls Gmail/Outlook send under the hood.
  async function scheduleFindSend(find: Find, sendAt: Date) {
    if (!find.draft || !activeMailbox.connected) return;
    const token = getToken ? await getToken() : null;
    if (!token) {
      setError("Please sign in to schedule sends.");
      return;
    }
    try {
      const res = await fetch("/api/schedule-send", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          provider: activeMailbox.provider,
          to: find.draft.to,
          subject: find.draft.subject,
          body: find.draft.body,
          sendAt: sendAt.toISOString(),
          findId: find.id,
          opportunityId: find.opp.id,
          attachment:
            find.draft.channelType === "email" && find.draft.attachResume && resumeFile
              ? { name: resumeFile.name, dataUrl: resumeFile.dataUrl }
              : null,
        }),
      });
      const data = await parseApiResponse(res);
      if (!res.ok || data?.error) {
        setError(data?.error || "Could not schedule that send.");
        return;
      }
      // Mark the find locally as scheduled so the UI reflects the queue —
      // the actual send happens later; setting status to "sent" now would
      // lie. We reuse the "drafted" status and stash a note on the find.
      saveFinds(
        finds.map((f) =>
          f.id === find.id
            ? { ...f, scheduledSendAt: sendAt.toISOString() }
            : f
        )
      );
    } catch (e: any) {
      setError(e?.message || "Could not schedule that send.");
    }
  }

  // ---- Reply tracking: check tracked Gmail + Outlook threads for responses ----
  const [repliesBusy, setRepliesBusy] = useState(false);
  const [repliesNote, setRepliesNote] = useState("");
  async function checkReplies(opts?: { silent?: boolean }) {
    const silent = !!opts?.silent;
    if (!getToken) return;
    const token = await getToken();
    if (!token) return;
    const untracked = (f: Find) =>
      f.status !== "replied" && f.status !== "denied";
    const gmailCands = finds
      .filter((f) => f.gmailThreadId && untracked(f))
      .slice(0, 20)
      .map((f) => ({ id: f.id, threadId: f.gmailThreadId }));
    const outlookCands = finds
      .filter((f) => f.outlookThreadId && untracked(f))
      .slice(0, 20)
      .map((f) => ({ id: f.id, threadId: f.outlookThreadId }));
    if (!gmailCands.length && !outlookCands.length) {
      if (!silent)
        setRepliesNote(
          "Nothing to check yet. Send a message through Gmail or Outlook first and replies get tracked automatically."
        );
      return;
    }
    setRepliesBusy(true);
    if (!silent) setRepliesNote("");
    // Ask each connected provider about its own threads, then merge the results.
    const ask = async (path: string, threads: any[]) => {
      if (!threads.length) return { replied: [] as string[], checked: 0, error: "" };
      try {
        const r = await fetch(path, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ threads }),
        });
        const j = await r.json();
        return r.ok
          ? { replied: (j.replied || []) as string[], checked: j.checked || threads.length, error: "" }
          : { replied: [] as string[], checked: 0, error: j.error || "Couldn't check for replies." };
      } catch (e: any) {
        return { replied: [] as string[], checked: 0, error: e?.message || "Couldn't check for replies." };
      }
    };
    try {
      const [g, o] = await Promise.all([
        ask("/api/gmail/replies", gmailCands),
        ask("/api/outlook/replies", outlookCands),
      ]);
      const repliedSet = new Set<string>([...g.replied, ...o.replied]);
      const err = g.error || o.error;
      if (repliedSet.size) {
        saveFinds(
          finds.map((f) =>
            repliedSet.has(f.id) ? { ...f, status: "replied" as FindStatus } : f
          )
        );
        if (!silent)
          setRepliesNote(
            `${repliedSet.size} ${repliedSet.size === 1 ? "reply" : "replies"} found and marked.`
          );
      } else if (err) {
        if (!silent) setRepliesNote(err);
      } else {
        if (!silent) setRepliesNote(`No new replies yet (checked ${g.checked + o.checked}).`);
      }
    } finally {
      setRepliesBusy(false);
    }
  }

  // Automatically scan the connected inbox for replies when you open Finds or the
  // Dashboard, so answered outreach gets marked "replied" (and drops off the
  // follow-up list) without clicking anything. Throttled to avoid hammering the
  // mailbox; uses the same headers-only permission granted when you connect.
  const lastReplyScanRef = useRef(0);
  useEffect(() => {
    if (!activeMailbox.connected || !getToken) return;
    if (tab !== "finds" && tab !== "dashboard") return;
    if (Date.now() - lastReplyScanRef.current < 3 * 60 * 1000) return;
    const hasTrackable = finds.some(
      (f) =>
        (f.gmailThreadId || f.outlookThreadId) &&
        f.status !== "replied" &&
        f.status !== "denied"
    );
    if (!hasTrackable) return;
    lastReplyScanRef.current = Date.now();
    checkReplies({ silent: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, activeMailbox.connected]);

  async function runDiscover() {
    if (!profileComplete) {
      setTab("profile");
      return;
    }
    resetResults();
    setDiscoverStartedAt(Date.now());
    setDiscovering(true);
    try {
      // Teach the search from this project's history: avoid denied finds (with
      // reasons), favor the ones the user kept/drafted.
      const projFinds = finds.filter((f) => f.projectId === activeId);
      const feedback = {
        avoid: projFinds
          .filter((f) => f.status === "denied")
          .slice(0, 15)
          .map((f) => ({ name: f.opp.name, reason: f.denyReason || "" })),
        favor: projFinds
          .filter((f) => f.status !== "denied" && f.status !== "new")
          .slice(0, 10)
          .map((f) => ({ name: f.opp.name, why: f.opp.whyItFits || "" })),
      };
      // For job/internship searches, layer in the competitiveness + company-size
      // directives so the LLM narrows to the right tier of opportunity. The
      // per-search override wins over the profile setting.
      const jobish = isJobUseCaseClient(activeUseCase);
      const compLevel: Competitiveness = jobish
        ? (searchComp || profile.competitiveness || "any")
        : "any";
      const sizePref: CompanySize = jobish ? profile.companySize || "any" : "any";
      const extras: string[] = [];
      if (compLevel !== "any") extras.push(COMPETITIVENESS_HINTS[compLevel]);
      if (sizePref !== "any") extras.push(COMPANY_SIZE_HINTS[sizePref]);
      const goalForApi = extras.length
        ? `${goal}\n\n${extras.join(" ")}`
        : goal;
      const res = await fetch("/api/discover", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          goal: goalForApi,
          about: aboutText,
          useCase: activeUseCase,
          feedback,
          salt: outreachSalt(accountEmail),
          cohortHint: cohortHintFrom(community),
        }),
      });
      const data = await parseApiResponse(res);
      if (!res.ok || data?.error) {
        reportError(data);
        return;
      }
      setOpps(data.opportunities || []);
      setSelected({}); // nothing pre-approved — you approve who you want to reach
      setSkipped(Array.isArray(data.skipped) ? data.skipped : []);
      setStats(
        `${data.opportunities.length} found · ${data.searched} searches · ${data.candidates} pages read · skipped ${data.skippedDupes} duplicates, ${data.skippedNotFit} not a fit`
      );
      const added = mergeFinds(data.opportunities || []);
      bumpActivity({ searches: 1, found: (data.opportunities || []).length });
      if (added) setStats((s) => `${s} · ${added} new saved to Finds`);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setDiscovering(false);
      setDiscoverStartedAt(null);
    }
  }

  async function runDraft() {
    setError("");
    setExpanded(false);
    setDrafting(true);
    try {
      const chosen = visibleOpps.filter((o) => selected[o.id]);
      const res = await fetch("/api/draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          opportunities: chosen,
          about: aboutText,
          useCase: activeUseCase,
          templates: templatesFor(activeId, catId),
          coaching,
          editPairs,
          signature,
        }),
      });
      const data = await parseApiResponse(res);
      if (!res.ok || data?.error) {
        reportError(data);
        return;
      }
      const newDrafts: Draft[] = data.drafts || [];
      setDrafts(newDrafts);
      bumpActivity({ drafts: newDrafts.length });
      // Persist drafts onto the matching pipeline finds so approved → drafted
      // shows up in the Finds tab.
      if (newDrafts.length) {
        const draftByOppId = new Map(newDrafts.map((d) => [d.opportunityId, d]));
        const oppById = new Map(chosen.map((o) => [o.id, o]));
        saveFinds(
          finds.map((f) => {
            const opp = [...oppById.values()].find(
              (o) => findKey(activeId, o) === f.id
            );
            const dr = opp ? draftByOppId.get(opp.id) : undefined;
            return dr ? { ...f, draft: dr, status: "drafted" } : f;
          })
        );
        // Feed the shared ledger for each contact we just drafted for.
        chosen
          .filter((o) => draftByOppId.has(o.id))
          .forEach((o) => recordExposure(o));
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setDrafting(false);
    }
  }

  // Rewrite a single existing draft for a different outreach kind (Email,
  // LinkedIn message, Instagram DM, etc.). Called when the user changes the
  // format dropdown on a draft card; only that one draft updates.
  async function redraftAs(opportunityId: string, kind: string) {
    setError("");
    const opp =
      opps.find((o) => o.id === opportunityId) ||
      // Fallback for drafts surfaced from the finds pipeline.
      finds.find((f) => f.draft?.opportunityId === opportunityId)?.opp;
    if (!opp) return;
    setDraftKind((m) => ({ ...m, [opportunityId]: kind }));
    setRedraftBusyId(opportunityId);
    try {
      const res = await fetch("/api/draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          opportunities: [opp],
          about: aboutText,
          useCase: activeUseCase,
          templates: templatesFor(activeId, catId),
          coaching,
          editPairs,
          signature,
          kind,
        }),
      });
      const data = await parseApiResponse(res);
      if (!res.ok || data?.error) {
        reportError(data);
        return;
      }
      const newDraft: Draft | undefined = (data.drafts || [])[0];
      if (!newDraft) return;
      setDrafts((prev) =>
        prev.map((d) => (d.opportunityId === opportunityId ? newDraft : d))
      );
      // Also persist onto the matching pipeline find so Finds stays in sync.
      saveFinds(
        finds.map((f) =>
          f.draft?.opportunityId === opportunityId
            ? { ...f, draft: newDraft, status: "drafted" }
            : f
        )
      );
    } catch (e: any) {
      setError(e.message);
    } finally {
      setRedraftBusyId("");
    }
  }

  // Results hide anyone denied here (denial flows to the Finds pipeline).
  const deniedFindIds = new Set(
    finds.filter((f) => f.status === "denied").map((f) => f.id)
  );
  const visibleOpps = opps.filter((o) => !deniedFindIds.has(findKey(activeId, o)));
  const selectedCount = visibleOpps.filter((o) => selected[o.id]).length;
  const toggle = (id: string, v: boolean) =>
    setSelected((s) => ({ ...s, [id]: v }));
  // Deny a result: mark it "Not a fit" (with an optional reason) in the pipeline
  // and drop it from the batch.
  const denyOpp = (o: Opportunity, reason = "") => {
    denyFindWithReason(findKey(activeId, o), reason);
    setSelected((s) => ({ ...s, [o.id]: false }));
  };

  return (
    <div className="flex min-h-screen">
      <SideNav
        tab={tab}
        setTab={setTab}
        newFindCount={newFindCount}
        templatesCount={myTemplates.length}
        profileHasBio={!!profile.bio.trim()}
        hasAccount={!!accountEmail}
        projects={projects}
        activeId={activeId}
        onSelectProject={selectProject}
        showLogout={!!showLogout}
        onLogout={onLogout}
      />
      <Tutorial
        open={tourOpen}
        steps={TOUR_STEPS}
        setTab={setTab as (t: string) => void}
        onClose={endTour}
        onFinish={endTour}
      />
      <ImportOutreach
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImport={importFinds}
        projects={projects}
        activeProjectId={activeId}
      />
      {discovering && tab !== "outreach" && (
        <GlobalScoutStatus
          startedAt={discoverStartedAt}
          onGo={() => setTab("outreach")}
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
      {/* Grows to fill the viewport so the footer sits at the bottom on short pages */}
      <div className="flex flex-1 flex-col">

      {tab === "outreach" && (
          <main className="mx-auto w-full max-w-6xl px-6 pb-16 pt-8">
          <div className="mb-6">
            <h1 className="text-2xl font-semibold tracking-tight text-ink">Outreach</h1>
            <p className="mt-1 text-sm text-body">
              Find your people and draft messages in your voice.
            </p>
          </div>


            {/* ---------------- Request card (gated behind a completed profile) ---------------- */}
            {profileComplete ? (
            <section className="mt-6 rounded-3xl border border-warm-border bg-surface p-6 shadow-soft sm:p-8">
              {/* -------- Project switcher: one workspace per artist / client / goal -------- */}
              <div
                data-tour="project-switcher"
                className="mb-6 grid gap-6 border-b border-warm-border pb-6 sm:grid-cols-[230px_1fr]"
              >
                <div>
                  <Label>Project</Label>
                  <div className="relative">
                    <div className="flex items-center gap-2">
                      <select
                        value={activeId}
                        onChange={(e) => selectProject(e.target.value)}
                        className="scout-select w-full flex-1 rounded-xl border border-warm-border bg-surface px-3.5 py-3 text-sm font-semibold text-ink outline-none transition focus:border-coral focus:ring-4 focus:ring-coral/15"
                      >
                        {projects.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                      <button
                        onClick={() => setEditingProjects(true)}
                        title="Manage projects"
                        aria-label="Manage projects"
                        className="shrink-0 rounded-lg border border-warm-border p-2.5 text-body/70 transition hover:border-coral/40 hover:bg-warm-bg hover:text-accent"
                      >
                        <PencilIcon />
                      </button>
                    </div>
                    {editingProjects && (
                      <CategoryManager
                        cats={projects}
                        onAdd={addProject}
                        onRename={renameProject}
                        onRemove={removeProject}
                        onClose={() => setEditingProjects(false)}
                        title="Your projects"
                        addPlaceholder="New project (e.g. a client or brand)"
                        emptyText="No projects yet."
                      />
                    )}
                  </div>
                  <p className="mt-2.5 text-xs leading-relaxed text-body/70">
                    One workspace per client, brand, or goal, each with its own
                    categories and searches. Tap the pencil to add or remove projects.
                  </p>
                </div>

                <div>
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <Label className="mb-0">Who this outreach is for (optional)</Label>
                    <MicButton
                      onAppend={(t) =>
                        setProjectContext(activeId, joinSpoken(activeProject?.context || "", t))
                      }
                    />
                  </div>
                  <textarea
                    value={activeProject?.context || ""}
                    onChange={(e) => setProjectContext(activeId, e.target.value)}
                    rows={2}
                    placeholder="e.g. a sustainable-fashion DTC brand launching a new collection, targeting Gen Z shoppers who care about ethical sourcing."
                    className="w-full resize-y rounded-xl border border-warm-border px-3.5 py-3 text-sm leading-relaxed text-ink outline-none transition focus:border-coral focus:ring-4 focus:ring-coral/15"
                  />
                </div>
              </div>

              <div
                data-tour="category-switcher"
                className="grid gap-6 sm:grid-cols-[230px_1fr]"
              >
                <div>
                  <Label>Category of search</Label>
                  <div className="relative">
                    <div className="flex items-center gap-2">
                      <select
                        value={catId}
                        onChange={(e) => selectCategory(e.target.value)}
                        className="scout-select w-full flex-1 rounded-xl border border-warm-border bg-surface px-3.5 py-3 text-sm font-semibold text-ink outline-none transition focus:border-coral focus:ring-4 focus:ring-coral/15"
                      >
                        {myCats.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                        <option value="">Custom search…</option>
                      </select>
                      <button
                        onClick={() => setEditingCats(true)}
                        title="Edit categories"
                        aria-label="Edit categories"
                        className="shrink-0 rounded-lg border border-warm-border p-2.5 text-body/70 transition hover:border-coral/40 hover:bg-warm-bg hover:text-accent"
                      >
                        <PencilIcon />
                      </button>
                    </div>
                    {editingCats && (
                      <CategoryManager
                        cats={myCats}
                        onAdd={addCategoryNamed}
                        onRename={renameCategory}
                        onRemove={removeCategory}
                        onClose={() => setEditingCats(false)}
                      />
                    )}
                  </div>
                  <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                    <button
                      onClick={addCategory}
                      className="font-semibold text-accent transition hover:underline"
                    >
                      + Save Search
                    </button>
                  </div>
                  <p className="mt-3 text-xs leading-relaxed text-body/70">
                    Categories belong to{" "}
                    <span className="font-semibold text-body">
                      {activeProject?.name || "this project"}
                    </span>
                    . Tap the pencil to add, rename, or remove them from this
                    project&apos;s dropdown.
                  </p>
                </div>

                <div>
                  {isJobUseCaseClient(activeUseCase) && (
                    <div className="mb-3">
                      <Label>Competitiveness</Label>
                      <div className="inline-flex flex-wrap gap-1 rounded-xl border border-warm-border bg-warm-bg/40 p-1">
                        {(
                          [
                            ["", "From profile"],
                            ["beginner", "Beginner-friendly"],
                            ["intermediate", "Intermediate"],
                            ["competitive", "Competitive"],
                            ["any", "Any"],
                          ] as const
                        ).map(([val, label]) => (
                          <button
                            key={val || "profile"}
                            onClick={() => setSearchComp(val as any)}
                            className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                              searchComp === val
                                ? "bg-surface text-ink shadow-card"
                                : "text-body/70 hover:text-ink"
                            }`}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                      <p className="mt-1.5 text-xs text-body/70">
                        {searchComp === ""
                          ? `Using your Profile setting${
                              profile.competitiveness && profile.competitiveness !== "any"
                                ? ` (${profile.competitiveness})`
                                : ""
                            }.`
                          : searchComp === "any"
                            ? "Any level — Scout won't filter by selectivity."
                            : `Scout will focus on ${searchComp} opportunities for this search.`}
                      </p>
                    </div>
                  )}
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <Label className="mb-0">Who are you looking for?</Label>
                    <MicButton onAppend={(t) => setGoal((g) => joinSpoken(g, t))} />
                  </div>
                  <textarea
                    value={goal}
                    onChange={(e) => setGoal(e.target.value)}
                    placeholder={uc.goalPlaceholder}
                    rows={3}
                    className="w-full resize-y rounded-xl border border-warm-border px-3.5 py-3 text-sm text-ink outline-none transition focus:border-coral focus:ring-4 focus:ring-coral/15"
                  />
                  <p className="mt-1.5 text-xs text-body/70">
                    Tip: add your industry, genre, or city to sharpen the results.
                  </p>
                  {!aboutText && (
                    <button
                      onClick={() => setTab("profile")}
                      className="mt-2 text-xs font-semibold text-accent underline-offset-2 hover:underline"
                    >
                      Add your info in Profile to personalize your messages →
                    </button>
                  )}
                </div>
              </div>

              <div className="mt-6 flex flex-wrap items-center gap-3">
                <button
                  onClick={runDiscover}
                  disabled={discovering || !goal.trim()}
                  className="rounded-xl bg-brand-gradient px-6 py-3 text-sm font-bold text-white shadow-soft transition hover:opacity-95 disabled:opacity-50"
                >
                  {discovering ? "Scouting…" : "Scout"}
                </button>
                {stats && <span className="text-xs text-body/80">{stats}</span>}
                {skipped.length > 0 && (
                  <button
                    onClick={() => setShowSkipped((v) => !v)}
                    className="ml-auto text-xs font-semibold text-body/70 underline-offset-2 transition hover:text-brown-deep hover:underline"
                  >
                    {showSkipped ? "Hide" : "See"} what was filtered ({skipped.length})
                  </button>
                )}
              </div>
              {showSkipped && skipped.length > 0 && (
                <div className="mt-4 max-h-72 overflow-y-auto rounded-2xl border border-warm-border bg-warm-bg/40 p-4 text-xs">
                  <ul className="space-y-2">
                    {skipped.map((s, i) => (
                      <li key={i} className="flex gap-2 leading-relaxed">
                        <span className="mt-0.5 shrink-0 rounded bg-brown-tint px-1.5 py-0.5 text-[10px] font-bold uppercase text-brown-deep">
                          {s.reason}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-semibold text-ink">
                            {s.title || "(untitled)"}
                          </div>
                          {s.url && (
                            <a
                              href={s.url}
                              target="_blank"
                              rel="noreferrer"
                              className="truncate block text-body/60 underline-offset-2 hover:underline"
                            >
                              {s.url}
                            </a>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
            ) : (
              <ProfileGate onSetup={() => setTab("profile")} />
            )}

            {error &&
              (apiReason ? (
                <div className="mt-5 flex items-start gap-3 rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3.5">
                  <WarnIcon />
                  <div>
                    <div className="text-sm font-bold text-amber-900">
                      {apiReason === "credits"
                        ? "Out of API credits"
                        : apiReason === "auth"
                        ? "API key problem"
                        : "Rate limited"}
                    </div>
                    <p className="mt-0.5 text-sm leading-relaxed text-amber-800">
                      {error}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="mt-5 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  {error}
                </div>
              ))}

            {discovering && (
              <div className="mt-8 flex items-start gap-3">
                <Avatar />
                <div className="relative w-full max-w-md rounded-2xl rounded-tl-sm border border-warm-border bg-surface px-4 py-3.5 shadow-card">
                  <Tail side="left" />
                  <SearchProgress active={discovering} startedAt={discoverStartedAt} />
                </div>
              </div>
            )}

            {/* ---------------- How it works ---------------- */}
            {profileComplete && !opps.length && !discovering && (
              <section className="mt-12">
                <div className="grid gap-5 sm:grid-cols-3">
                  <Step
                    n="1"
                    title="Tell us who to reach"
                    body="Pick a category and describe the people you want to connect with, in plain language."
                    icon={
                      <path d="M12 21s-7-5.5-7-11a7 7 0 0 1 14 0c0 5.5-7 11-7 11Z M12 11.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z" />
                    }
                  />
                  <Step
                    n="2"
                    title="We find them for you"
                    body="Scout searches the public web and pulls real names and emails. Never invented."
                    icon={<path d="M21 21l-4.3-4.3 M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z" />}
                  />
                  <Step
                    n="3"
                    title="Say hello, your way"
                    body="Warm, personal drafts for each channel, matched to your Templates. Review, tweak, send."
                    icon={
                      <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4L3 21l1.1-3.3A8.4 8.4 0 1 1 21 11.5Z" />
                    }
                  />
                </div>
              </section>
            )}

            {/* ---------------- Results as a chat bubble ---------------- */}
            {opps.length > 0 && (
              <section className="mt-10">
                <div className="flex items-start gap-3">
                  <Avatar />
                  <div className="relative w-full rounded-3xl rounded-tl-md border border-warm-border bg-surface shadow-soft">
                    <Tail side="left" />
                    <button
                      onClick={() => setExpanded(true)}
                      className="flex w-full items-center gap-3 border-b border-warm-border px-5 py-4 text-left transition hover:bg-warm-bg/40"
                    >
                      <div>
                        <div className="text-sm font-bold text-ink">Scout</div>
                        <div className="text-xs text-body/80">
                          I found {opps.length} {uc.targetNoun} who fit. Pick who to
                          reach out to.
                        </div>
                      </div>
                      <span className="ml-auto flex items-center gap-1.5 rounded-lg border border-warm-border px-2.5 py-1.5 text-xs font-semibold text-body">
                        <ExpandIcon /> Expand
                      </span>
                    </button>

                    <div className="max-h-[460px] overflow-auto p-4">
                      <FindsList
                        opps={visibleOpps}
                        selected={selected}
                        onApprove={toggle}
                        onDeny={denyOpp}
                      />
                    </div>

                    <div className="flex flex-wrap items-center gap-3 border-t border-warm-border px-5 py-4">
                      <span className="text-sm text-body/80">
                        {selectedCount} approved
                      </span>
                      <button
                        onClick={runDraft}
                        disabled={drafting || selectedCount === 0}
                        className="ml-auto rounded-xl bg-brand-gradient px-5 py-2.5 text-sm font-bold text-white shadow-soft transition hover:opacity-95 disabled:opacity-50"
                      >
                        {drafting ? "Drafting…" : `Draft the ${selectedCount} approved`}
                      </button>
                    </div>
                  </div>
                </div>
              </section>
            )}

            {/* ---------------- Drafts ---------------- */}
            {drafts.length > 0 && (
              <section className="mt-12">
                <h2 className="mb-4 text-lg font-bold text-ink">
                  Messages ({drafts.length})
                </h2>
                <div className="space-y-4">
                  {drafts.map((d, i) => {
                    const opp = opps.find((o) => o.id === d.opportunityId);
                    return (
                      <div
                        key={i}
                        className="relative ml-auto max-w-3xl rounded-3xl rounded-tr-md border border-warm-border bg-surface p-5 shadow-card"
                      >
                        <Tail side="right" />
                        <div className="mb-3 flex flex-wrap items-center gap-2">
                          <span className="font-semibold text-ink">
                            {opp?.name || "Draft"}
                          </span>
                          <DraftKindPicker
                            value={
                              draftKind[d.opportunityId] ||
                              (d.channelType === "email" ? "Email" : OUTREACH_KINDS[1])
                            }
                            options={OUTREACH_KINDS}
                            busy={redraftBusyId === d.opportunityId}
                            onChange={(k) => redraftAs(d.opportunityId, k)}
                          />
                          {d.to && (
                            <span className="text-xs text-body/70">
                              → <ContactValue value={d.to} className="text-body/70" />
                            </span>
                          )}
                          <div className="ml-auto flex items-center gap-2">
                            {activeMailbox.connected &&
                            d.channelType === "email" &&
                            mailHref(d.to) ? (
                              gmailSent[d.opportunityId] ? (
                                <span className="rounded-lg bg-warm-bg px-3 py-1 text-xs font-bold text-accent">
                                  {gmailSent[d.opportunityId] === "send"
                                    ? "Sent ✓"
                                    : `In your ${activeMailbox.label} drafts ✓`}
                                </span>
                              ) : (
                                <button
                                  onClick={() => sendViaMailbox(d)}
                                  disabled={gmailBusyId === d.opportunityId}
                                  className="rounded-lg bg-brand-gradient px-3 py-1 text-xs font-bold text-white shadow-card transition hover:opacity-95 disabled:opacity-50"
                                >
                                  {gmailBusyId === d.opportunityId
                                    ? "Working…"
                                    : activeMailbox.sendMode === "send"
                                    ? `Send from ${activeMailbox.label}`
                                    : `Create ${activeMailbox.label} draft`}
                                </button>
                              )
                            ) : (
                              <SendAction draft={d} onUse={() => bumpActivity({ copies: 1 })} />
                            )}
                            <button
                              onClick={() => {
                                navigator.clipboard.writeText(
                                  (d.subject ? `Subject: ${d.subject}\n\n` : "") + d.body
                                );
                                bumpActivity({ copies: 1 });
                              }}
                              className="rounded-lg border border-warm-border px-3 py-1 text-xs font-semibold text-body transition hover:bg-warm-bg"
                            >
                              Copy
                            </button>
                          </div>
                        </div>
                        {d.subject && (
                          <div className="mb-2.5 border-b border-warm-border pb-2.5 text-sm font-semibold text-ink">
                            {d.subject}
                          </div>
                        )}
                        <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-body">
                          {d.body}
                        </pre>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}
          </main>
      )}

      {tab === "finds" && (
        <FindsTab
          finds={myFinds}
          projectName={activeProject?.name || "this project"}
          projects={projects}
          activeProjectId={activeId}
          onSelectProject={selectProject}
          voiceRefreshAvailable={voiceRefreshAvailable}
          refreshingVoice={refreshingVoice}
          onRefreshDrafts={refreshDraftsWithVoice}
          filter={findFilter}
          setFilter={setFindFilter}
          gmail={activeMailbox}
          draftingId={findDraftingId}
          gmailBusyId={gmailBusyId}
          onDraft={draftFind}
          onDeny={(f, reason) => denyFindWithReason(f.id, reason || "")}
          onSetReason={(f, reason) => setFindReason(f.id, reason)}
          onReopen={(f) => setFindStatus(f.id, "new")}
          onMarkSent={(f) => markContacted(f.id)}
          onStatus={(f, s) => setFindStatus(f.id, s)}
          onRemove={(f) => removeFind(f.id)}
          onSendGmail={sendFindViaGmail}
          onSchedule={scheduleFindSend}
          onMeetingPrep={generateMeetingPrep}
          meetingPrepId={meetingPrepId}
          onCopy={() => bumpActivity({ copies: 1 })}
          onEditDraft={editFindDraft}
          onDeepScan={deepScanFind}
          scanningId={scanningId}
          onFollowUp={followUpFind}
          followUpId={followUpId}
          jobMode={isJobUseCaseClient(activeUseCase)}
          onDraftApplication={draftApplicationFor}
          applyingId={applyingId}
          hasResume={!!resumeFile}
          onToggleAttach={setFindAttach}
          onTogglePin={togglePin}
          onCheckReplies={checkReplies}
          repliesBusy={repliesBusy}
          repliesNote={repliesNote}
          goOutreach={() => setTab("outreach")}
        />
      )}

      {tab === "dashboard" && (
        <DashboardTab
          activity={activity}
          profile={profile}
          templates={myTemplates}
          projects={projects}
          categoriesCount={categories.length}
          finds={finds}
          community={community}
          coaching={coaching}
          editPairs={editPairs}
          onApplyTip={addCoaching}
          onRemoveTip={removeCoaching}
          goOutreach={() => setTab("outreach")}
          goTemplates={() => setTab("templates")}
          goProfile={() => setTab("profile")}
          goFinds={() => setTab("finds")}
          onEditProject={(id) => {
            selectProject(id);
            setEditingProjects(true);
            setTab("outreach");
          }}
          onSeedTemplateForChannel={(channel) => {
            setMtChannel(channel);
            setTab("templates");
          }}
        />
      )}

      {tab === "team" && (
        <TeamTab
          getToken={getToken}
          accountEmail={accountEmail || ""}
          projects={projects}
          finds={finds}
        />
      )}

      {tab === "templates" && (
        <TemplatesTab
          kinds={OUTREACH_KINDS}
          channel={mtChannel}
          setChannel={setMtChannel}
          text={mtText}
          setText={setMtText}
          add={addTemplate}
          list={myTemplates}
          remove={(id) => saveTpls(myTemplates.filter((s) => s.id !== id))}
          projects={projects}
          categories={categories}
          scopeProjectId={mtProjectId}
          scopeCategoryId={mtCategoryId}
          setScopeProjectId={(id) => {
            setMtProjectId(id);
            setMtCategoryId(""); // switching project clears the category choice
          }}
          setScopeCategoryId={setMtCategoryId}
        />
      )}

      {tab === "profile" && (
        <ProfileTab
          name={profile.name}
          bio={profile.bio}
          linkedin={profile.linkedin || ""}
          useCase={profile.useCase}
          age={profile.age}
          college={profile.college || ""}
          location={profile.location || ""}
          companySize={profile.companySize || "any"}
          competitiveness={profile.competitiveness || "any"}
          onName={(v) => patchProfile({ name: v })}
          onBio={(v) => patchProfile({ bio: v })}
          onLinkedin={(v) => patchProfile({ linkedin: v })}
          onAge={(v) => patchProfile({ age: v })}
          onCollege={(v) => patchProfile({ college: v })}
          onLocation={(v) => patchProfile({ location: v })}
          onCompanySize={(v) => patchProfile({ companySize: v })}
          onCompetitiveness={(v) => patchProfile({ competitiveness: v })}
          onUseCase={changeUseCase}
          onAutofill={autofillIdentity}
          canConfirm={profileComplete}
          onConfirm={() => setTab("outreach")}
          mailboxAvailable={!!getToken}
          gmail={gmail}
          gmailNote={gmailNote}
          onConnectGmail={connectGmail}
          onDisconnectGmail={disconnectGmail}
          onGmailMode={setGmailMode}
          outlook={outlook}
          outlookNote={outlookNote}
          onConnectOutlook={connectOutlook}
          onDisconnectOutlook={disconnectOutlook}
          onOutlookMode={setOutlookMode}
          projects={projects}
          categories={categories}
          onAddProject={addProject}
          onRenameProject={renameProject}
          onRemoveProject={removeProject}
          onAddCategory={addCategoryToProject}
          onRenameCategory={renameCategory}
          onRemoveCategory={removeCategory}
          onRemoveCategories={removeCategoriesBulk}
          onReorderCategories={reorderCategoriesInProject}
          onDeriveGoal={deriveCategoryGoal}
          resumeFileName={resumeFile?.name || ""}
          onResumeFile={storeResumeFile}
          onClearResume={() => saveResumeFile(null)}
          signature={signature}
          onSignature={saveSignature}
          onImport={() => setImportOpen(true)}
        />
      )}

      {tab === "account" && accountEmail && (
        <main className="mx-auto max-w-3xl px-6 py-12">
          <h1 className="text-2xl font-semibold tracking-tight text-ink">
            Your <span className="brand-text">account</span>
          </h1>
          <p className="mt-2 text-[15px] leading-relaxed text-body">
            Your login and everything Scout saves for you live here.
          </p>
          <AccountCard
            email={accountEmail}
            busy={accountBusy}
            note={accountNote}
            onChangePassword={changePassword}
            onDeleteAccount={deleteAccount}
            onLogout={onLogout}
          />

          {isOwner && (
            <section className="mt-6 rounded-3xl border border-warm-border bg-surface p-6 shadow-soft sm:p-8">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="max-w-md">
                  <h2 className="text-base font-extrabold tracking-tight text-ink">
                    Team admin
                  </h2>
                  <p className="mt-1.5 text-sm leading-relaxed text-body">
                    Aggregate view of every user's denials, approvals, and
                    reasons — the signal for tuning Scout's discovery. Only
                    visible to owners.
                  </p>
                </div>
                <a
                  href="/admin"
                  className="rounded-xl bg-brown px-4 py-2.5 text-sm font-bold text-white shadow-soft transition hover:opacity-90"
                >
                  Open admin →
                </a>
              </div>
            </section>
          )}
        </main>
      )}

      {tab === "settings" && (
        <SettingsTab onStartTour={startTour} onExport={exportMyData} />
      )}

      </div>

      {/* ---------------- Footer ---------------- */}
      <footer className="relative border-t border-warm-border bg-surface/70">
        <CornerDog />
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2 px-6 py-6 text-xs text-body/70">
          <Logo small />
          <span className="font-semibold text-ink">
            <span className="brand-text">Scout</span>
          </span>
          <span className="ml-auto">
            Discover, draft, and connect, in your own voice.
          </span>
        </div>
      </footer>
      </div>

      {/* ---------------- Full-screen finds ---------------- */}
      {expanded && opps.length > 0 && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-ink/40 p-3 backdrop-blur-sm sm:p-8"
          onClick={() => setExpanded(false)}
        >
          <div
            className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-3xl border border-warm-border bg-surface shadow-soft"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 border-b border-warm-border px-6 py-4">
              <Avatar />
              <div>
                <div className="text-sm font-bold text-ink">Scout</div>
                <div className="text-xs text-body/80">
                  {opps.length} {uc.targetNoun} who fit
                </div>
              </div>
              <button
                onClick={() => setExpanded(false)}
                className="ml-auto rounded-lg border border-warm-border px-3 py-1.5 text-xs font-semibold text-body transition hover:bg-warm-bg"
              >
                Close
              </button>
            </div>
            <div className="overflow-auto p-5 sm:p-6">
              <FindsList
                opps={visibleOpps}
                selected={selected}
                onApprove={toggle}
                onDeny={denyOpp}
                roomy
              />
            </div>
            <div className="flex flex-wrap items-center gap-3 border-t border-warm-border px-6 py-4">
              <span className="text-sm text-body/80">{selectedCount} approved</span>
              <button
                onClick={runDraft}
                disabled={drafting || selectedCount === 0}
                className="ml-auto rounded-xl bg-brand-gradient px-5 py-2.5 text-sm font-bold text-white shadow-soft transition hover:opacity-95 disabled:opacity-50"
              >
                {drafting ? "Drafting…" : `Draft the ${selectedCount} approved`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


/* ---------------- Draft kind picker ----------------
 * A small pill dropdown replacing the static "email/message" tag on a draft
 * card. Choosing a new outreach kind re-drafts just that message for the new
 * format (LinkedIn DM, cover letter, text message, etc.) via /api/draft. */
function DraftKindPicker({
  value,
  options,
  busy,
  onChange,
}: {
  value: string;
  options: string[];
  busy: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <label className="relative inline-flex items-center">
      <select
        value={value}
        disabled={busy}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Change outreach format"
        title="Change outreach format"
        className="scout-select cursor-pointer appearance-none rounded-full bg-brand-gradient py-0.5 pl-3 pr-6 text-xs font-semibold text-white shadow-card outline-none transition hover:opacity-95 disabled:opacity-60"
      >
        {options.map((o) => (
          <option key={o} value={o} className="text-ink">
            {o}
          </option>
        ))}
      </select>
      <span
        aria-hidden
        className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-white"
      >
        {busy ? "…" : "▾"}
      </span>
    </label>
  );
}

/* ---------------- Search progress bar ----------------
 * Discovery takes ~30–60s and the API doesn't stream progress, so we show a
 * synthetic bar that eases toward ~92% (fast at first, slow near the end) and
 * rotates through stage labels. `startedAt` is a timestamp lifted to the parent
 * so the bar computes progress from the real search start — that way switching
 * tabs and coming back resumes at the correct percentage instead of restarting.
 * When `active` flips false we snap to 100% before unmounting. */
const SEARCH_STAGES = [
  "Reading the web",
  "Finding real contacts",
  "Checking who fits",
  "Ranking your matches",
  "Almost there",
];
const SEARCH_TAU = 22000; // easing time constant — controls approach speed
const SEARCH_CAP = 92; // hold here until the request actually finishes

function searchPctFor(startedAt: number | null): number {
  if (!startedAt) return 0;
  const t = Date.now() - startedAt;
  return SEARCH_CAP * (1 - Math.exp(-t / SEARCH_TAU));
}
function searchStageFor(startedAt: number | null): number {
  if (!startedAt) return 0;
  const t = Date.now() - startedAt;
  return Math.min(SEARCH_STAGES.length - 1, Math.floor(t / 7000));
}

function SearchProgress({
  active,
  startedAt,
}: {
  active: boolean;
  startedAt: number | null;
}) {
  // Transient display values — updated every animation frame directly on the
  // DOM so we don't rerender the component 60×/sec. React state was churning
  // the whole subtree; refs let CSS + textContent carry the update.
  const barRef = useRef<HTMLDivElement | null>(null);
  const pctRef = useRef<HTMLSpanElement | null>(null);
  const stageRef = useRef<HTMLSpanElement | null>(null);

  const apply = (pctVal: number, stageIdx: number) => {
    if (barRef.current) barRef.current.style.width = `${pctVal}%`;
    if (pctRef.current) pctRef.current.textContent = `${Math.round(pctVal)}%`;
    if (stageRef.current) stageRef.current.textContent = SEARCH_STAGES[stageIdx];
  };

  useEffect(() => {
    if (!active) {
      // Snap to full so the user sees the bar complete before it disappears.
      apply(100, SEARCH_STAGES.length - 1);
      return;
    }
    apply(searchPctFor(startedAt), searchStageFor(startedAt));
    let raf = 0;
    const tick = () => {
      apply(searchPctFor(startedAt), searchStageFor(startedAt));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, startedAt]);

  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-ink">Scout is searching</span>
        <span
          ref={pctRef}
          className="ml-auto text-xs font-bold tabular-nums text-body/70"
        >
          {Math.round(searchPctFor(startedAt))}%
        </span>
      </div>
      <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-brown-tint">
        <div
          ref={barRef}
          className="h-full rounded-full bg-brown transition-[width] duration-300 ease-out"
          style={{ width: `${searchPctFor(startedAt)}%` }}
        />
      </div>
      <p className="mt-2 text-xs text-body">
        <span ref={stageRef}>{SEARCH_STAGES[searchStageFor(startedAt)]}</span>… Usually 30
        to 60 seconds.
      </p>
    </div>
  );
}

/* ---------------- Global search chip ----------------
 * A compact status pill that stays pinned in the bottom-right whenever a
 * discovery request is in flight, on every tab. Clicking it takes the user
 * back to Outreach where the full progress card lives. */
function GlobalScoutStatus({
  startedAt,
  onGo,
}: {
  startedAt: number | null;
  onGo: () => void;
}) {
  // Same trick as SearchProgress — write to the DOM directly in the RAF tick
  // so the chip doesn't rerender every frame.
  const fillRef = useRef<HTMLSpanElement | null>(null);
  const pctRef = useRef<HTMLSpanElement | null>(null);

  const apply = (v: number) => {
    if (fillRef.current) fillRef.current.style.width = `${v}%`;
    if (pctRef.current) pctRef.current.textContent = `${Math.round(v)}%`;
  };

  useEffect(() => {
    apply(searchPctFor(startedAt));
    let raf = 0;
    const tick = () => {
      apply(searchPctFor(startedAt));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startedAt]);

  return (
    <button
      onClick={onGo}
      title="Back to Outreach"
      className="fixed bottom-6 right-6 z-40 flex items-center gap-2.5 rounded-full border border-warm-border bg-surface/95 px-3.5 py-2 shadow-soft backdrop-blur transition hover:border-brown/40 hover:shadow-card"
    >
      <span className="relative flex h-5 w-5 items-center justify-center">
        <span className="absolute inset-0 animate-ping rounded-full bg-brown/30" />
        <span className="relative h-2 w-2 rounded-full bg-brown" />
      </span>
      <span className="text-xs font-bold text-ink">Scouting</span>
      <span className="h-1.5 w-20 overflow-hidden rounded-full bg-brown-tint">
        <span
          ref={fillRef}
          className="block h-full rounded-full bg-brown transition-[width] duration-300 ease-out"
          style={{ width: `${searchPctFor(startedAt)}%` }}
        />
      </span>
      <span
        ref={pctRef}
        className="w-8 text-right text-[11px] font-bold tabular-nums text-body/70"
      >
        {Math.round(searchPctFor(startedAt))}%
      </span>
    </button>
  );
}

/* ---------------- Sidebar navigation ---------------- */
function SideNav({
  tab,
  setTab,
  newFindCount,
  templatesCount,
  profileHasBio,
  hasAccount,
  projects,
  activeId,
  onSelectProject,
  showLogout,
  onLogout,
}: {
  tab: string;
  setTab: (t: any) => void;
  newFindCount: number;
  templatesCount: number;
  profileHasBio: boolean;
  hasAccount: boolean;
  projects: Project[];
  activeId: string;
  onSelectProject: (id: string) => void;
  showLogout: boolean;
  onLogout?: () => void;
}) {
  const items: {
    key: string;
    label: string;
    icon: React.ReactNode;
    badge?: number;
    dot?: boolean;
  }[] = [
    {
      key: "dashboard",
      label: "Dashboard",
      icon: (
        <>
          <rect x="3" y="3" width="7" height="9" rx="1.5" />
          <rect x="14" y="3" width="7" height="5" rx="1.5" />
          <rect x="14" y="12" width="7" height="9" rx="1.5" />
          <rect x="3" y="16" width="7" height="5" rx="1.5" />
        </>
      ),
    },
    {
      key: "outreach",
      label: "Outreach",
      icon: <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4L3 21l1.1-3.3A8.4 8.4 0 1 1 21 11.5Z" />,
    },
    {
      key: "finds",
      label: "Finds",
      badge: newFindCount,
      icon: <path d="M20 7 9 18l-5-5" />,
    },
    {
      key: "templates",
      label: "Templates",
      badge: templatesCount,
      icon: (
        <>
          <rect x="4" y="4" width="16" height="16" rx="2.5" />
          <path d="M8 9h8M8 13h5" />
        </>
      ),
    },
    {
      key: "profile",
      label: "Profile",
      dot: profileHasBio,
      icon: (
        <>
          <circle cx="12" cy="8" r="4" />
          <path d="M4 21a8 8 0 0 1 16 0" />
        </>
      ),
    },
    ...(hasAccount
      ? [
          {
            key: "team",
            label: "Team",
            icon: (
              <>
                <circle cx="9" cy="8" r="3.2" />
                <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
                <circle cx="17.5" cy="9.5" r="2.6" />
                <path d="M15 20a6 6 0 0 1 6.5-5.6" />
              </>
            ),
          },
        ]
      : []),
  ];

  return (
    <aside className="sticky top-0 flex h-screen w-[228px] shrink-0 flex-col gap-1 border-r border-warm-border bg-surface p-4">
      <a
        href="/"
        aria-label="Scout home"
        title="Back to homepage"
        className="flex items-center gap-2.5 rounded-xl px-2 pb-4 pt-1 transition hover:opacity-80"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/scout-logo.png" alt="Scout" width={36} height={36} className="h-9 w-9" />
        <span className="text-xl font-extrabold tracking-tight text-ink">Scout</span>
      </a>

      <div className="px-2 pb-1 pt-2 text-[10px] font-bold uppercase tracking-[0.09em] text-muted">
        Menu
      </div>
      <nav className="flex flex-col gap-1">
        {items.map((it) => {
          const active = tab === it.key;
          return (
            <button
              key={it.key}
              data-tour={`nav-${it.key}`}
              onClick={() => setTab(it.key)}
              className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition ${
                active
                  ? "bg-brown text-white shadow-soft"
                  : "text-body hover:bg-brown-tint hover:text-brown-deep"
              }`}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={active ? "" : "opacity-80"}
              >
                {it.icon}
              </svg>
              {it.label}
              {typeof it.badge === "number" && it.badge > 0 && (
                <span
                  className={`ml-auto rounded-full px-2 py-0.5 text-[11px] font-extrabold ${
                    active ? "bg-white/20 text-white" : "bg-brown-tint text-brown-deep"
                  }`}
                >
                  {it.badge}
                </span>
              )}
              {it.dot && (
                <span
                  className={`ml-auto h-1.5 w-1.5 rounded-full ${
                    active ? "bg-surface" : "bg-brown"
                  }`}
                />
              )}
            </button>
          );
        })}
      </nav>

      <div className="mt-auto border-t border-warm-border pt-3">
        <div className="px-2 pb-1.5 text-[10px] font-bold uppercase tracking-[0.09em] text-muted">
          Active project
        </div>
        {projects.length > 0 && (
          <select
            value={activeId}
            onChange={(e) => onSelectProject(e.target.value)}
            className="scout-select w-full rounded-xl border border-warm-border bg-surface px-3 py-2.5 text-xs font-bold text-ink outline-none transition focus:border-brown"
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        {hasAccount && (
          <button
            onClick={() => setTab("account")}
            className={`mt-3 flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition ${
              tab === "account"
                ? "bg-brown text-white shadow-soft"
                : "text-body hover:bg-brown-tint hover:text-brown-deep"
            }`}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={tab === "account" ? "" : "opacity-80"}
            >
              <circle cx="12" cy="8" r="3.5" />
              <path d="M5 20a7 7 0 0 1 14 0" />
            </svg>
            Account
          </button>
        )}
        <button
          onClick={() => setTab("settings")}
          className={`mt-2 flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition ${
            tab === "settings"
              ? "bg-brown text-white shadow-soft"
              : "text-body hover:bg-brown-tint hover:text-brown-deep"
          }`}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={tab === "settings" ? "" : "opacity-80"}
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
          </svg>
          Settings
        </button>
        {showLogout && (
          <button
            onClick={onLogout}
            className="mt-2 w-full rounded-xl border border-warm-border px-3 py-2 text-xs font-semibold text-body transition hover:bg-brown-tint"
          >
            Log out
          </button>
        )}
      </div>
    </aside>
  );
}

/* ---------------- Sources list ----------------
 * Expandable row on a find card that shows every article Scout used to learn
 * about this person, when there's more than one. Collapsed to a "N articles"
 * pill by default so cards stay scannable; click to reveal the URLs. */
function SourcesList({ sources }: { sources: SourceRef[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-full border border-warm-border bg-warm-bg/60 px-2.5 py-1 text-[11px] font-bold text-brown-deep transition hover:bg-brown-tint"
        aria-expanded={open}
      >
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.5 1.5" />
          <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.5-1.5" />
        </svg>
        {sources.length} articles about this person
        <span aria-hidden className="text-body/60">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <ul className="mt-2 space-y-1.5 text-xs">
          {sources.map((s, i) => (
            <li key={`${s.url}-${i}`} className="flex items-start gap-2 leading-relaxed">
              <span className="mt-0.5 shrink-0 rounded bg-brown-tint px-1.5 py-0.5 text-[10px] font-bold text-brown-deep tabular-nums">
                {i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-semibold text-ink">
                  {s.title || "(untitled)"}
                </div>
                {s.url && (
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noreferrer"
                    className="truncate block text-body/60 underline-offset-2 hover:underline"
                  >
                    {s.url}
                  </a>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ---------------- Finds list ---------------- */
function FindsList({
  opps,
  selected,
  onApprove,
  onDeny,
  roomy = false,
}: {
  opps: Opportunity[];
  selected: Record<string, boolean>;
  onApprove: (id: string, v: boolean) => void;
  onDeny: (o: Opportunity, reason?: string) => void;
  roomy?: boolean;
}) {
  const [denyingId, setDenyingId] = useState("");
  return (
    <Reveal className={`grid gap-3 ${roomy ? "lg:grid-cols-2" : "grid-cols-1"}`} stagger={0.05}>
      {opps.map((o) => {
        const on = !!selected[o.id];
        return (
          <div
            key={o.id}
            className={`flex flex-col gap-3 rounded-2xl border p-3.5 transition ${
              on
                ? "border-coral/40 bg-warm-bg/60"
                : "border-warm-border bg-surface"
            }`}
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-ink">
                  {o.url ? (
                    <a
                      href={o.url}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="transition hover:text-accent"
                    >
                      {o.name}
                    </a>
                  ) : (
                    o.name
                  )}
                </span>
                {o.fitScore != null && (
                  <span className="rounded-full bg-brand-gradient px-2 py-0.5 text-[10px] font-bold text-white">
                    {Math.round(o.fitScore * 100)}% fit
                  </span>
                )}
                <span className="rounded-full border border-warm-border bg-warm-bg px-2 py-0.5 text-[10px] font-medium text-body">
                  {o.channel}
                </span>
              </div>
              {(o.outlet || o.location) && (
                <div className="mt-0.5 text-xs text-body/80">
                  {[o.outlet, o.location].filter(Boolean).join(" · ")}
                </div>
              )}
              <div className="mt-1 text-xs">
                {o.contactEmail && (
                  <ContactValue
                    value={o.contactEmail}
                    className="font-semibold text-accent"
                  />
                )}
                {o.contactName && (
                  <span className="text-body">
                    {o.contactEmail ? "  ·  " : ""}
                    {o.contactName}
                    {o.contactRole ? ` (${o.contactRole})` : ""}
                  </span>
                )}
                {o.contactHandle && (
                  <span className="text-body/70">
                    {o.contactEmail || o.contactName ? "  ·  " : ""}
                    <ContactValue value={o.contactHandle} className="text-body/70" />
                  </span>
                )}
                {!o.contactEmail && !o.contactName && !o.contactHandle && (
                  <span className="text-body/40">no direct contact found yet</span>
                )}
              </div>
              {o.whyItFits && (
                <div className="mt-1.5 text-xs leading-relaxed text-body">
                  {o.whyItFits}
                </div>
              )}
            </div>
            <div className="flex items-center gap-2 border-t border-warm-border/70 pt-2.5">
              <button
                onClick={() => onApprove(o.id, !on)}
                className={`rounded-lg px-3.5 py-1.5 text-xs font-bold transition ${
                  on
                    ? "bg-brand-gradient text-white shadow-card"
                    : "border border-warm-border text-body hover:bg-warm-bg"
                }`}
              >
                {on ? "Approved" : "Approve"}
              </button>
              {denyingId === o.id ? (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[10px] text-body/45">
                    Why? optional, but a reason helps Scout learn faster
                  </span>
                  <DenyReasons
                    onPick={(r) => {
                      setDenyingId("");
                      onDeny(o, r);
                    }}
                  />
                  <button
                    onClick={() => {
                      setDenyingId("");
                      onDeny(o, "");
                    }}
                    className="text-[11px] font-semibold text-body/50 transition hover:text-accent"
                  >
                    Skip
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setDenyingId(o.id)}
                  className="rounded-lg border border-warm-border px-3.5 py-1.5 text-xs font-semibold text-body/70 transition hover:border-coral/40 hover:bg-warm-bg hover:text-accent"
                >
                  Deny
                </button>
              )}
              {on && denyingId !== o.id && (
                <span className="ml-auto text-[11px] font-medium text-accent">
                  Will be drafted
                </span>
              )}
            </div>
          </div>
        );
      })}
    </Reveal>
  );
}

/* ---------------- Clickable contact value (email → mailto, URL/handle → link) ---------------- */
function mailHref(v: string): string | null {
  const s = String(v || "").trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? "mailto:" + s : null;
}
function linkHref(v: string): string | null {
  const s = String(v || "").trim();
  if (!s || s.includes("@")) return null;
  if (/^https?:\/\//i.test(s)) return s;
  // A domain/handle like "linkedin.com/in/x" or "twitter.com/x" — make it absolute.
  if (/^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(s)) return "https://" + s.replace(/^\/+/, "");
  return null;
}
function ContactValue({
  value,
  className = "",
}: {
  value: string;
  className?: string;
}) {
  const mail = mailHref(value);
  const href = mail || linkHref(value);
  if (!href) return <span className={className}>{value}</span>;
  return (
    <a
      href={href}
      target={mail ? undefined : "_blank"}
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      className={`${className} underline decoration-dotted underline-offset-2 transition hover:text-accent`}
    >
      {value}
    </a>
  );
}

/* ---------------- Deny reason picker (preset chips + free text) ---------------- */
function DenyReasons({
  current,
  onPick,
}: {
  current?: string;
  onPick: (reason: string) => void;
}) {
  const [other, setOther] = useState("");
  const [showOther, setShowOther] = useState(false);
  const isPreset = !current || DENY_REASONS.includes(current);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {DENY_REASONS.map((r) => (
        <button
          key={r}
          onClick={() => onPick(r)}
          className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold transition ${
            current === r
              ? "border-coral/50 bg-brand-gradient text-white"
              : "border-warm-border bg-surface text-body hover:bg-warm-bg"
          }`}
        >
          {r}
        </button>
      ))}
      {showOther || (current && !isPreset) ? (
        <input
          autoFocus
          value={other || (current && !isPreset ? current : "")}
          onChange={(e) => setOther(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && other.trim()) onPick(other.trim());
          }}
          onBlur={() => other.trim() && onPick(other.trim())}
          placeholder="Other reason…"
          className="min-w-[140px] rounded-full border border-warm-border px-2.5 py-1 text-[11px] text-ink outline-none focus:border-coral"
        />
      ) : (
        <button
          onClick={() => setShowOther(true)}
          className="rounded-full border border-warm-border bg-surface px-2.5 py-1 text-[11px] font-semibold text-body/70 transition hover:bg-warm-bg"
        >
          Other…
        </button>
      )}
    </div>
  );
}

/* ---------------- Finds tab (pipeline: review / draft / deny / mark sent) ---------------- */
function FindsTab({
  finds,
  projectName,
  projects,
  activeProjectId,
  onSelectProject,
  voiceRefreshAvailable,
  refreshingVoice,
  onRefreshDrafts,
  filter,
  setFilter,
  gmail,
  draftingId,
  gmailBusyId,
  onDraft,
  onDeny,
  onSetReason,
  onReopen,
  onMarkSent,
  onStatus,
  onRemove,
  onSendGmail,
  onSchedule,
  onMeetingPrep,
  meetingPrepId,
  onCopy,
  onEditDraft,
  onDeepScan,
  scanningId,
  onFollowUp,
  followUpId,
  jobMode,
  onDraftApplication,
  applyingId,
  hasResume,
  onToggleAttach,
  onTogglePin,
  onCheckReplies,
  repliesBusy,
  repliesNote,
  goOutreach,
}: {
  finds: Find[];
  projectName: string;
  projects: Project[];
  activeProjectId: string;
  onSelectProject: (id: string) => void;
  voiceRefreshAvailable: boolean;
  refreshingVoice: boolean;
  onRefreshDrafts: () => void;
  filter: FindStatus | "all";
  setFilter: (f: FindStatus | "all") => void;
  gmail: { connected: boolean; email?: string; sendMode?: "draft" | "send"; label?: string };
  draftingId: string;
  gmailBusyId: string;
  onDraft: (f: Find) => void;
  onDeny: (f: Find, reason?: string) => void;
  onSetReason: (f: Find, reason: string) => void;
  onReopen: (f: Find) => void;
  onMarkSent: (f: Find) => void;
  onStatus: (f: Find, s: FindStatus) => void;
  onRemove: (f: Find) => void;
  onSendGmail: (f: Find) => void;
  onSchedule: (f: Find, sendAt: Date) => void;
  onMeetingPrep: (f: Find) => void;
  meetingPrepId: string;
  onCopy: () => void;
  onEditDraft: (f: Find, subject: string, body: string) => void;
  onDeepScan: (f: Find) => void;
  scanningId: string;
  onFollowUp: (f: Find) => void;
  followUpId: string;
  jobMode: boolean;
  onDraftApplication: (f: Find) => void;
  applyingId: string;
  hasResume: boolean;
  onToggleAttach: (f: Find, on: boolean) => void;
  onTogglePin: (id: string) => void;
  onCheckReplies: () => void;
  repliesBusy: boolean;
  repliesNote: string;
  goOutreach: () => void;
}) {
  const counts: Record<string, number> = { all: finds.length };
  for (const s of ["new", "drafted", "sent", "replied", "denied"] as FindStatus[]) {
    counts[s] = finds.filter((f) => f.status === s).length;
  }
  const trackable = finds.some(
    (f) =>
      (f.gmailThreadId || f.outlookThreadId) &&
      f.status !== "replied" &&
      f.status !== "denied"
  );
  const shown = (filter === "all" ? finds : finds.filter((f) => f.status === filter))
    .slice()
    // Pinned finds first, then best-fit.
    .sort(
      (a, b) =>
        (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) ||
        (b.opp.fitScore || 0) - (a.opp.fitScore || 0)
    );

  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">
            Your <span className="brand-text">finds</span>
          </h1>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Label className="mb-0">Project</Label>
            <select
              value={activeProjectId}
              onChange={(e) => onSelectProject(e.target.value)}
              className="scout-select rounded-xl border border-warm-border bg-surface px-3 py-2 text-sm font-semibold text-ink outline-none transition focus:border-brown"
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {gmail.connected && trackable && (
            <button
              onClick={onCheckReplies}
              disabled={repliesBusy}
              title="Scout checks your inbox for replies automatically; this checks right now."
              className="rounded-xl border border-warm-border bg-surface px-4 py-2.5 text-sm font-semibold text-body transition hover:bg-warm-bg disabled:opacity-50"
            >
              {repliesBusy ? "Checking…" : "Check replies now"}
            </button>
          )}
          <button
            onClick={goOutreach}
            className="rounded-xl bg-brand-gradient px-5 py-2.5 text-sm font-bold text-white shadow-soft transition hover:opacity-95"
          >
            Find opportunities
          </button>
        </div>
      </div>

      {repliesNote && (
        <p className="mt-3 rounded-xl border border-warm-border bg-warm-bg/60 px-4 py-2.5 text-xs font-medium text-ink">
          {repliesNote}
        </p>
      )}

      {/* Voice refresh: after an edit, offer to re-write un-sent drafts with
          what Scout just learned about how you write. */}
      {voiceRefreshAvailable && (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-2xl border border-sage/40 bg-sage/10 p-4">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-extrabold text-ink">
              Scout learned from your edit
            </div>
            <p className="mt-0.5 text-xs leading-relaxed text-body/80">
              Re-write your drafts you haven't sent yet in your updated voice,
              so every message reflects the latest changes you made.
            </p>
          </div>
          <button
            onClick={onRefreshDrafts}
            disabled={refreshingVoice}
            className="shrink-0 rounded-xl bg-brown px-4 py-2 text-xs font-bold text-white shadow-soft transition hover:opacity-90 disabled:opacity-50"
          >
            {refreshingVoice ? "Re-writing…" : "Update my drafts"}
          </button>
        </div>
      )}

      {/* Status filter */}
      <div className="mt-6 flex flex-wrap gap-2">
        {FIND_STATUSES.map((s) => {
          const on = filter === s.key;
          return (
            <button
              key={s.key}
              onClick={() => setFilter(s.key)}
              className={`rounded-full border px-3.5 py-1.5 text-xs font-semibold transition ${
                on
                  ? "border-coral/50 bg-brand-gradient text-white"
                  : "border-warm-border bg-surface text-body hover:bg-warm-bg"
              }`}
            >
              {s.label}
              <span className={on ? "text-white/80" : "text-body/50"}>
                {" "}
                {counts[s.key] || 0}
              </span>
            </button>
          );
        })}
      </div>

      {shown.length === 0 ? (
        <div className="mt-6 rounded-2xl border border-dashed border-warm-border bg-surface/60 p-12 text-center text-sm text-body/70">
          {finds.length === 0 ? (
            <>
              No finds yet. Run a search on the{" "}
              <button onClick={goOutreach} className="font-semibold text-accent hover:underline">
                Outreach
              </button>{" "}
              tab and everyone Scout finds lands here.
            </>
          ) : (
            "Nothing in this list."
          )}
        </div>
      ) : (
        <div className="mt-5 space-y-3">
          {shown.map((f) => (
            <FindCard
              key={f.id}
              find={f}
              gmail={gmail}
              drafting={draftingId === f.id}
              gmailBusy={!!f.draft && gmailBusyId === f.draft.opportunityId}
              onDraft={() => onDraft(f)}
              onDeny={(reason) => onDeny(f, reason)}
              onSetReason={(reason) => onSetReason(f, reason)}
              onReopen={() => onReopen(f)}
              onMarkSent={() => onMarkSent(f)}
              onStatus={(s) => onStatus(f, s)}
              onRemove={() => onRemove(f)}
              onSendGmail={() => onSendGmail(f)}
              onSchedule={(date) => onSchedule(f, date)}
              onMeetingPrep={() => onMeetingPrep(f)}
              meetingPrepBusy={meetingPrepId === f.id}
              onCopy={onCopy}
              onEditDraft={(subject, body) => onEditDraft(f, subject, body)}
              onDeepScan={() => onDeepScan(f)}
              scanning={scanningId === f.id}
              onFollowUp={() => onFollowUp(f)}
              followUpBusy={followUpId === f.id}
              jobMode={jobMode}
              onDraftApplication={() => onDraftApplication(f)}
              applying={applyingId === f.id}
              hasResume={hasResume}
              onToggleAttach={(on) => onToggleAttach(f, on)}
              onTogglePin={() => onTogglePin(f.id)}
            />
          ))}
        </div>
      )}
    </main>
  );
}

// The status pill is also the manual control: pick any status directly.
function FindStatusBadge({
  status,
  onStatus,
}: {
  status: FindStatus;
  onStatus: (s: FindStatus) => void;
}) {
  const map: Record<FindStatus, string> = {
    new: "border-warm-border bg-warm-bg text-body",
    drafted: "border-coral/30 bg-warm-bg text-accent",
    sent: "border-sage/40 bg-sage/15 text-sage",
    replied: "border-sage/60 bg-sage/25 text-brown-deep",
    denied: "border-warm-border bg-surface text-body/50",
  };
  return (
    <select
      value={status}
      onChange={(e) => onStatus(e.target.value as FindStatus)}
      title="Set status"
      aria-label="Set status"
      className={`cursor-pointer appearance-none rounded-full border px-2 py-0.5 text-[10px] font-bold outline-none transition focus:ring-2 focus:ring-coral/20 ${map[status]}`}
    >
      {STATUS_OPTIONS.map((o) => (
        <option key={o.key} value={o.key}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

// The read-out of an internship/job application: an overview, how to apply, and
// every component, with Scout's draft for the written ones and a to-do for the
// rest. Each drafted piece is copyable; "Copy all" grabs the whole packet.
function ApplicationPacket({
  app,
  onCopy,
}: {
  app: NonNullable<Find["application"]>;
  onCopy: () => void;
}) {
  const [copied, setCopied] = useState("");
  const components = app.components || [];
  const drafted = components.filter((c: any) => c.draft);
  const todos = components.filter((c: any) => !c.draft);

  const copy = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    onCopy();
    setCopied(key);
    setTimeout(() => setCopied(""), 1500);
  };
  const copyAll = () => {
    const all = drafted
      .map((c: any) => `${c.title}\n${"-".repeat(c.title.length)}\n${c.draft}`)
      .join("\n\n\n");
    copy(all, "__all");
  };

  return (
    <div className="mt-3 rounded-xl border border-coral/30 bg-warm-bg/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-bold uppercase tracking-wider text-accent">
          Application
        </span>
        {app.overview && <span className="text-xs text-body/80">{app.overview}</span>}
        {drafted.length > 1 && (
          <button
            onClick={copyAll}
            className="ml-auto rounded-lg border border-warm-border px-2.5 py-1 text-[11px] font-semibold text-accent transition hover:bg-surface"
          >
            {copied === "__all" ? "Copied!" : "Copy all"}
          </button>
        )}
      </div>

      {app.howToApply && (
        <div className="mt-1.5 text-xs leading-relaxed text-body">
          <span className="font-semibold">How to apply: </span>
          {app.howToApply}
        </div>
      )}

      {components.length === 0 && (
        <p className="mt-2 text-xs text-body/60">
          No specific written requirements were listed on the page.
        </p>
      )}

      {/* Drafted written components */}
      <div className="mt-2.5 space-y-2.5">
        {drafted.map((c: any, i: number) => (
          <div key={`d${i}`} className="rounded-lg border border-warm-border bg-surface p-3">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-sm font-bold text-ink">{c.title}</span>
              {c.constraints && (
                <span className="text-[11px] text-body/60">{c.constraints}</span>
              )}
              <button
                onClick={() => copy(c.draft, `d${i}`)}
                className="ml-auto rounded-lg border border-warm-border px-2.5 py-1 text-[11px] font-semibold text-accent transition hover:bg-warm-bg"
              >
                {copied === `d${i}` ? "Copied!" : "Copy"}
              </button>
            </div>
            {c.prompt && c.prompt !== c.title && (
              <div className="mt-0.5 text-[11px] italic text-body/60">{c.prompt}</div>
            )}
            <pre className="mt-1.5 whitespace-pre-wrap font-sans text-xs leading-relaxed text-body">
              {c.draft}
            </pre>
          </div>
        ))}
      </div>

      {/* Things the applicant must supply themselves */}
      {todos.length > 0 && (
        <div className="mt-2.5 border-t border-warm-border pt-2.5">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-body/50">
            You&apos;ll also need to provide
          </div>
          <ul className="space-y-1">
            {todos.map((c: any, i: number) => (
              <li key={`t${i}`} className="flex items-start gap-1.5 text-xs text-body">
                <span className="mt-0.5 text-body/40" aria-hidden>
                  ▢
                </span>
                <span>
                  <span className="font-semibold text-ink">{c.title}.</span>
                  {c.action ? ` ${c.action}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// Card color by status, and for sent outreach, by how long it's gone unanswered:
// fresh sends stay neutral, warm to amber as they age, then coral once a
// follow-up is due. Replied is a calm green; denied fades out. (Class strings are
// literal so Tailwind keeps them.)
function findCardTone(find: Find): string {
  if (find.status === "denied") return "border-warm-border bg-surface/60 opacity-70";
  if (find.status === "replied") return "border-sage/50 bg-sage/10";
  if (find.status === "sent") {
    const days = find.sentAt ? (Date.now() - find.sentAt) / 86400000 : 0;
    if (days >= 7 && !find.lastFollowUpAt) return "border-coral/50 bg-coral/10"; // follow-up due
    if (days >= 7) return "border-amber-300/60 bg-amber-50/70"; // followed up, still waiting
    if (days >= 4) return "border-amber-300/50 bg-amber-50/60"; // aging
    return "border-sage/30 bg-surface"; // fresh send
  }
  if (find.status === "drafted") return "border-coral/30 bg-warm-bg/40"; // draft ready
  return "border-warm-border bg-surface"; // new
}

function FindCard({
  find,
  gmail,
  drafting,
  gmailBusy,
  onDraft,
  onDeny,
  onSetReason,
  onReopen,
  onMarkSent,
  onStatus,
  onRemove,
  onSendGmail,
  onSchedule,
  onMeetingPrep,
  meetingPrepBusy,
  onCopy,
  onEditDraft,
  onDeepScan,
  scanning,
  onFollowUp,
  followUpBusy,
  jobMode,
  onDraftApplication,
  applying,
  hasResume,
  onToggleAttach,
  onTogglePin,
}: {
  find: Find;
  gmail: { connected: boolean; email?: string; sendMode?: "draft" | "send"; label?: string };
  drafting: boolean;
  gmailBusy: boolean;
  onDraft: () => void;
  onDeny: (reason?: string) => void;
  onSetReason: (reason: string) => void;
  onReopen: () => void;
  onMarkSent: () => void;
  onStatus: (s: FindStatus) => void;
  onRemove: () => void;
  onSendGmail: () => void;
  onSchedule: (sendAt: Date) => void;
  onMeetingPrep: () => void;
  meetingPrepBusy: boolean;
  onCopy: () => void;
  onEditDraft: (subject: string, body: string) => void;
  onDeepScan: () => void;
  scanning: boolean;
  onFollowUp: () => void;
  followUpBusy: boolean;
  jobMode: boolean;
  onDraftApplication: () => void;
  applying: boolean;
  hasResume: boolean;
  onToggleAttach: (on: boolean) => void;
  onTogglePin: () => void;
}) {
  const o = find.opp;
  const d = find.draft;
  const denied = find.status === "denied";
  // Contacted (or beyond): hide the send/mark actions.
  const done = find.status === "sent" || find.status === "replied";
  const emailDraft = d && d.channelType === "email" && !!mailHref(d.to);
  const [denying, setDenying] = useState(false); // reason picker shown pre-deny
  const [sendGuard, setSendGuard] = useState<null | { local: string; next: string }>(null);
  const [editing, setEditing] = useState(false); // draft edit mode
  const [editSubject, setEditSubject] = useState("");
  const [editBody, setEditBody] = useState("");
  // How long since the outreach went out, for the follow-up nudge.
  const sentAgoDays = find.sentAt ? (Date.now() - find.sentAt) / 86400000 : 0;
  const followUpReady =
    find.status === "sent" && sentAgoDays >= 7 && !find.lastFollowUpAt;

  // Send timing: a real delivery to a person outside their business hours gets a
  // heads-up first. Applications (jobs/internships) always send immediately, and
  // "create draft" mode isn't a delivery so it's never held.
  const recipientTz = o.timezone || guessTimezone(o.location);
  const isApplication = jobMode || !!find.application;
  const afterHours =
    gmail.sendMode === "send" &&
    !isApplication &&
    !!recipientTz &&
    !isBusinessHours(recipientTz);
  const doSend = () => {
    setSendGuard(null);
    onSendGmail();
  };
  const attemptSend = () => {
    if (afterHours) {
      setSendGuard({
        local: localTimeLabel(recipientTz),
        next: nextBusinessLabel(recipientTz),
      });
    } else {
      onSendGmail();
    }
  };

  return (
    <div
      className={`rounded-2xl border p-4 shadow-card transition ${findCardTone(find)} ${
        find.pinned ? "ring-1 ring-coral/30" : ""
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-ink">
          {o.url ? (
            <a href={o.url} target="_blank" rel="noreferrer" className="transition hover:text-accent">
              {o.name}
            </a>
          ) : (
            o.name
          )}
        </span>
        <FindStatusBadge status={find.status} onStatus={onStatus} />
        {o.fitScore != null && (
          <span className="rounded-full bg-brand-gradient px-2 py-0.5 text-[10px] font-bold text-white">
            {Math.round(o.fitScore * 100)}% fit
          </span>
        )}
        <span className="rounded-full border border-warm-border bg-warm-bg px-2 py-0.5 text-[10px] font-medium text-body">
          {o.channel}
        </span>
        {recipientTz && (
          <span
            title={`${o.name}'s local time${
              isBusinessHours(recipientTz) ? "" : " — outside business hours"
            }`}
            className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${
              isBusinessHours(recipientTz)
                ? "border-warm-border bg-warm-bg text-body/70"
                : "border-amber-300/60 bg-amber-50 text-amber-800"
            }`}
          >
            {localTimeLabel(recipientTz)} their time
          </span>
        )}
        <button
          onClick={onTogglePin}
          title={find.pinned ? "Unpin" : "Pin to top"}
          aria-label={find.pinned ? "Unpin find" : "Pin find to top"}
          aria-pressed={!!find.pinned}
          className={`ml-auto shrink-0 rounded-lg border p-1 transition ${
            find.pinned
              ? "border-coral/40 bg-coral/10 text-accent"
              : "border-transparent text-body/40 hover:border-warm-border hover:bg-warm-bg hover:text-accent"
          }`}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill={find.pinned ? "currentColor" : "none"}
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 17v5" />
            <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
          </svg>
        </button>
      </div>

      {(o.outlet || o.location) && (
        <div className="mt-0.5 text-xs text-body/80">
          {[o.outlet, o.location].filter(Boolean).join(" · ")}
        </div>
      )}
      <div className="mt-1 text-xs">
        {o.contactEmail && (
          <ContactValue value={o.contactEmail} className="font-semibold text-accent" />
        )}
        {o.contactName && (
          <span className="text-body">
            {o.contactEmail ? "  ·  " : ""}
            {o.contactName}
            {o.contactRole ? ` (${o.contactRole})` : ""}
          </span>
        )}
        {o.contactHandle && (
          <span className="text-body/70">
            {o.contactEmail || o.contactName ? "  ·  " : ""}
            <ContactValue value={o.contactHandle} className="text-body/70" />
          </span>
        )}
      </div>
      {o.whyItFits && (
        <div className="mt-1.5 text-xs leading-relaxed text-body">{o.whyItFits}</div>
      )}

      {/* Multiple articles that mention this same person — collapsed by default
          so the card stays compact. Renders only when 2+ sources exist. */}
      {o.sources && o.sources.length > 1 && (
        <SourcesList sources={o.sources} />
      )}

      {/* What this target asks for (pasted or found by deep-scan) */}
      {find.requirements && (
        <div className="mt-2 rounded-xl border border-sage/40 bg-sage/10 p-2.5 text-xs leading-relaxed text-brown-deep">
          <span className="font-bold">What they ask for: </span>
          {find.requirements}
        </div>
      )}

      {/* Meeting / interview prep — factual highlights about the contact.
          Unlocked once status ≥ sent, so keeping statuses current pays out
          with real prep. Prep persists on the find once generated. */}
      <MeetingPrepBlock
        find={find}
        busy={meetingPrepBusy}
        onGenerate={onMeetingPrep}
      />

      {/* Stored draft — read view or inline editor */}
      {d && !editing && (
        <div className="mt-3 rounded-xl border border-warm-border bg-warm-bg/40 p-3">
          {d.subject && (
            <div className="mb-1.5 flex items-start justify-between gap-2">
              <div className="text-sm font-semibold text-ink">{d.subject}</div>
            </div>
          )}
          <pre className="whitespace-pre-wrap font-sans text-xs leading-relaxed text-body">
            {d.body}
          </pre>
          {/* Attach-resume toggle (email only). Default comes from the draft API. */}
          {d.channelType === "email" &&
            (hasResume ? (
              <label className="mt-2.5 flex cursor-pointer items-center gap-2 text-xs text-body">
                <input
                  type="checkbox"
                  checked={!!d.attachResume}
                  onChange={(e) => onToggleAttach(e.target.checked)}
                  className="h-3.5 w-3.5 accent-brown"
                />
                <span>
                  Attach my resume
                  {d.attachResume && (
                    <span className="ml-1 font-semibold text-sage">✓</span>
                  )}
                </span>
                <span className="text-body/50">
                  {d.attachResume
                    ? "(Scout suggested this for you)"
                    : ""}
                </span>
              </label>
            ) : d.attachResume ? (
              <p className="mt-2.5 text-[11px] text-body/60">
                This looks like it wants a resume. Add one in your Profile to attach it.
              </p>
            ) : null)}
          <button
            onClick={() => {
              setEditSubject(d.subject || "");
              setEditBody(d.body || "");
              setEditing(true);
            }}
            className="mt-2 text-[11px] font-semibold text-accent transition hover:underline"
          >
            Edit this draft
          </button>
        </div>
      )}
      {d && editing && (
        <div className="mt-3 rounded-xl border border-coral/40 bg-surface p-3">
          {d.channelType === "email" && (
            <input
              value={editSubject}
              onChange={(e) => setEditSubject(e.target.value)}
              placeholder="Subject"
              className="mb-2 w-full rounded-lg border border-warm-border px-2.5 py-1.5 text-sm font-semibold text-ink outline-none focus:ring-2 focus:ring-coral/20"
            />
          )}
          <textarea
            value={editBody}
            onChange={(e) => setEditBody(e.target.value)}
            rows={Math.min(16, Math.max(6, editBody.split("\n").length + 1))}
            className="w-full rounded-lg border border-warm-border px-2.5 py-2 font-sans text-xs leading-relaxed text-body outline-none focus:ring-2 focus:ring-coral/20"
          />
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={() => {
                onEditDraft(editSubject, editBody);
                setEditing(false);
              }}
              className="rounded-lg bg-brand-gradient px-3 py-1.5 text-xs font-bold text-white shadow-card transition hover:opacity-95"
            >
              Save
            </button>
            <button
              onClick={() => setEditing(false)}
              className="rounded-lg border border-warm-border px-3 py-1.5 text-xs font-semibold text-body transition hover:bg-warm-bg"
            >
              Cancel
            </button>
            <span className="text-[11px] text-body/50">
              Scout learns from your edits and writes more like this next time.
            </span>
          </div>
        </div>
      )}

      {/* Full application packet (job/internship) */}
      {find.application && (
        <ApplicationPacket app={find.application} onCopy={onCopy} />
      )}

      {/* Actions */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {find.status === "new" && (
          <button
            onClick={onDraft}
            disabled={drafting}
            className="rounded-lg bg-brand-gradient px-3 py-1.5 text-xs font-bold text-white shadow-card transition hover:opacity-95 disabled:opacity-50"
          >
            {drafting ? "Drafting…" : "Draft a message"}
          </button>
        )}

        {/* Job/internship: read the posting and draft the whole application */}
        {jobMode && o.url && !denied && (
          <button
            onClick={onDraftApplication}
            disabled={applying}
            title="Read this posting's requirements and draft every written part from your Profile"
            className="rounded-lg bg-brand-gradient px-3 py-1.5 text-xs font-bold text-white shadow-card transition hover:opacity-95 disabled:opacity-50"
          >
            {applying
              ? "Reading the application…"
              : find.application
              ? "Redo application"
              : "Draft full application"}
          </button>
        )}

        {/* Deep-scan: read their site for a real contact + what they ask for */}
        {o.url && !denied && !done && (
          <button
            onClick={onDeepScan}
            disabled={scanning}
            title="Read this page for a specific contact and any submission requirements"
            className="rounded-lg border border-warm-border px-3 py-1.5 text-xs font-semibold text-body transition hover:bg-warm-bg disabled:opacity-50"
          >
            {scanning ? "Scanning…" : find.scanned ? "Re-scan site" : "Scan for contact"}
          </button>
        )}

        {d && (
          <>
            {gmail.connected && emailDraft && !done ? (
              <>
                <button
                  onClick={attemptSend}
                  disabled={gmailBusy}
                  className="rounded-lg bg-brand-gradient px-3 py-1.5 text-xs font-bold text-white shadow-card transition hover:opacity-95 disabled:opacity-50"
                >
                  {gmailBusy
                    ? "Working…"
                    : gmail.sendMode === "send"
                      ? `Send from ${gmail.label || "Gmail"}`
                      : `Create ${gmail.label || "Gmail"} draft`}
                </button>
                {gmail.sendMode === "send" && (
                  <SchedulePicker
                    timezone={find.opp.timezone}
                    scheduledFor={find.scheduledSendAt}
                    onSchedule={onSchedule}
                  />
                )}
              </>
            ) : (
              !done && <SendAction draft={d} onUse={onCopy} />
            )}
            <button
              onClick={() => {
                navigator.clipboard.writeText(
                  (d.subject ? `Subject: ${d.subject}\n\n` : "") + d.body
                );
                onCopy();
              }}
              className="rounded-lg border border-warm-border px-3 py-1.5 text-xs font-semibold text-body transition hover:bg-warm-bg"
            >
              Copy
            </button>
            {find.status === "new" && (
              <button
                onClick={onDraft}
                disabled={drafting}
                className="rounded-lg border border-warm-border px-3 py-1.5 text-xs font-semibold text-body transition hover:bg-warm-bg disabled:opacity-50"
              >
                Redraft
              </button>
            )}
          </>
        )}

        {/* Status pill dropdown at the top of the card handles every status
            change (new / drafted / sent / replied / denied) — no separate
            "Mark contacted" button needed. */}

        {/* Follow-up nudge on sent-but-no-reply finds */}
        {find.status === "sent" && (
          <button
            onClick={onFollowUp}
            disabled={followUpBusy}
            title={
              find.gmailThreadId
                ? "Draft a short in-thread nudge"
                : "Draft a short follow-up you can send"
            }
            className={`rounded-lg px-3 py-1.5 text-xs font-bold shadow-card transition disabled:opacity-50 ${
              followUpReady
                ? "bg-brand-gradient text-white hover:opacity-95"
                : "border border-warm-border text-body hover:bg-warm-bg"
            }`}
          >
            {followUpBusy
              ? "Writing…"
              : find.lastFollowUpAt
              ? "Draft another nudge"
              : "Draft a follow-up"}
          </button>
        )}
        {followUpReady && (
          <span className="text-[11px] font-semibold text-sage">
            It&apos;s been about a week, a nudge helps
          </span>
        )}

        {denied ? (
          <button
            onClick={onReopen}
            className="rounded-lg border border-warm-border px-3 py-1.5 text-xs font-semibold text-accent transition hover:bg-warm-bg"
          >
            Reopen
          </button>
        ) : done ? (
          <button
            onClick={onReopen}
            className="ml-auto text-xs font-semibold text-body/50 transition hover:text-accent"
          >
            Reopen
          </button>
        ) : denying ? (
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-semibold text-body/60">Why pass?</span>
            <span className="text-[10px] text-body/45">
              optional, but a reason helps Scout learn faster
            </span>
            <DenyReasons
              onPick={(r) => {
                setDenying(false);
                onDeny(r);
              }}
            />
            <button
              onClick={() => {
                setDenying(false);
                onDeny("");
              }}
              className="text-[11px] font-semibold text-body/50 transition hover:text-accent"
            >
              Skip
            </button>
          </div>
        ) : (
          <button
            onClick={() => setDenying(true)}
            className="ml-auto text-xs font-semibold text-body/50 transition hover:text-accent"
          >
            Not a fit
          </button>
        )}
        {denied && (
          <button
            onClick={onRemove}
            className="text-xs font-semibold text-body/40 transition hover:text-accent"
          >
            Remove
          </button>
        )}
      </div>

      {/* Business-hours heads-up before an out-of-hours send */}
      {sendGuard && (
        <div className="mt-2.5 rounded-xl border border-amber-300/60 bg-amber-50 p-3 text-xs text-amber-900">
          It&apos;s <span className="font-bold">{sendGuard.local}</span> for {o.name}
          {o.location ? ` in ${o.location}` : ""}, outside business hours. Emails
          landing at a good time get read more. Best to send around{" "}
          <span className="font-bold">{sendGuard.next}</span> their time.
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              onClick={() => setSendGuard(null)}
              className="rounded-lg bg-brand-gradient px-3 py-1.5 text-[11px] font-bold text-white shadow-card transition hover:opacity-95"
            >
              Wait for business hours
            </button>
            <button
              onClick={doSend}
              disabled={gmailBusy}
              className="rounded-lg border border-amber-400/60 bg-surface px-3 py-1.5 text-[11px] font-semibold text-amber-900 transition hover:bg-amber-100 disabled:opacity-50"
            >
              Send anyway
            </button>
          </div>
        </div>
      )}

      {/* Deny reason on passed finds — editable */}
      {denied && (
        <div className="mt-2.5 border-t border-warm-border pt-2.5">
          <div className="mb-1.5 text-[11px] font-semibold text-body/60">
            {find.denyReason
              ? "Reason you passed"
              : "Add a reason (optional, but it helps Scout learn faster)"}
          </div>
          <DenyReasons current={find.denyReason} onPick={(r) => onSetReason(r)} />
        </div>
      )}
    </div>
  );
}

/* ---------------- Preference / deny-rate analytics from real finds ---------------- */
function learnedFromFinds(finds: Find[]) {
  const decided = finds.filter((f) => f.status !== "new");
  const denied = decided.filter((f) => f.status === "denied");
  const kept = decided.filter(
    (f) => f.status === "drafted" || f.status === "sent" || f.status === "replied"
  );
  const denyRate = decided.length ? denied.length / decided.length : 0;
  // Reply rate over messages known to have gone out (sent or replied) — the
  // replies logged/tracked, not a claim about untracked sends.
  const sentish = finds.filter((f) => f.status === "sent" || f.status === "replied");
  const repliedCount = finds.filter((f) => f.status === "replied").length;
  const replyRate = sentish.length ? repliedCount / sentish.length : null;

  // Real trend: split the decisions you've made in half by time and compare the
  // deny rate of the earlier half vs the recent half. Only shown with enough data.
  let trend: { early: number; recent: number; delta: number } | null = null;
  if (decided.length >= 6) {
    const sorted = decided.slice().sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
    const mid = Math.floor(sorted.length / 2);
    const older = sorted.slice(0, mid);
    const newer = sorted.slice(mid);
    const rate = (arr: Find[]) =>
      arr.length ? arr.filter((f) => f.status === "denied").length / arr.length : 0;
    const early = rate(older);
    const recent = rate(newer);
    trend = { early, recent, delta: recent - early };
  }

  const tally = (arr: Find[]) => {
    const m: Record<string, number> = {};
    for (const f of arr) {
      const c = f.opp.channel || "Unknown";
      m[c] = (m[c] || 0) + 1;
    }
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  };
  // Chip-worthy summaries about the OPPORTUNITY itself (not the outreach
  // medium): what industries/companies + roles get accepted vs passed.
  const tallyOf = (arr: Find[], get: (f: Find) => string) => {
    const m: Record<string, number> = {};
    for (const f of arr) {
      const v = get(f).trim();
      if (!v) continue;
      m[v] = (m[v] || 0) + 1;
    }
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  };
  // Bucket similar deny reasons into a shared concept so "wrong location",
  // "not in my city", and "too far" collapse into a single Location tally.
  // Anything the buckets don't catch falls through as its own literal reason.
  const CONCEPT_BUCKETS: { label: string; test: RegExp }[] = [
    { label: "Wrong location", test: /\b(location|city|region|country|state|area|place|based|distant|near|far|remote|abroad|foreign|domestic)\b/i },
    { label: "Wrong industry", test: /\b(industry|field|sector|niche|category|market|space|vertical)\b/i },
    { label: "Wrong role or level", test: /\b(role|level|junior|senior|entry|position|title|seniority|too small|too big|too senior|too junior|wrong seniority)\b/i },
    { label: "Wrong timing", test: /\b(time|timing|deadline|closed|expired|past|future|old|stale|next year|next semester|fall|spring|summer|winter)\b/i },
    { label: "No way to contact", test: /\b(contact|reach|email|way|closed|no email|no phone|dm only|form only)\b/i },
    { label: "Genre / topic mismatch", test: /\b(country music|rock|pop|jazz|genre|topic|category|subject)\b/i },
    { label: "Already reached out", test: /\balready\b|\bcontacted\b|\bknow them\b/i },
  ];
  const bucketReason = (r: string): string => {
    for (const b of CONCEPT_BUCKETS) if (b.test.test(r)) return b.label;
    return r;
  };
  const deniedReasons = (() => {
    const m: Record<string, number> = {};
    for (const f of denied) {
      const raw = (f.denyReason || "").trim();
      if (!raw) continue;
      const key = bucketReason(raw);
      m[key] = (m[key] || 0) + 1;
    }
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  })();
  const deniedOutlets = tallyOf(denied, (f) => f.opp.outlet || "");
  const deniedRoles = tallyOf(denied, (f) => f.opp.contactRole || "");
  const keptOutlets = tallyOf(kept, (f) => f.opp.outlet || "");
  const keptRoles = tallyOf(kept, (f) => f.opp.contactRole || "");
  const avgFit = (arr: Find[]) => {
    const fs = arr
      .map((f) => f.opp.fitScore)
      .filter((v): v is number => typeof v === "number");
    return fs.length ? fs.reduce((a, b) => a + b, 0) / fs.length : null;
  };

  return {
    decided: decided.length,
    denied: denied.length,
    kept: kept.length,
    denyRate,
    trend,
    keptChannels: tally(kept),
    deniedChannels: tally(denied),
    keptOutlets,
    keptRoles,
    deniedOutlets,
    deniedRoles,
    deniedReasonsTally: deniedReasons,
    keptFit: avgFit(kept),
    deniedFit: avgFit(denied),
    replyRate,
    repliedCount,
    sentCount: sentish.length,
    denyReasons: (() => {
      const m: Record<string, number> = {};
      for (const f of denied) {
        const r = (f.denyReason || "").trim();
        if (r) m[r] = (m[r] || 0) + 1;
      }
      return Object.entries(m).sort((a, b) => b[1] - a[1]);
    })(),
  };
}

// Concrete, honestly-derived things Scout has learned about THIS user recently,
// each only shown when the real data supports it. Individual + private.
// Concrete signals about HOW the user writes their drafts — opener style,
// sign-off, sentence length, formality — surfaced under "What Scout has
// learned about you" so the section shows specific patterns rather than
// generic claims.
function learnedFromDrafts(finds: Find[]) {
  const bodies = finds
    .map((f) => (f.draft?.body || "").trim())
    .filter((b) => b.length > 20);
  if (!bodies.length) {
    return {
      count: 0,
      opener: null as string | null,
      signOff: null as string | null,
      avgWords: null as number | null,
      contractionRate: null as number | null,
      exclaims: null as number | null,
    };
  }
  const tally = (arr: string[]) => {
    const m: Record<string, number> = {};
    for (const s of arr) {
      const k = s.trim().toLowerCase();
      if (!k) continue;
      m[k] = (m[k] || 0) + 1;
    }
    const top = Object.entries(m).sort((a, b) => b[1] - a[1])[0];
    return top ? top[0] : null;
  };
  const openers: string[] = [];
  const signOffs: string[] = [];
  let words = 0;
  let contractionHits = 0;
  let exclaimHits = 0;
  for (const body of bodies) {
    const clean = body.replace(/\r/g, "");
    // Opener: the first word after any name (Hi/Hey/Hello/Dear) or the
    // first token if the message dives straight in.
    const firstLine = clean.split(/\n+/)[0] || "";
    const openerMatch = firstLine.match(/^(hi|hey|hello|dear|good\s+(morning|afternoon)|greetings|to whom)/i);
    if (openerMatch) openers.push(openerMatch[0]);
    // Sign-off: last non-empty line, taking just the word before the comma or newline.
    const lines = clean.split(/\n+/).map((l) => l.trim()).filter(Boolean);
    const last = lines[lines.length - 1] || "";
    const signMatch = last.match(/^(thanks|thank you|best|cheers|regards|kind regards|warmly|sincerely|talk soon|all the best)/i);
    if (signMatch) signOffs.push(signMatch[0]);
    // Word count for length signal.
    words += clean.split(/\s+/).filter(Boolean).length;
    // Contractions: rough heuristic (I'll, don't, won't, I'm, can't, etc.)
    if (/\b(i'll|don't|won't|i'm|can't|it's|you're|we're|they're|didn't|isn't|aren't|haven't|wouldn't|couldn't|shouldn't)\b/i.test(clean))
      contractionHits++;
    if (/!/.test(clean)) exclaimHits++;
  }
  return {
    count: bodies.length,
    opener: tally(openers),
    signOff: tally(signOffs),
    avgWords: Math.round(words / bodies.length),
    contractionRate: contractionHits / bodies.length,
    exclaims: exclaimHits / bodies.length,
  };
}

function recentInsights(
  learned: ReturnType<typeof learnedFromFinds>,
  writing: ReturnType<typeof learnedFromDrafts>,
  coaching: string[],
  editPairs: { before: string; after: string }[]
): { text: string; basis: string }[] {
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const out: { text: string; basis: string }[] = [];

  // Channel preference: what you act on vs pass on.
  const topKept = learned.keptChannels[0]?.[0];
  const topDenied = learned.deniedChannels[0]?.[0];
  if (topKept && learned.kept >= 3) {
    out.push({
      text:
        topDenied && topDenied !== topKept
          ? `You reach out to ${topKept} contacts and tend to pass on ${topDenied} ones.`
          : `You reach out most through ${topKept}.`,
      basis: `${learned.kept} you kept`,
    });
  }

  // Fit sweet spot.
  if (learned.keptFit != null && learned.deniedFit != null && learned.keptFit > learned.deniedFit) {
    out.push({
      text: `Your sweet spot is around ${pct(learned.keptFit)} fit; you pass on ones near ${pct(learned.deniedFit)}.`,
      basis: `${learned.decided} decisions`,
    });
  }

  // Improving trend (deny rate dropping over time).
  if (learned.trend && learned.trend.delta < -0.05) {
    out.push({
      text: `Your matches are landing more often lately: deny rate ${pct(learned.trend.early)} then ${pct(learned.trend.recent)}.`,
      basis: "earlier vs recent finds",
    });
  }

  // Top reason you pass.
  const topReason = learned.denyReasons[0];
  if (topReason && topReason[1] >= 2) {
    out.push({
      text: `Most often you pass because: ${topReason[0].toLowerCase()}. Scout steers away from those.`,
      basis: `${topReason[1]} times`,
    });
  }

  // Reply tracking.
  if (learned.replyRate != null && learned.sentCount >= 2) {
    out.push({
      text: `${learned.repliedCount} of ${learned.sentCount} tracked messages got a reply.`,
      basis: "Gmail reply tracking",
    });
  }

  // Voice learned from edits.
  if (editPairs.length > 0) {
    out.push({
      text: `Scout has learned your writing voice from ${editPairs.length} edit${editPairs.length === 1 ? "" : "s"} you made to drafts.`,
      basis: "your rewrites",
    });
  }

  // Concrete writing patterns from the drafts themselves.
  if (writing.count >= 3) {
    if (writing.opener) {
      out.push({
        text: `You almost always open with "${writing.opener[0].toUpperCase() + writing.opener.slice(1)}". Scout keeps that as your default.`,
        basis: `${writing.count} drafts`,
      });
    }
    if (writing.signOff) {
      out.push({
        text: `Your sign-off usually reads "${writing.signOff[0].toUpperCase() + writing.signOff.slice(1)}".`,
        basis: `${writing.count} drafts`,
      });
    }
    if (writing.avgWords != null) {
      const feel =
        writing.avgWords < 60
          ? "short and to the point"
          : writing.avgWords < 120
            ? "medium length, a few short paragraphs"
            : "on the longer, more detailed side";
      out.push({
        text: `Your messages average ${writing.avgWords} words — ${feel}.`,
        basis: `${writing.count} drafts`,
      });
    }
    if (writing.contractionRate != null && writing.contractionRate >= 0.6) {
      out.push({
        text: "You write informally — contractions like \"don't\" and \"I'll\" show up in most drafts. Scout matches that register.",
        basis: `${writing.count} drafts`,
      });
    } else if (writing.contractionRate != null && writing.contractionRate <= 0.2 && writing.count >= 4) {
      out.push({
        text: "You lean formal — contractions rarely appear. Scout keeps drafts professional and full-form.",
        basis: `${writing.count} drafts`,
      });
    }
  }

  // Coaching turned into standing rules.
  if (coaching.length > 0) {
    out.push({
      text: `${coaching.length} coaching rule${coaching.length === 1 ? "" : "s"} you approved now shape${coaching.length === 1 ? "s" : ""} every draft.`,
      basis: "your dashboard",
    });
  }

  return out;
}

/* ---------------- Dashboard tab ---------------- */
// Status vocabulary for the recent-finds table: label, chip styling, next action.
const FIND_STATUS: Record<
  FindStatus,
  { label: string; cls: string; action: string }
> = {
  new: { label: "New", cls: "bg-brown-tint text-brown-deep", action: "Draft" },
  drafted: { label: "Drafted", cls: "bg-warm-bg text-body", action: "Send" },
  sent: { label: "Sent", cls: "bg-warm-bg text-body", action: "Follow up" },
  replied: { label: "Replied", cls: "bg-success/10 text-success-deep", action: "View" },
  denied: { label: "Passed", cls: "bg-warm-bg text-muted", action: "View" },
};

function DashboardTab({
  activity,
  profile,
  templates,
  projects,
  categoriesCount,
  finds,
  community,
  coaching,
  editPairs,
  onApplyTip,
  onRemoveTip,
  goOutreach,
  goTemplates,
  goProfile,
  goFinds,
  onEditProject,
  onSeedTemplateForChannel,
}: {
  activity: Activity;
  profile: Profile;
  templates: OutreachTemplate[];
  projects: Project[];
  categoriesCount: number;
  finds: Find[];
  community: CommunityStats | null;
  coaching: string[];
  editPairs: { before: string; after: string }[];
  onApplyTip: (tip: string) => void;
  onRemoveTip: (tip: string) => void;
  goOutreach: () => void;
  goTemplates: () => void;
  goProfile: () => void;
  goFinds: () => void;
  onEditProject: (id: string) => void;
  onSeedTemplateForChannel: (channel: string) => void;
}) {
  // Two-tab split: personal signal in "You", aggregate/community in "Scout-wide".
  const [dashTab, setDashTab] = useState<"you" | "scout">("you");
  const learned = learnedFromFinds(finds);
  const writing = learnedFromDrafts(finds);
  const insights = recentInsights(learned, writing, coaching, editPairs);
  // Contacts you reached out to about a week ago that still haven't replied — a
  // gentle nudge roughly doubles response rates, so surface them here.
  const dueFollowUps = finds.filter(
    (f) =>
      f.status === "sent" &&
      f.sentAt &&
      Date.now() - f.sentAt >= 7 * 86400000 &&
      !f.lastFollowUpAt
  ).length;
  const pipe = {
    new: finds.filter((f) => f.status === "new").length,
    drafted: finds.filter((f) => f.status === "drafted").length,
    sent: finds.filter((f) => f.status === "sent").length,
    replied: finds.filter((f) => f.status === "replied").length,
    denied: finds.filter((f) => f.status === "denied").length,
  };
  // Real weekly series for the activity chart: people found vs messages sent,
  // bucketed from each find's own timestamps. No fabricated data.
  const WEEKS = 10;
  const wkNow = Date.now();
  const WK = 7 * 86400000;
  const weekly = Array.from({ length: WEEKS }, (_, i) => {
    const end = wkNow - (WEEKS - 1 - i) * WK;
    const start = end - WK;
    const inWeek = (t?: number) => typeof t === "number" && t > start && t <= end;
    return {
      label: "",
      added: finds.filter((f) => inWeek(f.addedAt)).length,
      sent: finds.filter((f) => inWeek(f.sentAt)).length,
    };
  });
  const hasActivity = weekly.some((w) => w.added > 0 || w.sent > 0);
  const onTarget = learned.decided ? Math.round((1 - learned.denyRate) * 100) : null;
  const pipeTotal = pipe.new + pipe.drafted + pipe.sent + pipe.replied;
  const recentFinds = finds
    .slice()
    .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
    .slice(0, 6);

  // Personal greeting: time of day + the user's first name, then an honest,
  // specific status line about this week's finds (only shown when there's news).
  const hour = new Date().getHours();
  const partOfDay = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
  const firstName = (profile.name || "").trim().split(/\s+/)[0] || "";
  const newThisWeek = finds.filter((f) => f.addedAt && wkNow - f.addedAt <= WK).length;
  const strongThisWeek = finds.filter(
    (f) => f.addedAt && wkNow - f.addedAt <= WK && (f.opp.fitScore || 0) >= 0.8
  ).length;

  // Scout's pick: the strongest still-actionable find (not yet sent/passed), used
  // for the dark spotlight card. whyItFits is Scout's real reason to reach out.
  const pick = finds
    .filter(
      (f) =>
        (f.status === "new" || f.status === "drafted") &&
        typeof f.opp.fitScore === "number"
    )
    .sort((a, b) => (b.opp.fitScore || 0) - (a.opp.fitScore || 0))[0];
  const initials = (s: string) =>
    (s || "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() || "")
      .join("") || "?";

  // Honest per-tile trend series: only People found and Taken to send have real
  // per-week timestamps, so only those carry a sparkline. Searches and Drafts
  // have no timeline, so they stay as plain figures rather than a fabricated one.
  const foundSeries = weekly.map((w) => w.added);
  const sentSeries = weekly.map((w) => w.sent);
  const withMovement = (s: number[]) => (s.some((v) => v > 0) ? s : undefined);
  const metrics: {
    label: string;
    value: number;
    series?: number[];
    delta?: number;
  }[] = [
    { label: "Searches", value: activity.searches },
    { label: "People found", value: activity.found, series: withMovement(foundSeries), delta: weekly[WEEKS - 1].added },
    { label: "Drafts written", value: activity.drafts },
    { label: "Taken to send", value: activity.copies, series: withMovement(sentSeries), delta: weekly[WEEKS - 1].sent },
  ];

  const channels = new Set(templates.map((t) => t.channel)).size;
  const projectsWithContext = projects.filter((p) => (p.context || "").trim()).length;
  // Honest, clearly-labeled estimate: ~6 min to find + write one personal message.
  const minutesSaved = activity.drafts * 6;
  const timeSaved =
    minutesSaved >= 60
      ? `${(minutesSaved / 60).toFixed(1)} hrs`
      : `${minutesSaved} min`;

  // Rhythm stats — how much you've done in the last 7 and 30 days. Uses the
  // find's addedAt (when Scout surfaced it) for drafts, sentAt for sends.
  const WEEK = 7 * 86400000;
  const MONTH = 30 * 86400000;
  const now = Date.now();
  const draftsThisWeek = finds.filter(
    (f) =>
      (f.status === "drafted" || f.status === "sent" || f.status === "replied") &&
      now - (f.addedAt || 0) < WEEK
  ).length;
  const sentThisWeek = finds.filter(
    (f) => f.sentAt && now - f.sentAt < WEEK
  ).length;
  const activeDays = (() => {
    const days = new Set<string>();
    for (const f of finds) {
      const t = f.sentAt || f.addedAt;
      if (!t || now - t > MONTH) continue;
      days.add(new Date(t).toISOString().slice(0, 10));
    }
    return days.size;
  })();

  // What Scout uses to personalize FOR YOU — each item is a real signal or a
  // concrete way to make your outreach sharper.
  const signals = [
    {
      done: !!profile.bio.trim(),
      label: "Your resume / bio is on file",
      hint: "Scout draws on your real background so messages sound like you.",
      cta: profile.bio.trim() ? null : { label: "Add it in Profile", go: goProfile },
    },
    {
      done: !!(profile.linkedin || "").trim(),
      label: "LinkedIn connected",
      hint: "Adds context about who you are to every message.",
      cta: (profile.linkedin || "").trim()
        ? null
        : { label: "Add your LinkedIn", go: goProfile },
    },
    {
      done: templates.length > 0,
      label:
        templates.length > 0
          ? `${templates.length} voice ${templates.length === 1 ? "template" : "templates"} across ${channels} ${channels === 1 ? "channel" : "channels"}`
          : "Teach Scout your writing voice",
      hint: "Scout matches the tone and format of your own emails and DMs.",
      cta:
        channels >= 3
          ? null
          : { label: "Add a template", go: goTemplates },
    },
    {
      done: projectsWithContext > 0,
      label:
        projectsWithContext > 0
          ? `${projectsWithContext} ${projectsWithContext === 1 ? "project has" : "projects have"} context set`
          : "Add context to your projects",
      hint: "Tell Scout who each project is for, so pitches are about the right person.",
      cta:
        projectsWithContext === projects.length
          ? null
          : { label: "Add context", go: goOutreach },
    },
    {
      done: activity.searches > 0,
      label:
        activity.searches > 0
          ? "Scout is learning from your searches"
          : "Run your first search",
      hint: "Every search and every person you keep teaches Scout what a good match looks like for you.",
      cta: activity.searches > 0 ? null : { label: "Start scouting", go: goOutreach },
    },
  ];

  return (
    <main className="mx-auto w-full max-w-5xl px-8 py-10">
      {/* -------- Header: greeting + tab switcher -------- */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">
            {dashTab === "you"
              ? firstName
                ? `Good ${partOfDay}, ${firstName}`
                : `Good ${partOfDay}`
              : "Scout-wide"}
          </h1>
          <p className="mt-1 text-sm text-body">
            {dashTab === "you"
              ? newThisWeek > 0
                ? `${newThisWeek} new ${newThisWeek === 1 ? "find" : "finds"} this week.${
                    strongThisWeek > 0
                      ? ` ${strongThisWeek} ${strongThisWeek === 1 ? "looks" : "look"} strong.`
                      : ""
                  }`
                : "Where your outreach stands."
              : "How Scout is doing across everyone using it."}
          </p>
        </div>
        <div className="inline-flex shrink-0 rounded-xl border border-warm-border bg-surface p-1 shadow-card">
          {(
            [
              ["you", "You"],
              ["scout", "Scout-wide"],
            ] as const
          ).map(([val, label]) => (
            <button
              key={val}
              onClick={() => setDashTab(val)}
              className={`rounded-lg px-4 py-1.5 text-sm font-bold transition ${
                dashTab === val
                  ? "bg-brown text-white shadow-soft"
                  : "text-body/70 hover:text-ink"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {dashTab === "you" && (
      <>
      {/* -------- Follow-up reminder -------- */}
      {dueFollowUps > 0 && (
        <button
          onClick={goFinds}
          className="mt-5 flex w-full items-center gap-3 rounded-2xl border border-sage/50 bg-sage/10 p-4 text-left transition hover:bg-sage/15"
        >
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-sage/20 text-sage">
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0" /></svg>
          </span>
          <span className="flex-1">
            <span className="block text-sm font-bold text-ink">
              {dueFollowUps} {dueFollowUps === 1 ? "contact is" : "contacts are"} due
              for a follow-up
            </span>
            <span className="block text-xs text-body/80">
              You reached out about a week ago with no reply yet. A short nudge helps.
            </span>
          </span>
          <span className="shrink-0 text-xs font-bold text-sage">Review →</span>
        </button>
      )}

      {/* -------- Overview: activity chart + match quality + pipeline -------- */}
      <section className="mt-6 grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <div className="rounded-xl border border-warm-border bg-surface p-5 shadow-card">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold text-ink">Outreach activity</h2>
              <p className="mt-0.5 text-xs text-muted">People found and messages sent, by week.</p>
            </div>
            <div className="text-right">
              <div className="text-2xl font-semibold leading-none tabular-nums text-ink">{pipe.sent}</div>
              <div className="mt-1 text-xs text-muted">sent total</div>
            </div>
          </div>
          {hasActivity ? (
            <div className="mt-4">
              <ActivityChart data={weekly} />
            </div>
          ) : (
            <div className="mt-4 flex h-[168px] flex-col items-center justify-center rounded-lg bg-warm-bg/60 px-4 text-center">
              <p className="max-w-[16rem] text-sm text-muted">
                Your activity shows up here once you start finding and messaging people.
              </p>
              <button
                onClick={goOutreach}
                className="mt-3 rounded-lg bg-brown px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-brown-deep"
              >
                Run a search
              </button>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-5 rounded-xl border border-warm-border bg-surface p-5 shadow-card">
          <div>
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-ink">Match quality</h2>
              {onTarget != null && learned.trend && Math.abs(learned.trend.delta) >= 0.01 && (
                <span
                  className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${
                    learned.trend.delta < 0
                      ? "bg-success/10 text-success-deep"
                      : "bg-attention/10 text-attention"
                  }`}
                >
                  {learned.trend.delta < 0 ? "▲" : "▼"}{" "}
                  {Math.abs(Math.round(learned.trend.delta * 100))} pts
                </span>
              )}
            </div>
            {onTarget == null ? (
              <p className="mt-2 text-xs leading-relaxed text-muted">
                Draft or pass on a few finds and Scout starts showing how well it
                reads your taste.
              </p>
            ) : (
              <>
                <div className="mt-3 flex justify-center">
                  <MatchGauge pct={onTarget} />
                </div>
                <p className="mt-2 text-center text-xs leading-relaxed text-muted">
                  {learned.trend && learned.trend.delta < -0.01
                    ? "Sharper than when you started — fewer of Scout's finds are misses."
                    : learned.trend && learned.trend.delta > 0.01
                    ? "Landing less often lately. Tightening your goal or project context helps."
                    : `${learned.kept} of ${learned.decided} finds kept so far.`}
                </p>
              </>
            )}
          </div>
          <div className="border-t border-warm-border pt-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-ink">Pipeline</h2>
              <span className="text-xs text-muted">{pipeTotal} in play</span>
            </div>
            <div className="mt-3.5">
              <PipelineBar
                segments={[
                  { label: "New", value: pipe.new, color: "bg-clay", text: "text-body" },
                  { label: "Drafted", value: pipe.drafted, color: "bg-brown", text: "text-body" },
                  { label: "Sent", value: pipe.sent, color: "bg-brown-deep", text: "text-body" },
                  { label: "Replied", value: pipe.replied, color: "bg-success", text: "text-body" },
                ]}
              />
            </div>
          </div>
        </div>
      </section>

      {/* -------- Scout's pick (dark spotlight) -------- */}
      {pick && (
        <section className="relative mt-4 flex flex-wrap items-center gap-5 overflow-hidden rounded-2xl bg-coffee p-6 shadow-soft">
          <span
            className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full"
            style={{ background: "radial-gradient(circle, rgba(200,184,153,.16), transparent 70%)" }}
            aria-hidden
          />
          <span className="z-[1] grid h-14 w-14 shrink-0 place-items-center rounded-full border-2 border-white/15 bg-gradient-to-br from-[#e8dcc4] to-clay text-lg font-bold text-coffee">
            {initials(pick.opp.name)}
          </span>
          <div className="z-[1] min-w-0 flex-1">
            <div className="flex items-center gap-2 text-[10.5px] font-bold uppercase tracking-[0.13em] text-clay">
              <img
                src="/scout-logo.png"
                alt=""
                width={15}
                height={15}
                className="h-[15px] w-[15px]"
                style={{ filter: "brightness(0) invert(0.82) sepia(0.3)" }}
              />
              Scout&rsquo;s pick
            </div>
            <h3 className="mt-1.5 truncate text-[17px] font-semibold tracking-tight text-white">
              {pick.opp.name}
            </h3>
            <p className="mt-1 max-w-[52ch] text-sm leading-relaxed text-[#c9c0b4]">
              {(pick.opp.whyItFits || "").trim() ||
                "Your strongest still-open match — worth a short, specific intro."}
            </p>
          </div>
          <div className="z-[1] flex shrink-0 items-center gap-5">
            {typeof pick.opp.fitScore === "number" && (
              <div className="text-xs text-[#a89f92]">
                Fit{" "}
                <b className="text-[15px] font-bold text-white tabular-nums">
                  {Math.round(pick.opp.fitScore * 100)}%
                </b>
              </div>
            )}
            <button
              onClick={goFinds}
              className="whitespace-nowrap rounded-lg bg-[#f3ede2] px-4 py-2.5 text-sm font-semibold text-[#3a2a1a] transition hover:bg-surface"
            >
              Draft an intro &rarr;
            </button>
          </div>
        </section>
      )}

      {/* -------- Activity metrics (tiles; sparkline only where the data is real) -------- */}
      <section className="mt-4 grid grid-cols-2 gap-3.5 sm:grid-cols-4">
        {metrics.map((m) => (
          <div
            key={m.label}
            className="rounded-2xl border border-warm-border bg-surface p-4 shadow-card"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="text-xl font-semibold leading-none tabular-nums text-ink">
                {m.value}
              </div>
              {m.series && <Sparkline data={m.series} />}
            </div>
            <div className="mt-1.5 text-xs text-muted">{m.label}</div>
            {typeof m.delta === "number" && m.delta > 0 && (
              <div className="mt-2 text-[11px] font-semibold text-success-deep">
                +{m.delta} this week
              </div>
            )}
          </div>
        ))}
      </section>

      {/* -------- Recent finds -------- */}
      <section className="mt-8">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold tracking-tight text-ink">Recent finds</h2>
          <button
            onClick={goFinds}
            className="text-sm font-medium text-brown transition hover:text-brown-deep"
          >
            View all &rarr;
          </button>
        </div>
        {recentFinds.length ? (
          <div className="mt-3 overflow-x-auto rounded-xl border border-warm-border bg-surface shadow-card">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="text-left text-xs text-muted">
                  <th className="px-4 py-2.5 font-medium">Name</th>
                  <th className="hidden px-4 py-2.5 font-medium sm:table-cell">Source</th>
                  <th className="px-4 py-2.5 font-medium">Fit</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {recentFinds.map((f) => {
                  const st = FIND_STATUS[f.status];
                  const fit =
                    typeof f.opp.fitScore === "number"
                      ? Math.round(f.opp.fitScore * 100)
                      : null;
                  const palette = ["#7c5837", "#8c9a76", "#a9761f", "#5d4026", "#3f7a52", "#b0553f"];
                  const hash = (f.opp.name || "").split("").reduce((s, c) => s + c.charCodeAt(0), 0);
                  const avatar = palette[hash % palette.length];
                  const dot =
                    f.status === "replied"
                      ? "bg-success"
                      : f.status === "new"
                      ? "bg-brown"
                      : "bg-muted";
                  return (
                    <tr key={f.id} className="border-t border-warm-border transition hover:bg-warm-bg/50">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <span
                            className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-xs font-semibold text-white"
                            style={{ backgroundColor: avatar }}
                            aria-hidden
                          >
                            {initials(f.opp.name)}
                          </span>
                          <span className="min-w-0">
                            <span className="block max-w-[18rem] truncate font-medium text-ink">
                              {f.opp.name}
                            </span>
                            {f.opp.outlet && (
                              <span className="block max-w-[18rem] truncate text-xs text-muted">
                                {f.opp.outlet}
                              </span>
                            )}
                          </span>
                        </div>
                      </td>
                      <td className="hidden px-4 py-3 text-muted sm:table-cell">
                        {f.opp.channel || "—"}
                      </td>
                      <td className="px-4 py-3">
                        {fit != null ? (
                          <div className="flex items-center gap-2.5">
                            <span className="tabular-nums text-body">{fit}%</span>
                            <span className="h-1.5 w-[52px] overflow-hidden rounded-full bg-warm-bg">
                              <span
                                className="block h-full rounded-full bg-brown"
                                style={{ width: `${fit}%` }}
                              />
                            </span>
                          </div>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${st.cls}`}>
                          <span className={`h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden />
                          {st.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={goFinds}
                          className="text-sm font-medium text-brown transition hover:text-brown-deep"
                        >
                          {st.action}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="mt-3 flex flex-col items-center justify-center rounded-xl border border-dashed border-warm-border bg-surface px-6 py-12 text-center">
            <p className="max-w-sm text-sm text-muted">
              No finds yet. Run a search and Scout starts filling your pipeline with
              people worth reaching.
            </p>
            <button
              onClick={goOutreach}
              className="mt-4 rounded-lg bg-brown px-4 py-2 text-sm font-semibold text-white transition hover:bg-brown-deep"
            >
              Start scouting
            </button>
          </div>
        )}
      </section>

      {/* -------- Fit + preferences (only once there's data to show) -------- */}
      {learned.decided > 0 && (
        <section className="mt-10">
          <h2 className="text-lg font-semibold tracking-tight text-ink">Your fit and preferences</h2>
          <p className="mt-1 text-sm text-body/80">
            The fit level and channels you gravitate toward, learned from the finds
            you keep and pass on.
          </p>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {/* Reply rate (from tracked Gmail threads + manually logged replies) */}
            {learned.replyRate != null && (
              <div className="rounded-2xl border border-warm-border bg-surface p-5 shadow-card sm:col-span-2">
                <div className="text-xs font-bold uppercase tracking-wider text-body/60">
                  Your reply rate
                </div>
                <div className="mt-1 flex items-end gap-2">
                  <span className="text-3xl font-extrabold tracking-tight text-ink">
                    {Math.round(learned.replyRate * 100)}%
                  </span>
                  <span className="mb-1 text-xs text-body/60">
                    {learned.repliedCount} of {learned.sentCount} sent
                  </span>
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-body/70">
                  Replies Scout has tracked through Gmail or you&apos;ve logged by
                  setting a find to Replied. Untracked sends aren&apos;t counted
                  against you.
                </p>
              </div>
            )}

            {/* Preferences */}
            <div className="rounded-2xl border border-warm-border bg-surface p-5 shadow-card sm:col-span-2">
              <div className="text-xs font-bold uppercase tracking-wider text-body/60">
                Your preferences so far
              </div>
              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                <div>
                  <div className="text-xs font-semibold text-sage">You reach out to</div>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {(learned.keptOutlets.length
                      ? learned.keptOutlets
                      : learned.keptRoles
                    ).length ? (
                      (learned.keptOutlets.length ? learned.keptOutlets : learned.keptRoles)
                        .slice(0, 4)
                        .map(([c, n]) => (
                          <span
                            key={c}
                            className="rounded-full border border-warm-border bg-warm-bg px-2.5 py-1 text-xs font-medium text-ink"
                          >
                            {c} · {n}
                          </span>
                        ))
                    ) : (
                      <span className="text-xs text-body/50">nothing yet</span>
                    )}
                  </div>
                </div>
                <div>
                  <div className="text-xs font-semibold text-body/60">You tend to pass on</div>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {(() => {
                      // Show the opportunity itself, not the outreach medium:
                      // prefer explicit deny reasons; otherwise fall back to
                      // companies (outlet), then roles.
                      const source = learned.deniedReasonsTally.length
                        ? learned.deniedReasonsTally
                        : learned.deniedOutlets.length
                          ? learned.deniedOutlets
                          : learned.deniedRoles;
                      return source.length ? (
                        source.slice(0, 4).map(([c, n]) => (
                          <span
                            key={c}
                            className="rounded-full border border-warm-border bg-surface px-2.5 py-1 text-xs font-medium text-body/70"
                          >
                            {c} · {n}
                          </span>
                        ))
                      ) : (
                        <span className="text-xs text-body/50">nothing yet</span>
                      );
                    })()}
                  </div>
                </div>
              </div>
              {learned.denyReasons.length > 0 && (
                <div className="mt-3 border-t border-warm-border pt-3">
                  <div className="text-xs font-semibold text-body/60">Why you pass</div>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {learned.denyReasons.slice(0, 6).map(([r, n]) => (
                      <span
                        key={r}
                        className="rounded-full border border-warm-border bg-surface px-2.5 py-1 text-xs font-medium text-body/70"
                      >
                        {r} · {n}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              <p className="mt-3 text-xs text-body/60">
                Scout uses these patterns to rank future finds toward the kind you
                actually act on.
              </p>
            </div>
          </div>
        </section>
      )}

      {/* -------- Your projects -------- */}
      <section className="mt-10">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold tracking-tight text-ink">Your projects</h2>
          <button
            onClick={goOutreach}
            className="text-xs font-bold text-accent transition hover:underline"
          >
            Go to Outreach →
          </button>
        </div>
        <Reveal className="mt-4 grid gap-3 sm:grid-cols-2">
          {projects.length === 0 ? (
            <p className="text-sm text-muted">No projects yet.</p>
          ) : (
            projects.slice(0, 6).map((p) => {
              const mine = finds.filter((f) => f.projectId === p.id);
              const nw = mine.filter((f) => f.status === "new").length;
              const sent = mine.filter((f) => f.status === "sent").length;
              // Prefer the per-project context the user typed ("Anna Belt is a
              // Nashville folk-rock artist…") over the shared profile use
              // case, which is the same for every project and reads generic.
              const description = (p.context || "").trim() || p.useCase;
              return (
                <button
                  key={p.id}
                  onClick={() => onEditProject(p.id)}
                  title="Open in Outreach and edit"
                  className="idx-flap relative flex items-start gap-3 rounded-xl border border-warm-border bg-surface p-4 paper-card text-left transition hover:border-brown/40 hover:bg-warm-bg/60"
                >
                  <span className="mt-0.5 h-10 w-10 shrink-0 rounded-xl bg-brown" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-bold text-ink">{p.name}</div>
                    <p className="mt-0.5 line-clamp-2 text-xs leading-snug text-muted">
                      {description}
                    </p>
                    <div className="mt-1 text-[11px] font-semibold text-body/60 tabular-nums">
                      {nw} new · {sent} sent
                    </div>
                  </div>
                  <span aria-hidden className="mt-0.5 text-body/40">
                    <PencilIcon />
                  </span>
                </button>
              );
            })
          )}
        </Reveal>
      </section>

      {/* -------- You vs the community (real aggregate averages) -------- */}
      <section className="mt-10">
        <h2 className="text-lg font-semibold tracking-tight text-ink">You vs the community</h2>
        <p className="mt-1 text-sm text-body/80">
          How you compare to everyone else using Scout. Aggregate averages only,
          never anyone&apos;s private data.
        </p>
        {!community || community.users < 1 ? (
          <div className="mt-4 rounded-2xl border border-dashed border-warm-border bg-surface/60 p-8 text-center text-sm text-body/70">
            Community benchmarks appear here as more people use Scout. Yours are
            ready, everyone else&apos;s are still coming.
          </div>
        ) : (
          <>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <CompareRow
                label="Deny rate"
                you={learned.decided ? learned.denyRate : null}
                them={community.avgDenyRate}
                fmt="pct"
                lowerBetter
              />
              <CompareRow
                label="Finds saved"
                you={finds.length}
                them={community.avgFinds}
                fmt="num"
              />
              <CompareRow
                label="Messages drafted"
                you={activity.drafts}
                them={community.avgDrafts}
                fmt="num"
              />
            </div>
            <p className="mt-3 text-xs text-body/60">
              Based on {community.users} other{" "}
              {community.users === 1 ? "person" : "people"} using Scout with a
              similar use case to yours. Teammates who picked a different use case
              are compared against a different cohort, so their numbers will
              differ from yours.
            </p>
          </>
        )}
      </section>

      {/* -------- What Scout has learned about YOU lately (individual) -------- */}
      <section className="mt-10">
        <h2 className="text-lg font-semibold tracking-tight text-ink">What Scout has learned about you</h2>
        <p className="mt-1 text-sm text-body/80">
          Recent, private-to-you signals Scout picks up as you work. These steer who it
          finds and how it drafts.
        </p>
        {insights.length ? (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {insights.map((ins) => (
              <div
                key={ins.text}
                className="flex items-start gap-3 rounded-2xl border border-warm-border bg-surface p-4 shadow-card"
              >
                <span
                  className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-sage/15 text-sage"
                  aria-hidden
                >
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v18M3 12h18M6 6l12 12M18 6 6 18" /></svg>
                </span>
                <div>
                  <p className="text-sm leading-relaxed text-ink">{ins.text}</p>
                  <p className="mt-1 text-[10px] font-semibold uppercase tracking-wide text-body/50">
                    {ins.basis}
                  </p>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-3 rounded-2xl border border-dashed border-warm-border bg-surface/60 px-4 py-3 text-sm text-body/70">
            Nothing learned yet. As you keep, pass on, and edit finds, real insights about
            your taste and voice show up here.{" "}
            <button onClick={goFinds} className="font-semibold text-accent hover:underline">
              Work a few finds
            </button>{" "}
            to get started.
          </p>
        )}
      </section>

      </>
      )}

      {dashTab === "scout" && (
      <>
      {/* -------- Getting sharper across Scout (public, everyone) -------- */}
      {community && (community.patterns?.decidedFinds || 0) > 0 && (
        <section className="mt-8 rounded-3xl border border-warm-border bg-surface p-6 shadow-card">
          <h2 className="text-lg font-semibold tracking-tight text-ink">Getting sharper across Scout</h2>
          <p className="mt-1 text-sm text-body/80">
            Scout learns from everyone&apos;s decisions (anonymously, in aggregate). The
            more the community decides, the better it matches for all of you.
          </p>
          <div className="mt-4 flex flex-wrap gap-8">
            <div>
              <div className="text-2xl font-extrabold text-ink">
                {(community.patterns?.decidedFinds || 0).toLocaleString()}
              </div>
              <div className="text-xs text-body/70">community decisions learned from</div>
            </div>
            <div>
              <div className="text-2xl font-extrabold text-ink">
                {(community.users + 1).toLocaleString()}
              </div>
              <div className="text-xs text-body/70">
                {community.users + 1 === 1 ? "person" : "people"} using Scout
              </div>
            </div>
            {community.patterns?.channels?.[0] && (
              <div>
                <div className="text-2xl font-extrabold text-ink">
                  {Math.round(community.patterns.channels[0].keptRate * 100)}%
                </div>
                <div className="text-xs text-body/70">
                  of {community.patterns.channels[0].channel.toLowerCase()} finds get acted on
                </div>
              </div>
            )}
          </div>
          <p className="mt-3 text-xs text-body/50">
            Aggregate only, never anyone&apos;s individual data. Numbers grow and steady as
            the community does.
          </p>
        </section>
      )}

      {/* -------- People like you (cohort patterns) -------- */}
      {(() => {
        const c = community?.cohort;
        if (!c) return null;
        const pct = (v: number) => `${Math.round(v * 100)}%`;
        const top = c.patterns.channels?.[0];
        const fitK = c.patterns.fitKept;
        const fitD = c.patterns.fitDenied;
        const tips: string[] = [];
        if (top)
          tips.push(
            `They act on ${top.channel.toLowerCase()} contacts most (${pct(top.keptRate)} kept). Scout leans toward finding those for you.`
          );
        if (fitK != null && fitD != null && fitK > fitD)
          tips.push(
            `Their sweet spot is around ${pct(fitK)} fit; they pass on ones near ${pct(fitD)}.`
          );
        const ce = c.patterns.contextEffect;
        if (ce && ce.withContext != null && ce.withoutContext != null && ce.withContext < ce.withoutContext)
          tips.push(
            `They miss less when they add project context (${pct(ce.withContext)} deny vs ${pct(ce.withoutContext)} without).`
          );
        if (!tips.length) return null;
        return (
          <section className="mt-8 rounded-3xl border border-sage/40 bg-sage/10 p-6">
            <h2 className="text-lg font-semibold tracking-tight text-ink">People like you</h2>
            <p className="mt-1 text-sm text-body/80">
              Patterns from {c.users} other{" "}
              {c.users === 1 ? "person" : "people"} doing{" "}
              <span className="font-semibold">{c.useCase}</span>. Scout uses these to steer
              who it finds for you. Aggregate only, never anyone&apos;s individual data.
            </p>
            <ul className="mt-3 space-y-2">
              {tips.map((t) => (
                <li key={t} className="flex items-start gap-2 text-sm text-ink">
                  <span className="mt-0.5 text-sage" aria-hidden>
                    ✦
                  </span>
                  <span>{t}</span>
                </li>
              ))}
            </ul>
          </section>
        );
      })()}

      </>
      )}

      {dashTab === "you" && (
      <>
      {/* -------- Applied coaching: tips the user turned into standing rules -------- */}
      {coaching.length > 0 && (
        <section className="mt-10">
          <h2 className="text-lg font-bold text-ink">Coaching you turned on</h2>
          <p className="mt-1 text-sm text-body/80">
            Scout follows these in every draft it writes for you. Remove any that
            stop feeling right.
          </p>
          <div className="mt-4 space-y-2">
            {coaching.map((c) => (
              <div
                key={c}
                className="flex items-start gap-3 rounded-2xl border border-sage/40 bg-sage/10 p-4"
              >
                <span className="mt-0.5 text-sage" aria-hidden>
                  ✓
                </span>
                <p className="flex-1 text-sm text-ink">{c}</p>
                <button
                  onClick={() => onRemoveTip(c)}
                  className="shrink-0 text-xs font-semibold text-body/50 hover:text-ink"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* -------- Outreach advice: what's working for others + proven playbook -------- */}
      <OutreachAdvice
        community={community}
        finds={finds}
        templates={templates}
        coaching={coaching}
        onApplyTip={onApplyTip}
        goOutreach={goOutreach}
        goTemplates={goTemplates}
        onSeedTemplateForChannel={onSeedTemplateForChannel}
      />

      {/* -------- How Scout learns YOU -------- */}
      <section className="mt-10">
        <h2 className="text-lg font-bold text-ink">How Scout is learning you</h2>
        <p className="mt-1 text-sm text-body/80">
          Everything here is private to your account. The more Scout knows, the more
          your outreach sounds like you, not a template.
        </p>
        <div className="mt-4 space-y-2.5">
          {signals.map((s) => (
            <div
              key={s.label}
              className="flex items-start gap-3 rounded-2xl border border-warm-border bg-surface p-4 shadow-card"
            >
              <span
                className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-white ${
                  s.done ? "bg-brand-gradient" : "border border-warm-border bg-warm-bg"
                }`}
              >
                {s.done ? (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                ) : (
                  <span className="text-sm font-bold text-body/50">+</span>
                )}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-ink">{s.label}</div>
                <div className="mt-0.5 text-xs leading-relaxed text-body/80">
                  {s.hint}
                </div>
              </div>
              {s.cta && (
                <button
                  onClick={s.cta.go}
                  className="shrink-0 self-center rounded-lg border border-warm-border px-3 py-1.5 text-xs font-semibold text-accent transition hover:bg-warm-bg"
                >
                  {s.cta.label}
                </button>
              )}
            </div>
          ))}
        </div>
      </section>

      </>
      )}

      {dashTab === "scout" && (
      <>
      {/* -------- How Scout learns from EVERYONE -------- */}
      <section className="mt-10">
        <h2 className="text-lg font-bold text-ink">How Scout gets better for everyone</h2>
        <div className="mt-4 rounded-3xl border border-warm-border bg-surface p-6 shadow-card">
          <p className="text-sm leading-relaxed text-body">
            Scout improves for all users as the shared engine learns which search
            angles surface real people, which channels actually get replies, and what a
            strong match looks like by field. These patterns are aggregate and
            anonymous, they tune the defaults everyone starts from.
          </p>
          <div className="mt-4 flex items-start gap-3 rounded-2xl bg-warm-bg/60 px-4 py-3">
            <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-gradient text-white">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="10" rx="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            </span>
            <p className="text-xs leading-relaxed text-body">
              <span className="font-semibold text-ink">Your data stays yours.</span> Your
              resume, your voice templates, your contacts, and your messages are private
              to your account and never shown to other users.
            </p>
          </div>
        </div>
      </section>

      </>
      )}

      {dashTab === "you" && (
      <>
      {/* -------- CTA -------- */}
      <section className="mt-4 flex flex-wrap items-center gap-4 rounded-3xl bg-brand-gradient px-6 py-5 text-white shadow-soft">
        <div>
          <h3 className="text-base font-extrabold">Ready to reach a few more people?</h3>
          <p className="mt-1 text-xs text-white/80">
            Pick up where you left off, or start a fresh search.
          </p>
        </div>
        <button
          onClick={goOutreach}
          className="ml-auto rounded-xl bg-surface px-5 py-2.5 text-sm font-extrabold text-brown-deep transition hover:opacity-95"
        >
          Start scouting →
        </button>
      </section>
      </>
      )}
    </main>
  );
}

/* ---------------- Outreach advice: community patterns + proven playbook ---------------- */
function OutreachAdvice({
  community,
  finds,
  templates,
  coaching,
  onApplyTip,
  goOutreach,
  goTemplates,
  onSeedTemplateForChannel,
}: {
  community: CommunityStats | null;
  finds: Find[];
  templates: OutreachTemplate[];
  coaching: string[];
  onApplyTip: (tip: string) => void;
  onSeedTemplateForChannel: (channel: string) => void;
  goOutreach: () => void;
  goTemplates: () => void;
}) {
  const p = community?.patterns;
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const isApplied = (s: string) =>
    coaching.some((c) => c.trim().toLowerCase() === s.trim().toLowerCase());
  // Advice the user has dismissed — kept in localStorage so it stays hidden
  // across sessions. Simple string match on the tip body.
  const [dismissed, setDismissed] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set();
    try {
      const raw = localStorage.getItem("scout_dismissed_tips");
      if (!raw) return new Set();
      const arr = JSON.parse(raw);
      return new Set(Array.isArray(arr) ? arr.map((s: unknown) => String(s)) : []);
    } catch {
      return new Set();
    }
  });
  const dismissTip = (tip: string) => {
    const key = tip.trim().toLowerCase();
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(key);
      try {
        localStorage.setItem("scout_dismissed_tips", JSON.stringify([...next]));
      } catch {
        /* localStorage unavailable — dismissal is per-session only */
      }
      return next;
    });
  };
  const isDismissed = (s: string) => dismissed.has(s.trim().toLowerCase());

  // Detect the specific outreach channel a tip references. Returns the
  // OUTREACH_KINDS label (matching the Templates dropdown) when found, so
  // "LinkedIn is doing well" → "LinkedIn message". If the user already has a
  // template for that channel we don't nudge — the goal is to seed the FIRST
  // one, not spam.
  const detectChannel = (text: string): string | null => {
    const t = String(text || "").toLowerCase();
    const has = (channel: string) =>
      templates.some((tp) => (tp.channel || "").toLowerCase() === channel.toLowerCase());
    if (/\blinkedin\b/.test(t) && !has("LinkedIn message")) return "LinkedIn message";
    if (/\binstagram\b|\big\b/.test(t) && !has("Instagram DM")) return "Instagram DM";
    if (/\btiktok\b/.test(t) && !has("TikTok DM")) return "TikTok DM";
    if (/\b(x|twitter)\b/.test(t) && !has("X / Twitter DM")) return "X / Twitter DM";
    if (/\btext message|\bsms\b/.test(t) && !has("Text message")) return "Text message";
    if (/\bcover letter\b/.test(t) && !has("Cover letter")) return "Cover letter";
    if (/\bemail\b/.test(t) && !has("Email")) return "Email";
    return null;
  };

  const SeedTemplateBtn = ({ channel }: { channel: string }) => (
    <button
      onClick={() => onSeedTemplateForChannel(channel)}
      className="shrink-0 rounded-lg bg-brown px-2.5 py-1 text-[11px] font-bold text-white shadow-soft transition hover:opacity-90"
      title={`Jump to Templates with ${channel} pre-selected`}
    >
      Draft a {channel.replace(/ message| DM/, "")} template
    </button>
  );
  // A small "turn this into a standing rule" control shown on each coachable
  // tip, plus a "not helpful" button next to it. Dismissed tips get hidden
  // right after via the isDismissed check on the parent renderer.
  const ApplyTip = ({ tip }: { tip: string }) =>
    isApplied(tip) ? (
      <span className="shrink-0 rounded-lg bg-sage/15 px-2.5 py-1 text-[11px] font-semibold text-sage">
        Applied ✓
      </span>
    ) : (
      <span className="flex shrink-0 items-center gap-1.5">
        <button
          onClick={() => onApplyTip(tip)}
          className="rounded-lg border border-sage/50 px-2.5 py-1 text-[11px] font-semibold text-sage transition hover:bg-sage/10"
          title="Scout will follow this in every draft it writes for you"
        >
          Apply to my drafts
        </button>
        <button
          onClick={() => dismissTip(tip)}
          className="rounded-lg border border-warm-border px-2 py-1 text-[11px] font-semibold text-body/60 transition hover:bg-warm-bg hover:text-ink"
          title="Hide this advice"
        >
          Not helpful
        </button>
      </span>
    );

  // ---- Tailored coaching on the user's own drafts ----
  // Newest drafts from the pipeline, with whether they were actually sent.
  const myDrafts = finds
    .filter((f) => f.draft && (f.draft.body || "").trim())
    .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
    .slice(0, 8)
    .map((f) => ({
      channel: f.draft!.channelType,
      outcome:
        f.status === "replied" ? "replied" : f.status === "sent" ? "sent" : "drafted",
      subject: f.draft!.subject || "",
      body: f.draft!.body || "",
    }));
  // Cache key: same drafts → reuse the last review instead of re-spending credits.
  const draftsKey = myDrafts.map((d) => `${d.outcome}:${d.body.length}`).join("|");

  const [coach, setCoach] = useState<{ title: string; advice: string }[] | null>(null);
  const [coachBusy, setCoachBusy] = useState(false);
  const [coachErr, setCoachErr] = useState("");
  const [reviewedCount, setReviewedCount] = useState(0);

  useEffect(() => {
    try {
      const c = JSON.parse(localStorage.getItem("cue_draft_advice") || "null");
      if (c && c.key === draftsKey && Array.isArray(c.tips)) {
        setCoach(c.tips);
        setReviewedCount(c.reviewed || 0);
      }
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftsKey]);

  async function reviewDrafts() {
    setCoachBusy(true);
    setCoachErr("");
    try {
      const r = await fetch("/api/draft-advice", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ drafts: myDrafts }),
      });
      const j = await r.json();
      if (r.ok && j.tips) {
        setCoach(j.tips);
        setReviewedCount(j.reviewed || myDrafts.length);
        try {
          localStorage.setItem(
            "cue_draft_advice",
            JSON.stringify({ key: draftsKey, tips: j.tips, reviewed: j.reviewed })
          );
        } catch {}
      } else {
        setCoachErr(j.error || "Couldn't review your drafts.");
      }
    } catch (e: any) {
      setCoachErr(e?.message || "Couldn't review your drafts.");
    } finally {
      setCoachBusy(false);
    }
  }

  // Real, data-backed insights — each renders only when the community data
  // actually supports it (enough decisions, and the effect is really there).
  const insights: { title: string; body: string; basis: string }[] = [];
  if (p) {
    const top = p.channels[0];
    if (top) {
      insights.push({
        title: `${top.channel} finds get acted on most`,
        body: `${pct(top.keptRate)} of ${top.channel.toLowerCase()} finds are drafted or contacted — lead with searches likely to surface ${top.channel.toLowerCase()} contacts.`,
        basis: `${top.total} community decisions`,
      });
    }
    if (p.fitKept != null && p.fitDenied != null && p.fitKept > p.fitDenied) {
      insights.push({
        title: `The sweet spot is around ${pct(p.fitKept)} fit`,
        body: `People act on finds averaging ${pct(p.fitKept)} fit and pass on ones around ${pct(p.fitDenied)}. Sharpening your goal wording lifts the fit of what Scout brings back.`,
        basis: `${p.decidedFinds} community decisions`,
      });
    }
    const ce = p.contextEffect;
    if (
      ce &&
      ce.withContext != null &&
      ce.withoutContext != null &&
      ce.withContext < ce.withoutContext
    ) {
      insights.push({
        title: "Project context cuts the misses",
        body: `People who describe who their outreach is for see a ${pct(ce.withContext)} deny rate vs ${pct(ce.withoutContext)} without it. Fill in "Who this outreach is for" on each project.`,
        basis: "community deny rates, with vs without context",
      });
    }
  }

  // Established outreach practice — honestly labeled, not dressed up as Scout data.
  const playbook: { title: string; body: string; cta?: { label: string; go: () => void } }[] = [
    {
      title: "Open with something real about them",
      body: "One specific, true line about their work beats any template. Personalized outreach earns roughly 12–25% replies vs 1–3% for generic blasts (industry benchmarks).",
    },
    {
      title: "Keep it to three short paragraphs",
      body: "Who you are, why them specifically, one soft ask. Busy people reply to messages they can read in ten seconds.",
    },
    {
      title: "Ask small",
      body: "\"Would you be open to a quick call?\" outperforms a hard pitch. The first message starts the conversation; it doesn't close the deal.",
      cta: { label: "Draft one now", go: goOutreach },
    },
    {
      title: "Sound like yourself",
      body: "Drafts written in your real voice get replies your polished-corporate voice never will. Give Scout a few examples of how you actually write.",
      cta: { label: "Add a voice template", go: goTemplates },
    },
    {
      title: "Follow up once, kindly",
      body: "A short, friendly nudge after about a week roughly doubles response rates. One follow-up is persistence; three is spam.",
    },
  ];

  return (
    <section className="mt-10">
      <h2 className="text-lg font-bold text-ink">Outreach advice</h2>
      <p className="mt-1 text-sm text-body/80">
        Coaching on your own drafts, what&apos;s working for other people on Scout,
        and the fundamentals that always hold.
      </p>

      {/* Tailored coaching from the user's own drafts */}
      <div className="mt-4">
        <div className="text-xs font-bold uppercase tracking-wider text-accent">
          Tailored to you
        </div>
        {myDrafts.length === 0 ? (
          <p className="mt-2 rounded-2xl border border-dashed border-warm-border bg-surface/60 px-4 py-3 text-xs leading-relaxed text-body/70">
            Once you&apos;ve drafted a few messages, Scout can read them and coach you
            on your own writing.{" "}
            <button onClick={goOutreach} className="font-semibold text-accent hover:underline">
              Draft some first
            </button>
            .
          </p>
        ) : (
          <>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <button
                onClick={reviewDrafts}
                disabled={coachBusy}
                className="rounded-xl bg-brand-gradient px-4 py-2 text-xs font-bold text-white shadow-soft transition hover:opacity-95 disabled:opacity-50"
              >
                {coachBusy
                  ? "Reading your drafts…"
                  : coach
                  ? "Review again"
                  : `Review my ${myDrafts.length} recent ${myDrafts.length === 1 ? "draft" : "drafts"}`}
              </button>
              <span className="text-xs text-body/60">
                Scout reads your recent messages and coaches you on them.
              </span>
            </div>
            {coachErr && (
              <p className="mt-2 rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-2 text-xs text-amber-800">
                {coachErr}
              </p>
            )}
            {coach && (
              <>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  {coach.map((t) => (
                    <div
                      key={t.title}
                      className="rounded-2xl border border-coral/30 bg-surface p-4 shadow-card"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="text-sm font-bold text-ink">{t.title}</div>
                        <ApplyTip tip={t.advice} />
                      </div>
                      <p className="mt-1 text-xs leading-relaxed text-body">{t.advice}</p>
                    </div>
                  ))}
                </div>
                <p className="mt-2 text-[10px] font-semibold uppercase tracking-wide text-body/50">
                  Based on {reviewedCount || myDrafts.length} of your own drafts, private
                  to you
                </p>
              </>
            )}
          </>
        )}
      </div>

      {/* Data-backed community insights */}
      <div className="mt-4">
        <div className="text-xs font-bold uppercase tracking-wider text-accent">
          Working for the community right now
        </div>
        {insights.filter((t) => !isDismissed(t.body)).length ? (
          <div className="mt-2.5 grid gap-3 sm:grid-cols-2">
            {insights.filter((t) => !isDismissed(t.body)).map((tip) => {
              const channel = detectChannel(`${tip.title} ${tip.body}`);
              return (
                <div
                  key={tip.title}
                  className="rounded-2xl border border-coral/30 bg-warm-bg/40 p-4 shadow-card"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="text-sm font-bold text-ink">{tip.title}</div>
                    <ApplyTip tip={tip.body} />
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-body">{tip.body}</p>
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-body/50">
                      Based on {tip.basis}
                    </div>
                    {channel && <SeedTemplateBtn channel={channel} />}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="mt-2 rounded-2xl border border-dashed border-warm-border bg-surface/60 px-4 py-3 text-xs leading-relaxed text-body/70">
            Live patterns show up here once the community has made enough decisions —
            real numbers only, so nothing appears until the data can back it up.
          </p>
        )}
      </div>

      {/* Proven playbook */}
      <div className="mt-5">
        <div className="text-xs font-bold uppercase tracking-wider text-body/60">
          Fundamentals
        </div>
        <div className="mt-2.5 grid gap-3 sm:grid-cols-2">
          {playbook.filter((tip) => !isDismissed(tip.body)).map((tip) => (
            <div
              key={tip.title}
              className="rounded-2xl border border-warm-border bg-surface p-4 shadow-card"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="text-sm font-bold text-ink">{tip.title}</div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <ApplyTip tip={tip.body} />
                  {tip.cta && (
                    <button
                      onClick={tip.cta.go}
                      className="shrink-0 rounded-lg border border-warm-border px-2.5 py-1 text-[11px] font-semibold text-accent transition hover:bg-warm-bg"
                    >
                      {tip.cta.label}
                    </button>
                  )}
                </div>
              </div>
              <p className="mt-1 text-xs leading-relaxed text-body">{tip.body}</p>
            </div>
          ))}
        </div>
        <p className="mt-2.5 text-xs text-body/50">
          Playbook tips are established outreach practice, not Scout data. The section
          above switches to real community numbers as they accumulate.
        </p>
      </div>
    </section>
  );
}

function CompareRow({
  label,
  you,
  them,
  fmt,
  lowerBetter = false,
}: {
  label: string;
  you: number | null;
  them: number | null;
  fmt: "pct" | "num";
  lowerBetter?: boolean;
}) {
  const f = (v: number | null) =>
    v == null ? "—" : fmt === "pct" ? `${Math.round(v * 100)}%` : `${Math.round(v)}`;
  const ahead =
    you != null && them != null
      ? lowerBetter
        ? you < them
        : you > them
      : null;
  return (
    <div className="rounded-2xl border border-warm-border bg-surface p-4 shadow-card">
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold uppercase tracking-wider text-body/60">
          {label}
        </span>
        {ahead != null && ahead && (
          <span className="text-[10px] font-bold text-emerald-600">▲ ahead</span>
        )}
      </div>
      <div className="mt-1.5 flex items-end gap-3">
        <div>
          <div className="text-2xl font-extrabold tracking-tight text-ink">{f(you)}</div>
          <div className="text-[10px] font-medium text-body/60">you</div>
        </div>
        <div className="mb-1.5 text-xs text-body/40">vs</div>
        <div>
          <div className="text-lg font-bold text-body/70">{f(them)}</div>
          <div className="text-[10px] font-medium text-body/60">community avg</div>
        </div>
      </div>
    </div>
  );
}

function StatTile({
  n,
  label,
  icon,
}: {
  n: number;
  label: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="rounded-3xl border border-warm-border bg-surface p-5 shadow-card">
      <span className="mb-3 flex h-9 w-9 items-center justify-center rounded-xl bg-brown-tint">
        <svg
          width="17"
          height="17"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-brown-deep"
        >
          {icon}
        </svg>
      </span>
      <div className="text-3xl font-extrabold tracking-tight text-ink">
        <CountUp value={n} />
      </div>
      <div className="mt-1 text-xs font-semibold text-body">{label}</div>
    </div>
  );
}

/* ---------------- Meeting prep ----------------
 * Once a find's status is "sent" or later — meaning the user has actually
 * reached out — Scout offers to prep them for a meeting/interview by
 * pulling fresh facts about the contact + outlet. Statuses "new" and
 * "drafted" don't show the button; that's the deliberate incentive to
 * keep statuses current. Denied hides it too. */
function MeetingPrepBlock({
  find,
  busy,
  onGenerate,
}: {
  find: Find;
  busy: boolean;
  onGenerate: () => void;
}) {
  const unlocked = find.status === "sent" || find.status === "replied";
  const prep = find.meetingPrep;
  // Don't render the block at all until it's unlocked AND has content or a
  // reason to show the button. Keeps early-stage cards uncluttered.
  if (!unlocked && !prep) return null;
  return (
    <div className="mt-3 rounded-xl border border-warm-border bg-surface p-3">
      <div className="flex items-center gap-2">
        <span className="text-xs font-extrabold uppercase tracking-wider text-brown-deep">
          Meeting prep
        </span>
        {prep && (
          <span className="text-[10px] font-semibold text-body/50">
            generated {new Date(prep.generatedAt).toLocaleDateString()}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <button
            onClick={onGenerate}
            disabled={busy}
            className="rounded-lg bg-brown px-2.5 py-1 text-[11px] font-bold text-white shadow-soft transition hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Pulling facts…" : prep ? "Refresh" : "Prep for a meeting"}
          </button>
        </div>
      </div>
      {prep && prep.facts.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {prep.facts.map((f, i) => (
            <li key={i} className="flex items-start gap-2 text-xs leading-relaxed">
              <span className="mt-0.5 shrink-0 rounded bg-warm-bg px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-brown-deep">
                {f.category}
              </span>
              <div className="min-w-0 flex-1 text-body">
                {f.fact}
                {f.source?.url && (
                  <>
                    {" "}
                    <a
                      href={f.source.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-brown underline-offset-2 hover:underline"
                    >
                      source
                    </a>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {!prep && unlocked && (
        <p className="mt-1.5 text-[11px] leading-relaxed text-body/70">
          Now that you've reached out, Scout can pull real facts about their
          career, outlet, and recent work so you can walk in informed.
        </p>
      )}
    </div>
  );
}

/* ---------------- Schedule picker ----------------
 * Small popover on the draft's Send row. Suggests a smart default time (next
 * 9am-6pm window in the recipient's timezone if we have one; else 9am tomorrow
 * in the user's timezone) and lets them pick another. On confirm, the parent
 * enqueues the message via /api/schedule-send and Vercel Cron drains the queue
 * every 15 minutes. */
function SchedulePicker({
  timezone,
  scheduledFor,
  onSchedule,
}: {
  timezone?: string; // recipient's IANA tz, if we extracted one
  scheduledFor?: string; // ISO string if this find already has a queued send
  onSchedule: (sendAt: Date) => void;
}) {
  const [open, setOpen] = useState(false);
  const suggested = suggestBusinessHour(timezone);
  const [value, setValue] = useState<string>(toLocalDatetime(suggested));
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  if (scheduledFor) {
    const when = new Date(scheduledFor);
    return (
      <span className="inline-flex items-center gap-1.5 rounded-lg border border-sage/50 bg-sage/10 px-2.5 py-1.5 text-[11px] font-bold text-brown-deep">
        Scheduled · {when.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
      </span>
    );
  }

  return (
    <div ref={ref} className="relative inline-block">
      <button
        onClick={() => setOpen((v) => !v)}
        className="rounded-lg border border-warm-border bg-surface px-2.5 py-1.5 text-xs font-semibold text-body transition hover:bg-warm-bg"
        title="Send at a specific time"
      >
        Schedule ▾
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1.5 w-64 rounded-xl border border-warm-border bg-surface p-3 shadow-soft">
          <div className="text-[11px] font-bold uppercase tracking-wider text-body/60">
            Send at
          </div>
          <input
            type="datetime-local"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="mt-1.5 w-full rounded-lg border border-warm-border px-2 py-1.5 text-xs text-ink outline-none focus:border-brown"
          />
          <p className="mt-1.5 text-[10px] leading-relaxed text-body/70">
            {timezone
              ? `Suggested: next business hour in ${timezone}.`
              : "Suggested: 9am tomorrow, your time."}
          </p>
          <div className="mt-2 flex gap-1.5">
            <button
              onClick={() => {
                const d = fromLocalDatetime(value);
                if (!d || d.getTime() < Date.now() + 60_000) {
                  // datetime-local can round the past — bounce anything within
                  // the next minute so the cron doesn't grab a "stale" queue
                  // item on its first pass.
                  return;
                }
                onSchedule(d);
                setOpen(false);
              }}
              className="flex-1 rounded-lg bg-brown px-3 py-1.5 text-xs font-bold text-white shadow-soft transition hover:opacity-90"
            >
              Queue send
            </button>
            <button
              onClick={() => setOpen(false)}
              className="rounded-lg border border-warm-border px-3 py-1.5 text-xs font-semibold text-body transition hover:bg-warm-bg"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Return the next moment that falls inside recipient business hours. If we have
// a recipient timezone, use it; else fall back to 9am tomorrow in the user's tz.
function suggestBusinessHour(tz?: string): Date {
  const now = new Date();
  if (!tz) {
    // 9am tomorrow, local user tz.
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    return d;
  }
  try {
    // Read the current hour in the recipient's tz.
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      hour12: false,
      weekday: "short",
    }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === "hour")?.value || "0");
    const day = parts.find((p) => p.type === "weekday")?.value || "";
    const inBiz = hour >= 9 && hour < 18 && !/sat|sun/i.test(day);
    if (inBiz) {
      // Already business hours there — schedule 15 min out (still respects the
      // window, gives the user a beat to change their mind).
      return new Date(now.getTime() + 15 * 60 * 1000);
    }
    // Not in business hours → next 9am in that tz. Building the exact instant
    // via Intl formatting is tricky; approximate by taking the local 9am
    // tomorrow (the user picks in local time via the datetime-local input, so
    // exactness here only affects the suggestion default).
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    return d;
  } catch {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    return d;
  }
}

// datetime-local wants "YYYY-MM-DDTHH:mm" in LOCAL time (no seconds, no tz).
function toLocalDatetime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    d.getFullYear() +
    "-" +
    pad(d.getMonth() + 1) +
    "-" +
    pad(d.getDate()) +
    "T" +
    pad(d.getHours()) +
    ":" +
    pad(d.getMinutes())
  );
}
function fromLocalDatetime(v: string): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/* ---------------- One-click send action per draft (no account linking needed) ---------------- */
function SendAction({ draft, onUse }: { draft: Draft; onUse: () => void }) {
  const btn =
    "rounded-lg bg-brand-gradient px-3 py-1 text-xs font-bold text-white shadow-card transition hover:opacity-95";

  if (draft.channelType === "email") {
    const to = mailHref(draft.to) ? draft.to : "";
    const href =
      `mailto:${to}` +
      `?subject=${encodeURIComponent(draft.subject || "")}` +
      `&body=${encodeURIComponent(draft.body || "")}`;
    return (
      <a href={href} onClick={onUse} className={btn}>
        Open in email
      </a>
    );
  }

  const url = linkHref(draft.to);
  if (url) {
    const isLi = /linkedin\.com/i.test(url);
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        onClick={onUse}
        className={btn}
        title="Opens their profile so you can paste and send"
      >
        {isLi ? "Open in LinkedIn" : "Open link"}
      </a>
    );
  }
  return null;
}

/* ---------------- Team tab (workspaces + shared projects + shared finds) ---------------- */
function TeamTab({
  getToken,
  accountEmail,
  projects,
  finds,
}: {
  getToken?: () => Promise<string | null>;
  accountEmail: string;
  projects: Project[];
  finds: Find[];
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState("");
  const [ctx, setCtx] = useState<{ workspaces: any[]; invites: any[] }>({
    workspaces: [],
    invites: [],
  });
  const [wsName, setWsName] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [sharedProjects, setSharedProjects] = useState<any[]>([]);
  const [shareChoice, setShareChoice] = useState("");
  const [openId, setOpenId] = useState("");
  const [sharedFinds, setSharedFinds] = useState<any[]>([]);
  const [recs, setRecs] = useState<any[]>([]);

  const workspace = ctx.workspaces[0] || null;

  async function authFetch(url: string, opts: any = {}) {
    const token = getToken ? await getToken() : null;
    if (!token) throw new Error("Please sign in to use teams.");
    const res = await fetch(url, {
      ...opts,
      headers: {
        ...(opts.headers || {}),
        authorization: `Bearer ${token}`,
        ...(opts.body ? { "content-type": "application/json" } : {}),
      },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Request failed.");
    return data;
  }

  async function loadCtx() {
    setLoading(true);
    setError("");
    try {
      const data = await authFetch("/api/team/workspace");
      const wss = data.workspaces || [];
      setCtx({ workspaces: wss, invites: data.invites || [] });
      if (wss[0]) {
        const p = await authFetch(`/api/team/project?workspaceId=${wss[0].id}`);
        setSharedProjects(p.projects || []);
      } else {
        setSharedProjects([]);
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    loadCtx();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setNote("");
    setError("");
    try {
      await fn();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  }

  const createWorkspace = () =>
    run("create", async () => {
      await authFetch("/api/team/workspace", {
        method: "POST",
        body: JSON.stringify({ name: wsName }),
      });
      setWsName("");
      await loadCtx();
    });

  const invite = () =>
    run("invite", async () => {
      await authFetch("/api/team/invite", {
        method: "POST",
        body: JSON.stringify({ workspaceId: workspace.id, email: inviteEmail }),
      });
      setNote(`Invited ${inviteEmail.trim()}. They'll see it when they sign in.`);
      setInviteEmail("");
      await loadCtx();
    });

  const accept = (workspaceId: string) =>
    run("accept-" + workspaceId, async () => {
      await authFetch("/api/team/accept", {
        method: "POST",
        body: JSON.stringify({ workspaceId }),
      });
      await loadCtx();
    });

  // Share a local project (with its current finds) into the workspace.
  const shareProject = () =>
    run("share", async () => {
      const p = projects.find((x) => x.id === shareChoice);
      if (!p) throw new Error("Pick a project to share.");
      const seed = finds
        .filter((f) => f.projectId === p.id)
        .map((f) => ({
          dedupKey: f.id,
          opp: f.opp,
          status: f.status,
          draft: f.draft || null,
          requirements: f.requirements || null,
          gmailThreadId: f.gmailThreadId || null,
          denyReason: f.denyReason || null,
        }));
      await authFetch("/api/team/project", {
        method: "POST",
        body: JSON.stringify({
          workspaceId: workspace.id,
          name: p.name,
          useCase: p.useCase,
          context: p.context || "",
          finds: seed,
        }),
      });
      setNote(`Shared "${p.name}" with your Team${seed.length ? ` (${seed.length} finds)` : ""}.`);
      setShareChoice("");
      await loadCtx();
    });

  const openProject = (id: string) =>
    run("open-" + id, async () => {
      setOpenId(id);
      const [f, r] = await Promise.all([
        authFetch(`/api/team/finds?projectId=${id}`),
        authFetch(`/api/team/project?recommendationsFor=${id}`),
      ]);
      setSharedFinds(f.finds || []);
      setRecs(r.recommendations || []);
    });

  const patchFind = (findId: string, patch: any) =>
    run("find-" + findId, async () => {
      const data = await authFetch("/api/team/finds/update", {
        method: "POST",
        body: JSON.stringify({ findId, ...patch }),
      });
      setSharedFinds((prev) => prev.map((x) => (x.id === findId ? data.find : x)));
    });

  const addTeammate = (userId: string) =>
    run("add-" + userId, async () => {
      await authFetch("/api/team/project/members", {
        method: "POST",
        body: JSON.stringify({ sharedProjectId: openId, addUserIds: [userId] }),
      });
      await openProject(openId);
      await loadCtx();
    });

  const emailShort = (e: string) => (e || "").split("@")[0] || e;
  const alreadyShared = new Set(sharedProjects.map((p) => p.name.toLowerCase()));
  const shareable = projects.filter((p) => !alreadyShared.has(p.name.toLowerCase()));

  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight text-ink">
        Your <span className="brand-text">team</span>
      </h1>
      <p className="mt-2 text-[15px] leading-relaxed text-body">
        Share a project with teammates so you all see the same finds and who is
        working on what. No two people pitch the same contact twice.
      </p>

      {error && (
        <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
          {error}
        </div>
      )}
      {note && (
        <div className="mt-4 rounded-xl border border-sage/40 bg-sage/10 px-4 py-2.5 text-sm text-brown-deep">
          {note}
        </div>
      )}

      {/* Invites addressed to me */}
      {ctx.invites.length > 0 && (
        <Reveal as="section" className="mt-6 space-y-2" stagger={0.05}>
          {ctx.invites.map((inv) => (
            <div
              key={inv.id}
              className="flex flex-wrap items-center gap-3 rounded-2xl border border-sage/50 bg-sage/10 p-4"
            >
              <span className="flex-1 text-sm text-ink">
                You&apos;ve been invited to{" "}
                <span className="font-bold">{inv.workspaceName}</span>.
              </span>
              <button
                onClick={() => accept(inv.workspaceId)}
                disabled={!!busy}
                className="rounded-xl bg-brand-gradient px-4 py-2 text-xs font-bold text-white shadow-soft transition hover:opacity-95 disabled:opacity-50"
              >
                {busy === "accept-" + inv.workspaceId ? "Joining…" : "Join"}
              </button>
            </div>
          ))}
        </Reveal>
      )}

      {loading ? (
        <p className="mt-8 text-sm text-body/60">Loading your Team…</p>
      ) : !workspace ? (
        /* -------- No workspace yet: create one -------- */
        <section className="mt-7 rounded-3xl border border-warm-border bg-surface p-6 shadow-soft">
          <h2 className="text-lg font-bold text-ink">Name your workspace</h2>
          <p className="mt-1 text-sm text-body/80">
            A workspace is your company or crew. Give it a name, then invite teammates
            and share projects with them.
          </p>
          <div className="mt-4">
            <Label>Workspace name</Label>
            <div className="flex flex-wrap gap-2">
              <input
                value={wsName}
                onChange={(e) => setWsName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && wsName.trim()) createWorkspace();
                }}
                placeholder="e.g. Acme Studio, or the marketing team"
                className="min-w-[220px] flex-1 rounded-xl border border-warm-border px-3.5 py-3 text-sm text-ink outline-none transition focus:border-coral focus:ring-4 focus:ring-coral/15"
              />
              <button
                onClick={createWorkspace}
                disabled={!wsName.trim() || !!busy}
                className="rounded-xl bg-brand-gradient px-5 py-3 text-sm font-bold text-white shadow-soft transition hover:opacity-95 disabled:opacity-50"
              >
                {busy === "create" ? "Creating…" : "Create workspace"}
              </button>
            </div>
          </div>
        </section>
      ) : (
        <>
          {/* -------- Workspace: members + invite -------- */}
          <section className="mt-7 rounded-3xl border border-warm-border bg-surface p-6 shadow-soft">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-lg font-bold text-ink">{workspace.name}</h2>
              <span className="text-xs font-semibold text-body/60">
                {workspace.members?.length || 1}{" "}
                {(workspace.members?.length || 1) === 1 ? "member" : "members"}
              </span>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {(workspace.members || []).map((m: any) => (
                <span
                  key={m.user_id}
                  className="inline-flex items-center gap-1.5 rounded-full border border-warm-border bg-warm-bg px-3 py-1 text-xs font-medium text-ink"
                  title={m.email}
                >
                  <span className="grid h-4 w-4 place-items-center rounded-full bg-brand-gradient text-[9px] font-bold text-white">
                    {emailShort(m.email).charAt(0).toUpperCase()}
                  </span>
                  {m.email === accountEmail ? "You" : emailShort(m.email)}
                  {m.role === "owner" && (
                    <span className="text-[9px] font-bold uppercase text-body/50">owner</span>
                  )}
                </span>
              ))}
            </div>
            <div className="mt-4 flex flex-wrap gap-2 border-t border-warm-border pt-4">
              <input
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && inviteEmail.trim()) invite();
                }}
                placeholder="Invite a teammate by email (inside or outside your company)"
                className="min-w-[240px] flex-1 rounded-xl border border-warm-border px-3.5 py-2.5 text-sm text-ink outline-none transition focus:border-coral focus:ring-4 focus:ring-coral/15"
              />
              <button
                onClick={invite}
                disabled={!inviteEmail.trim() || !!busy}
                className="rounded-xl border border-warm-border px-4 py-2.5 text-sm font-bold text-accent transition hover:bg-warm-bg disabled:opacity-50"
              >
                {busy === "invite" ? "Inviting…" : "Invite"}
              </button>
            </div>
          </section>

          {/* -------- Shared projects -------- */}
          <section className="mt-6">
            <h2 className="text-lg font-bold text-ink">Shared projects</h2>
            {sharedProjects.length === 0 ? (
              <p className="mt-2 rounded-2xl border border-dashed border-warm-border bg-surface/60 px-4 py-3 text-sm text-body/70">
                Nothing shared yet. Share one of your projects below and its finds become
                a shared pipeline your Team works from together.
              </p>
            ) : (
              <div className="mt-3 space-y-2">
                {sharedProjects.map((p) => (
                  <div
                    key={p.id}
                    className="rounded-2xl border border-warm-border bg-surface p-4 shadow-card"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-bold text-ink">{p.name}</span>
                      <span className="rounded-full border border-warm-border bg-warm-bg px-2 py-0.5 text-[10px] font-medium text-body">
                        {(p.members || []).length} on the team
                      </span>
                      <button
                        onClick={() => (openId === p.id ? setOpenId("") : openProject(p.id))}
                        disabled={busy === "open-" + p.id}
                        className="ml-auto rounded-lg border border-warm-border px-3 py-1.5 text-xs font-semibold text-accent transition hover:bg-warm-bg"
                      >
                        {busy === "open-" + p.id
                          ? "Opening…"
                          : openId === p.id
                          ? "Hide"
                          : "Open shared finds"}
                      </button>
                    </div>

                    {openId === p.id && (
                      <div className="mt-3 border-t border-warm-border pt-3">
                        {/* Add teammates from the workspace */}
                        {recs.length > 0 && (
                          <div className="mb-3 flex flex-wrap items-center gap-1.5">
                            <span className="text-[11px] font-semibold text-body/60">
                              Add from your workspace:
                            </span>
                            {recs.map((m: any) => (
                              <button
                                key={m.user_id}
                                onClick={() => addTeammate(m.user_id)}
                                disabled={!!busy}
                                className="rounded-full border border-sage/50 px-2.5 py-1 text-[11px] font-semibold text-sage transition hover:bg-sage/10 disabled:opacity-50"
                              >
                                + {emailShort(m.email)}
                              </button>
                            ))}
                          </div>
                        )}

                        {sharedFinds.length === 0 ? (
                          <p className="text-xs text-body/60">
                            No shared finds yet in this project.
                          </p>
                        ) : (
                          <div className="space-y-2">
                            {sharedFinds.map((f) => (
                              <SharedFindRow
                                key={f.id}
                                f={f}
                                accountEmail={accountEmail}
                                busy={busy === "find-" + f.id}
                                onClaim={(claim) => patchFind(f.id, { claim })}
                                onStatus={(status) => patchFind(f.id, { status })}
                                emailShort={emailShort}
                              />
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Share a project */}
            {shareable.length > 0 && (
              <div className="mt-4 flex flex-wrap items-center gap-2 rounded-2xl border border-warm-border bg-surface p-4">
                <span className="text-sm font-semibold text-ink">Share a project:</span>
                <select
                  value={shareChoice}
                  onChange={(e) => setShareChoice(e.target.value)}
                  className="scout-select min-w-[180px] rounded-xl border border-warm-border bg-surface px-3 py-2 text-sm font-semibold text-ink outline-none focus:border-coral"
                >
                  <option value="">Pick a project…</option>
                  {shareable.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <button
                  onClick={shareProject}
                  disabled={!shareChoice || !!busy}
                  className="rounded-xl bg-brand-gradient px-4 py-2 text-sm font-bold text-white shadow-soft transition hover:opacity-95 disabled:opacity-50"
                >
                  {busy === "share" ? "Sharing…" : "Share with team"}
                </button>
              </div>
            )}
          </section>
        </>
      )}
    </main>
  );
}

// One row in a shared pipeline: the prospect, who's on it, and its status.
function SharedFindRow({
  f,
  accountEmail,
  busy,
  onClaim,
  onStatus,
  emailShort,
}: {
  f: any;
  accountEmail: string;
  busy: boolean;
  onClaim: (claim: boolean) => void;
  onStatus: (status: FindStatus) => void;
  emailShort: (e: string) => string;
}) {
  const opp = f.opp || {};
  const mine = f.claimed_email && f.claimed_email === accountEmail;
  return (
    <div className="rounded-xl border border-warm-border bg-surface p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-ink">
          {opp.url ? (
            <a href={opp.url} target="_blank" rel="noreferrer" className="hover:text-accent">
              {opp.name}
            </a>
          ) : (
            opp.name
          )}
        </span>
        {opp.outlet && <span className="text-xs text-body/70">{opp.outlet}</span>}
        <select
          value={f.status}
          onChange={(e) => onStatus(e.target.value as FindStatus)}
          disabled={busy}
          title="Set status"
          className="ml-auto cursor-pointer appearance-none rounded-full border border-warm-border bg-warm-bg px-2 py-0.5 text-[10px] font-bold text-body outline-none"
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
        {f.claimed_email ? (
          <span
            className={`font-semibold ${mine ? "text-sage" : "text-accent"}`}
            title={f.claimed_email}
          >
            {mine ? "You're on this" : `${emailShort(f.claimed_email)} is on this`}
          </span>
        ) : (
          <span className="text-body/50">Unclaimed</span>
        )}
        {f.added_email && (
          <span className="text-body/50">added by {emailShort(f.added_email)}</span>
        )}
        <button
          onClick={() => onClaim(!mine)}
          disabled={busy}
          className={`ml-auto rounded-lg px-2.5 py-1 font-semibold transition disabled:opacity-50 ${
            mine
              ? "border border-warm-border text-body/60 hover:bg-warm-bg"
              : "bg-brand-gradient text-white hover:opacity-95"
          }`}
        >
          {busy ? "…" : mine ? "Release" : f.claimed_email ? "Take over" : "I'll take it"}
        </button>
      </div>
    </div>
  );
}

/* ---------------- Settings tab ---------------- */
function SettingsTab({
  onStartTour,
  onExport,
}: {
  onStartTour: () => void;
  onExport: () => void;
}) {
  // Theme mirrors the .dark class on <html>; persisted to scout_theme and
  // applied pre-paint by the inline script in layout.tsx.
  const [dark, setDark] = useState(false);
  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
  }, []);
  function setTheme(next: boolean) {
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("scout_theme", next ? "dark" : "light");
    } catch {}
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight text-ink">
        <span className="brand-text">Settings</span>
      </h1>
      <p className="mt-2 text-[15px] leading-relaxed text-body">
        Small preferences that shape how Scout shows up for you.
      </p>

      {/* Appearance */}
      <section className="mt-8 rounded-3xl border border-warm-border bg-surface p-6 shadow-soft sm:p-8">
        <h2 className="text-base font-extrabold tracking-tight text-ink">Appearance</h2>
        <p className="mt-1 text-sm leading-relaxed text-body">
          Choose the theme Scout uses on this device.
        </p>
        <div className="mt-4 inline-flex rounded-xl border border-warm-border bg-warm-bg/40 p-1">
          {(
            [
              ["light", "Light"],
              ["dark", "Dark"],
            ] as const
          ).map(([val, label]) => {
            const active = (val === "dark") === dark;
            return (
              <button
                key={val}
                onClick={() => setTheme(val === "dark")}
                className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-bold transition ${
                  active
                    ? "bg-brown text-white shadow-soft"
                    : "text-body/70 hover:text-ink"
                }`}
              >
                {val === "light" ? (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
                ) : (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>
                )}
                {label}
              </button>
            );
          })}
        </div>
      </section>

      {/* Introduction tour */}
      <section className="mt-6 rounded-3xl border border-warm-border bg-surface p-6 shadow-soft sm:p-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-md">
            <h2 className="text-base font-extrabold tracking-tight text-ink">
              Introduction tour
            </h2>
            <p className="mt-1.5 text-sm leading-relaxed text-body">
              A quick walkthrough that highlights each part of the app. It shows
              automatically the first time you sign in. Replay it here anytime.
            </p>
          </div>
          <button
            onClick={onStartTour}
            className="shrink-0 rounded-xl bg-brown px-4 py-2.5 text-sm font-bold text-white shadow-soft transition hover:opacity-90"
          >
            Show the tour
          </button>
        </div>
      </section>

      {/* Your data */}
      <section className="mt-6 rounded-3xl border border-warm-border bg-surface p-6 shadow-soft sm:p-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-md">
            <h2 className="text-base font-extrabold tracking-tight text-ink">
              Export your data
            </h2>
            <p className="mt-1.5 text-sm leading-relaxed text-body">
              Download everything Scout has stored for you, your profile,
              projects, finds, templates, and learned voice, as a single JSON
              file. Nothing leaves your browser except the download.
            </p>
          </div>
          <button
            onClick={onExport}
            className="shrink-0 rounded-xl border border-warm-border bg-surface px-4 py-2.5 text-sm font-bold text-ink transition hover:bg-warm-bg"
          >
            Download JSON
          </button>
        </div>
      </section>
    </main>
  );
}

/* ---------------- Templates tab ---------------- */
function TemplatesTab({
  kinds,
  channel,
  setChannel,
  text,
  setText,
  add,
  list,
  remove,
  projects,
  categories,
  scopeProjectId,
  scopeCategoryId,
  setScopeProjectId,
  setScopeCategoryId,
}: {
  kinds: string[];
  channel: string;
  setChannel: (v: string) => void;
  text: string;
  setText: (v: string) => void;
  add: () => void;
  list: OutreachTemplate[];
  remove: (id: string) => void;
  projects: Project[];
  categories: Category[];
  scopeProjectId: string;
  scopeCategoryId: string;
  setScopeProjectId: (id: string) => void;
  setScopeCategoryId: (id: string) => void;
}) {
  const scopeCats = categories.filter((c) => c.projectId === scopeProjectId);
  // Human label for where a saved template applies.
  const scopeLabel = (t: OutreachTemplate): string => {
    if (!t.projectId) return "All projects";
    const proj = projects.find((p) => p.id === t.projectId);
    const projName = proj?.name || "a project";
    if (!t.categoryId) return projName;
    const cat = categories.find((c) => c.id === t.categoryId);
    return `${projName} · ${cat?.name || "a category"}`;
  };
  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight text-ink">
        Your <span className="brand-text">templates</span>
      </h1>
      <p className="mt-2 text-[15px] leading-relaxed text-body">
        Set up how each kind of message should sound. When Scout drafts outreach,
        it uses your voice. Keep a template universal, or assign it to a specific
        project or category.
      </p>

      <section className="mt-7 rounded-3xl border border-warm-border bg-surface p-6 shadow-soft sm:p-8">
        <div className="grid gap-5 sm:grid-cols-[210px_1fr]">
          <div>
            <Label>Kind of outreach</Label>
            <select
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
              className="scout-select w-full rounded-xl border border-warm-border bg-surface px-3.5 py-3 text-sm font-semibold text-ink outline-none transition focus:border-coral focus:ring-4 focus:ring-coral/15"
            >
              {kinds.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <p className="mt-2.5 text-xs leading-relaxed text-body/80">
              Scout drafts this kind of message in the style you show it here.
            </p>
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between gap-2">
              <Label className="mb-0">Show us how you write it</Label>
              <MicButton onAppend={(t) => setText(joinSpoken(text, t))} />
            </div>
            <FileDrop
              label="Drop a cover letter or example file, or click to upload"
              onText={(t) => setText(text.trim() ? text.trim() + "\n\n" + t : t)}
            />
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={5}
              placeholder="…or paste a real example, or write a sample of how you want this kind of message to sound. Hi! My name is... I came across your work and thought it was incredible. I would love to..."
              className="mt-3 w-full resize-y rounded-xl border border-warm-border px-3.5 py-3 text-sm text-ink outline-none transition focus:border-coral focus:ring-4 focus:ring-coral/15"
            />
          </div>
        </div>
        <div className="mt-6 border-t border-warm-border pt-5">
          <Label>Where it applies</Label>
          <div className="mt-1 grid gap-3 sm:grid-cols-2">
            <select
              value={scopeProjectId}
              onChange={(e) => setScopeProjectId(e.target.value)}
              className="scout-select w-full rounded-xl border border-warm-border bg-surface px-3.5 py-3 text-sm font-semibold text-ink outline-none transition focus:border-coral focus:ring-4 focus:ring-coral/15"
            >
              <option value="">All projects</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <select
              value={scopeCategoryId}
              onChange={(e) => setScopeCategoryId(e.target.value)}
              disabled={!scopeProjectId}
              className="scout-select w-full rounded-xl border border-warm-border bg-surface px-3.5 py-3 text-sm font-semibold text-ink outline-none transition focus:border-coral focus:ring-4 focus:ring-coral/15 disabled:opacity-50"
            >
              <option value="">
                {scopeProjectId ? "All categories in this project" : "Pick a project first"}
              </option>
              {scopeCats.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="mt-5">
          <button
            onClick={add}
            disabled={!text.trim()}
            className="rounded-xl bg-brand-gradient px-6 py-3 text-sm font-bold text-white shadow-soft transition hover:opacity-95 disabled:opacity-50"
          >
            Save template
          </button>
        </div>
      </section>

      <section className="mt-8">
        <h2 className="mb-4 text-lg font-bold text-ink">
          Your Templates ({list.length})
        </h2>
        {list.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-warm-border bg-surface/60 p-10 text-center text-sm text-body/70">
            No templates yet. Add one for email, a LinkedIn message, or an Instagram
            DM, and every draft will match that style.
          </div>
        ) : (
          <Reveal className="space-y-3" stagger={0.05}>
            {list.map((s) => (
              <div
                key={s.id}
                className="rounded-2xl border border-warm-border bg-surface p-5 shadow-card"
              >
                <div className="mb-2.5 flex flex-wrap items-center gap-2">
                  <span className="rounded-full bg-brand-gradient px-2.5 py-0.5 text-xs font-semibold text-white">
                    {s.channel}
                  </span>
                  <span
                    className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${
                      s.projectId
                        ? "border-sage/50 bg-sage/10 text-sage"
                        : "border-warm-border bg-warm-bg text-body/70"
                    }`}
                  >
                    {scopeLabel(s)}
                  </span>
                  <button
                    onClick={() => remove(s.id)}
                    className="ml-auto text-xs font-semibold text-body/60 transition hover:text-accent"
                  >
                    Remove
                  </button>
                </div>
                <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-body">
                  {s.text}
                </pre>
              </div>
            ))}
          </Reveal>
        )}
      </section>
    </main>
  );
}

/* ---------------- Use-case combobox (free text + typeahead suggestions) ---------------- */
function UseCaseCombo({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Keep the field in sync if the profile's use case changes elsewhere.
  useEffect(() => setDraft(value), [value]);

  // Close the dropdown on an outside click.
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const q = draft.trim().toLowerCase();
  const matches = q
    ? USE_CASE_SUGGESTIONS.filter((s) => s.toLowerCase().includes(q))
    : USE_CASE_SUGGESTIONS;

  // Commit typed or picked text. No match is fine, we keep exactly what they typed.
  function commit(v: string) {
    const val = v.trim();
    if (val) {
      setDraft(val);
      if (val !== value) onChange(val);
    } else {
      setDraft(value); // don't allow an empty use case
    }
    setOpen(false);
  }

  return (
    <div ref={wrapRef} className="relative">
      <input
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => commit(draft)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit(open && matches[active] ? matches[active] : draft);
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setActive((a) => Math.min(a + 1, matches.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Escape") {
            setDraft(value);
            setOpen(false);
          }
        }}
        placeholder="Type what you're using Scout for…"
        className="w-full rounded-xl border border-warm-border bg-surface px-3.5 py-3 text-sm font-semibold text-ink outline-none transition focus:border-coral focus:ring-4 focus:ring-coral/15"
      />
      {open && matches.length > 0 && (
        <div className="absolute z-30 mt-1.5 max-h-64 w-full overflow-auto rounded-xl border border-warm-border bg-surface py-1 shadow-soft">
          {matches.map((s, i) => (
            <button
              key={s}
              type="button"
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault(); // keep focus; run our commit, not the blur
                commit(s);
              }}
              className={`block w-full px-3.5 py-2 text-left text-sm transition ${
                i === active ? "bg-warm-bg text-ink" : "text-body hover:bg-warm-bg/60"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------- Gmail connection card ---------------- */
// Shown when no mailbox is connected: one "Connect email" button that reveals a
// Gmail / Outlook choice, instead of two separate provider cards.
function ConnectEmailCard({
  note,
  onConnectGmail,
  onConnectOutlook,
}: {
  note: string;
  onConnectGmail: () => void;
  onConnectOutlook: () => void;
}) {
  const [choosing, setChoosing] = useState(false);
  return (
    <section className="mt-5 rounded-3xl border border-warm-border bg-surface p-6 shadow-soft sm:p-8">
      <div className="flex flex-wrap items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-warm-bg">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="text-accent">
            <rect x="3" y="5" width="18" height="14" rx="2" />
            <path d="m3 7 9 6 9-6" />
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-bold text-ink">Send from your email</div>
          <p className="mt-0.5 text-sm leading-relaxed text-body">
            Connect your email so Scout can put a ready-to-go draft in your inbox, or
            send it for you, straight from your own address.
          </p>
        </div>
        {choosing ? (
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={onConnectGmail}
              className="rounded-xl bg-brand-gradient px-4 py-2.5 text-sm font-bold text-white shadow-soft transition hover:opacity-95"
            >
              Gmail
            </button>
            <button
              onClick={onConnectOutlook}
              className="rounded-xl bg-brand-gradient px-4 py-2.5 text-sm font-bold text-white shadow-soft transition hover:opacity-95"
            >
              Outlook
            </button>
            <button
              onClick={() => setChoosing(false)}
              className="text-xs font-semibold text-body/50 transition hover:text-accent"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => setChoosing(true)}
            className="rounded-xl bg-brand-gradient px-5 py-2.5 text-sm font-bold text-white shadow-soft transition hover:opacity-95"
          >
            Connect email
          </button>
        )}
      </div>
      {choosing && (
        <p className="mt-3 text-xs text-body/60">Which email provider do you use?</p>
      )}
      {note && (
        <div className="mt-4 rounded-xl border border-warm-border bg-warm-bg/70 px-4 py-2.5 text-xs font-medium text-ink">
          {note}
        </div>
      )}
    </section>
  );
}

function MailboxCard({
  provider,
  conn,
  note,
  onConnect,
  onDisconnect,
  onMode,
}: {
  provider: "gmail" | "outlook";
  conn: { connected: boolean; email?: string; sendMode?: "draft" | "send" };
  note: string;
  onConnect: () => void;
  onDisconnect: () => void;
  onMode: (mode: "draft" | "send") => void;
}) {
  const label = provider === "gmail" ? "Gmail" : "Outlook";
  const mode = conn.sendMode || "draft";
  return (
    <section className="mt-5 rounded-3xl border border-warm-border bg-surface p-6 shadow-soft sm:p-8">
      <div className="flex flex-wrap items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-warm-bg">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="text-accent">
            <rect x="3" y="5" width="18" height="14" rx="2" />
            <path d="m3 7 9 6 9-6" />
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-bold text-ink">Send from {label}</div>
          {conn.connected ? (
            <p className="mt-0.5 text-sm text-body">
              Connected as{" "}
              <span className="font-semibold text-ink">{conn.email || `your ${label}`}</span>
              . Your messages go out from your own address.
            </p>
          ) : (
            <p className="mt-0.5 text-sm leading-relaxed text-body">
              Connect {label} so Scout can put a ready-to-go draft in your inbox, or send
              it for you, straight from your own address.
            </p>
          )}
        </div>
        {conn.connected ? (
          <button
            onClick={onDisconnect}
            className="rounded-lg border border-warm-border px-3 py-1.5 text-xs font-semibold text-body transition hover:bg-warm-bg"
          >
            Disconnect
          </button>
        ) : (
          <button
            onClick={onConnect}
            className="rounded-xl bg-brand-gradient px-5 py-2.5 text-sm font-bold text-white shadow-soft transition hover:opacity-95"
          >
            Connect {label}
          </button>
        )}
      </div>

      {conn.connected && (
        <div className="mt-5 border-t border-warm-border pt-5">
          <Label>When you use a draft</Label>
          <div className="mt-1 grid gap-2.5 sm:grid-cols-2">
            {(
              [
                {
                  key: "draft",
                  title: "Create a draft I review",
                  body: `Scout puts the message in your ${label} drafts. You open it and hit send.`,
                },
                {
                  key: "send",
                  title: "Send automatically",
                  body: "Scout sends the message from your address right away. No review step.",
                },
              ] as const
            ).map((opt) => {
              const on = mode === opt.key;
              return (
                <button
                  key={opt.key}
                  onClick={() => onMode(opt.key)}
                  className={`rounded-2xl border p-4 text-left transition ${
                    on
                      ? "border-coral/50 bg-warm-bg/60 ring-2 ring-coral/15"
                      : "border-warm-border bg-surface hover:bg-warm-bg/30"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`flex h-4 w-4 items-center justify-center rounded-full border ${
                        on ? "border-coral bg-coral" : "border-warm-border"
                      }`}
                    >
                      {on && <span className="h-1.5 w-1.5 rounded-full bg-surface" />}
                    </span>
                    <span className="text-sm font-bold text-ink">{opt.title}</span>
                  </div>
                  <p className="mt-1.5 text-xs leading-relaxed text-body/80">{opt.body}</p>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {note && (
        <div className="mt-4 rounded-xl border border-warm-border bg-warm-bg/70 px-4 py-2.5 text-xs font-medium text-ink">
          {note}
        </div>
      )}
    </section>
  );
}

/* ---------------- Profile tab ---------------- */
function ProfileTab({
  name,
  bio,
  linkedin,
  useCase,
  age,
  college,
  location,
  companySize,
  competitiveness,
  onName,
  onBio,
  onLinkedin,
  onAge,
  onCollege,
  onLocation,
  onCompanySize,
  onCompetitiveness,
  onUseCase,
  onAutofill,
  canConfirm,
  onConfirm,
  mailboxAvailable,
  gmail,
  gmailNote,
  onConnectGmail,
  onDisconnectGmail,
  onGmailMode,
  outlook,
  outlookNote,
  onConnectOutlook,
  onDisconnectOutlook,
  onOutlookMode,
  projects,
  categories,
  onAddProject,
  onRenameProject,
  onRemoveProject,
  onAddCategory,
  onRenameCategory,
  onRemoveCategory,
  onRemoveCategories,
  onReorderCategories,
  onDeriveGoal,
  resumeFileName,
  onResumeFile,
  onClearResume,
  signature,
  onSignature,
  onImport,
}: {
  name: string;
  bio: string;
  linkedin: string;
  useCase: string;
  age?: number;
  college: string;
  location: string;
  companySize: CompanySize;
  competitiveness: Competitiveness;
  onName: (v: string) => void;
  onBio: (v: string) => void;
  onLinkedin: (v: string) => void;
  onAge: (v: number | undefined) => void;
  onCollege: (v: string) => void;
  onLocation: (v: string) => void;
  onCompanySize: (v: CompanySize) => void;
  onCompetitiveness: (v: Competitiveness) => void;
  onUseCase: (v: string) => void;
  onAutofill: (
    name?: string,
    useCase?: string,
    extras?: {
      age?: number | null;
      education?: string;
      location?: string;
      companySize?: string;
      competitiveness?: string;
    }
  ) => void;
  canConfirm: boolean;
  onConfirm: () => void;
  mailboxAvailable: boolean;
  gmail: { connected: boolean; email?: string; sendMode?: "draft" | "send" };
  gmailNote: string;
  onConnectGmail: () => void;
  onDisconnectGmail: () => void;
  onGmailMode: (mode: "draft" | "send") => void;
  outlook: { connected: boolean; email?: string; sendMode?: "draft" | "send" };
  outlookNote: string;
  onConnectOutlook: () => void;
  onDisconnectOutlook: () => void;
  onOutlookMode: (mode: "draft" | "send") => void;
  projects: Project[];
  categories: Category[];
  onAddProject: (name: string) => void;
  onRenameProject: (id: string, name: string) => void;
  onRemoveProject: (id: string) => void;
  onAddCategory: (projectId: string, name: string, goal?: string) => void;
  onRenameCategory: (id: string, name: string) => void;
  onRemoveCategory: (id: string) => void;
  onRemoveCategories: (ids: string[]) => void;
  onReorderCategories: (projectId: string, orderedIds: string[]) => void;
  onDeriveGoal: (name: string, useCase: string) => Promise<string>;
  resumeFileName: string;
  onResumeFile: (file: File) => void;
  onClearResume: () => void;
  signature: string;
  onSignature: (v: string) => void;
  onImport: () => void;
}) {
  const [parsing, setParsing] = useState(false);
  const [autofilled, setAutofilled] = useState(false);
  const [note, setNote] = useState("");
  const [buildingSig, setBuildingSig] = useState(false);
  // Whether to show the job-applicant follow-ups (company size + competitive-
  // ness). Defaults to true when the user's use case looks job-shaped OR when
  // they've already set either field to a non-default value on a previous
  // visit — so we don't hide answers they already picked.
  const [jobApplicant, setJobApplicant] = useState<boolean>(
    isJobUseCaseClient(useCase) ||
      (!!companySize && companySize !== "any") ||
      (!!competitiveness && competitiveness !== "any")
  );
  // Build an email signature from the resume/bio text (explicit, overwrites the
  // current one; the user can edit after).
  async function buildSignatureFromResume() {
    const t = bio.trim();
    if (!t || buildingSig) return;
    setBuildingSig(true);
    try {
      const res = await fetch("/api/parse-profile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: t }),
      });
      const data = await res.json();
      if (res.ok && data.signature) onSignature(data.signature);
    } catch {}
    finally {
      setBuildingSig(false);
    }
  }
  // Individual vs company changes how you fill your profile (resume vs website).
  const [kind, setKind] = useState<"individual" | "company">("individual");
  const [website, setWebsite] = useState("");
  useEffect(() => {
    try {
      const k = localStorage.getItem(KIND_KEY);
      if (k === "company" || k === "individual") setKind(k);
    } catch {}
  }, []);
  function chooseKind(k: "individual" | "company") {
    setKind(k);
    try {
      localStorage.setItem(KIND_KEY, k);
    } catch {}
  }

  // Read some source text (a resume, a LinkedIn PDF/About section, a bio) and let
  // Scout fill in name + use case from it. keepBio=false when the text is already
  // in the bio box (the "read this" button), so we don't stomp the user's edits.
  async function readAndFill(text: string, keepBio = true) {
    const t = (text || "").trim();
    if (!t) return;
    if (keepBio) onBio(t);
    setNote("");
    setAutofilled(false);
    setParsing(true);
    try {
      const res = await fetch("/api/parse-profile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: t }),
      });
      const data = await res.json();
      // Build a signature from the resume, but only if the user hasn't set one
      // (never clobber an edited signature).
      if (res.ok && data.signature && !signature.trim()) onSignature(data.signature);
      const hasExtras =
        data &&
        (data.age != null ||
          !!String(data.education || "").trim() ||
          !!String(data.location || "").trim() ||
          !!String(data.companySize || "").trim() ||
          !!String(data.competitiveness || "").trim());
      if (res.ok && (data.name || data.useCase || hasExtras)) {
        onAutofill(data.name, data.useCase, {
          age: typeof data.age === "number" ? data.age : null,
          education: data.education || "",
          location: data.location || "",
          companySize: data.companySize || "",
          competitiveness: data.competitiveness || "",
        });
        setAutofilled(true);
        setNote("Scout filled these in for you. Edit anything that's off.");
      } else if (res.ok) {
        setNote("Saved it below. Add your name and use case to finish.");
      } else {
        setNote(data?.error || "Couldn't read that. Add your details below.");
      }
    } catch {
      setNote("Saved it below. Add your name and use case to finish.");
    } finally {
      setParsing(false);
    }
  }

  // Fetch a company website and fill the profile from it.
  async function readWebsite() {
    const u = website.trim();
    if (!u) return;
    setNote("");
    setAutofilled(false);
    setParsing(true);
    try {
      const res = await fetch("/api/read-website", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: u }),
      });
      const data = await res.json();
      if (res.ok && data.text) {
        await readAndFill(`Website: ${data.url || u}\n\n${data.text}`);
      } else {
        setNote(data?.error || "Couldn't read that site. Paste your info below instead.");
        setParsing(false);
      }
    } catch {
      setNote("Couldn't read that site. Paste your info below instead.");
      setParsing(false);
    }
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight text-ink">
        Your <span className="brand-text">profile</span>
      </h1>
      <p className="mt-2 text-[15px] leading-relaxed text-body">
        Drop in your resume, LinkedIn, or company website and Scout fills the rest
        for you. Everything stays editable, and it shapes who we find and how your
        messages sound.
      </p>

      {/* -------- Import your existing outreach (dedup + learn) -------- */}
      <section className="mt-6 flex flex-wrap items-center gap-3 rounded-2xl border border-warm-border bg-surface p-4 shadow-card">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brown-tint text-brown-deep">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M7 10l5 5 5-5" /><path d="M12 15V3" /></svg>
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-extrabold text-ink">
            Already reaching out somewhere else?
          </div>
          <p className="mt-0.5 text-xs leading-relaxed text-body/80">
            Drop in a CSV of how you've been tracking your contacts. Scout won't
            resurface them and starts learning what a fit looks like for you.
          </p>
        </div>
        <button
          onClick={onImport}
          className="shrink-0 rounded-xl bg-brown px-4 py-2 text-xs font-bold text-white shadow-soft transition hover:opacity-90"
        >
          Import a CSV
        </button>
      </section>

      {mailboxAvailable && (
        <>
          {/* Neither connected: one "Connect email" card that lets you choose. Once a
              mailbox is connected, its own card shows (with send mode + disconnect). */}
          {!gmail.connected && !outlook.connected && (
            <ConnectEmailCard
              note={gmailNote || outlookNote}
              onConnectGmail={onConnectGmail}
              onConnectOutlook={onConnectOutlook}
            />
          )}
          {gmail.connected && (
            <MailboxCard
              provider="gmail"
              conn={gmail}
              note={gmailNote}
              onConnect={onConnectGmail}
              onDisconnect={onDisconnectGmail}
              onMode={onGmailMode}
            />
          )}
          {outlook.connected && (
            <MailboxCard
              provider="outlook"
              conn={outlook}
              note={outlookNote}
              onConnect={onConnectOutlook}
              onDisconnect={onDisconnectOutlook}
              onMode={onOutlookMode}
            />
          )}
        </>
      )}

      <FadeIn as="section" className="mt-7 rounded-3xl border border-warm-border bg-surface p-6 shadow-soft sm:p-8">
        {/* -------- Individual vs company: resume drop or website -------- */}
        <div className="mb-4 inline-flex rounded-xl border border-warm-border bg-warm-bg/40 p-1">
          {(["individual", "company"] as const).map((k) => (
            <button
              key={k}
              onClick={() => chooseKind(k)}
              className={`rounded-lg px-3.5 py-1.5 text-xs font-semibold transition ${
                kind === k
                  ? "bg-surface text-ink shadow-card"
                  : "text-body/60 hover:text-ink"
              }`}
            >
              {k === "individual" ? "I'm an individual" : "I'm a company"}
            </button>
          ))}
        </div>

        <Label>
          {kind === "company"
            ? "Start with your website"
            : "Start with your resume or LinkedIn"}
        </Label>

        {kind === "company" ? (
          <div className="flex flex-wrap gap-2">
            <input
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  readWebsite();
                }
              }}
              placeholder="yourcompany.com"
              className="min-w-[220px] flex-1 rounded-xl border border-warm-border px-3.5 py-3 text-sm text-ink outline-none transition focus:border-coral focus:ring-4 focus:ring-coral/15"
            />
            <button
              onClick={readWebsite}
              disabled={parsing || !website.trim()}
              className="rounded-xl bg-brand-gradient px-5 py-3 text-sm font-bold text-white shadow-soft transition hover:opacity-95 disabled:opacity-50"
            >
              {parsing ? "Reading…" : "Read my website"}
            </button>
          </div>
        ) : (
          <FileDrop
            label={
              parsing
                ? "Reading and filling in your Profile…"
                : "Drop your resume or LinkedIn here, or click to upload"
            }
            accept=".pdf,.docx,.html,.htm,.txt,.md,.jpg,.jpeg,.png,.webp"
            hint="PDF, image (JPG/PNG), Word (.docx), HTML, or text"
            onText={(t) => readAndFill(t)}
            onFile={(f) => onResumeFile(f)}
          />
        )}

        {/* Resume kept for email attachments */}
        {resumeFileName && (
          <div className="mt-2 flex flex-wrap items-center gap-2 rounded-xl border border-sage/40 bg-sage/10 px-3 py-2 text-xs text-brown-deep">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M21.4 11.05 12.25 20.2a5 5 0 0 1-7.07-7.07l9.19-9.19a3 3 0 0 1 4.24 4.24l-9.2 9.19a1 1 0 0 1-1.41-1.41l8.48-8.49" /></svg>
            <span className="font-semibold">{resumeFileName}</span>
            <span className="text-body/70">saved to attach to emails when you choose</span>
            <button
              onClick={onClearResume}
              className="ml-auto font-semibold text-body/50 transition hover:text-accent"
            >
              Remove
            </button>
          </div>
        )}

        <p className="mt-2 text-xs leading-relaxed text-body/70">
          {kind === "company" ? (
            <>
              Scout reads your site and fills in your company name, what you do, and
              your background below. You can still paste anything into the box lower
              down.
            </>
          ) : (
            <>
              Scout reads it and fills in your name, use case, and background below.{" "}
              <span className="font-semibold text-body">From LinkedIn:</span> open your
              profile, tap{" "}
              <span className="font-semibold text-body">More → Save to PDF</span>, and
              drop that file here. (LinkedIn blocks apps from reading your profile from
              just a link, so this is the reliable way in.)
            </>
          )}
        </p>
        {parsing && (
          <div className="mt-3 flex items-center gap-2 text-xs font-semibold text-accent">
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-warm-border border-t-coral" />
            Reading your resume and filling in your Profile…
          </div>
        )}
        {note && !parsing && (
          <div
            className={`mt-3 rounded-xl px-4 py-2.5 text-xs font-medium ${
              autofilled
                ? "border border-warm-border bg-warm-bg/70 text-ink"
                : "border border-warm-border bg-surface text-body"
            }`}
          >
            {note}
          </div>
        )}

        <hr className="my-7 border-warm-border" />

        <Label>What are you using Scout for?</Label>
        <UseCaseCombo value={useCase} onChange={onUseCase} />
        <p className="mt-2 text-xs leading-relaxed text-body/70">
          Type anything: a job hunt, press for a product, investors, mentors, partners.
          Pick a suggestion if one fits, or just describe it in your own words and Scout
          will figure out who to look for. Manage your categories in the editor below.
        </p>

        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <div>
            <Label>Your name or company</Label>
            <input
              value={name}
              onChange={(e) => onName(e.target.value)}
              placeholder="e.g. Alex Rivera, or Acme Studio"
              className="w-full rounded-xl border border-warm-border px-3.5 py-3 text-sm text-ink outline-none transition focus:border-coral focus:ring-4 focus:ring-coral/15"
            />
          </div>
          <div>
            <Label>Your LinkedIn (optional)</Label>
            <input
              value={linkedin}
              onChange={(e) => onLinkedin(e.target.value)}
              placeholder="linkedin.com/in/yourname"
              className="w-full rounded-xl border border-warm-border px-3.5 py-3 text-sm text-ink outline-none transition focus:border-coral focus:ring-4 focus:ring-coral/15"
            />
            <p className="mt-1.5 text-xs leading-relaxed text-body/60">
              Saved to your Profile and used to personalize outreach. To fill your
              profile <span className="font-semibold">from</span> LinkedIn, upload your
              LinkedIn PDF above or paste your About section below.
            </p>
          </div>
        </div>

        {/* -------- About you: personalization Scout weaves into search + drafts -------- */}
        <div className="mt-7 rounded-2xl border border-warm-border bg-warm-bg/40 p-5">
          <div className="mb-3">
            <h3 className="text-sm font-extrabold tracking-tight text-ink">About you</h3>
            <p className="mt-0.5 text-xs leading-relaxed text-body/70">
              Optional. Scout uses these to match you with the right opportunities
              and to sound like you in outreach.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <Label>Age</Label>
              <input
                type="number"
                inputMode="numeric"
                min={13}
                max={100}
                value={age ?? ""}
                onChange={(e) => {
                  const v = e.target.value.trim();
                  onAge(v === "" ? undefined : Number(v));
                }}
                placeholder="e.g. 20"
                className="w-full rounded-xl border border-warm-border px-3.5 py-3 text-sm text-ink outline-none transition focus:border-coral focus:ring-4 focus:ring-coral/15"
              />
            </div>
            <div>
              <Label>School or education</Label>
              <input
                value={college}
                onChange={(e) => onCollege(e.target.value)}
                placeholder="e.g. USC junior, MFA 2022, self-taught"
                className="w-full rounded-xl border border-warm-border px-3.5 py-3 text-sm text-ink outline-none transition focus:border-coral focus:ring-4 focus:ring-coral/15"
              />
            </div>
            <div>
              <Label>Location</Label>
              <input
                value={location}
                onChange={(e) => onLocation(e.target.value)}
                placeholder="e.g. Los Angeles, CA"
                className="w-full rounded-xl border border-warm-border px-3.5 py-3 text-sm text-ink outline-none transition focus:border-coral focus:ring-4 focus:ring-coral/15"
              />
            </div>
          </div>

          <div className="mt-5">
            <Label>Are you applying to jobs or internships?</Label>
            <div className="inline-flex flex-wrap gap-1 rounded-xl border border-warm-border bg-surface p-1">
              {(
                [
                  ["yes", "Yes"],
                  ["no", "No"],
                ] as const
              ).map(([val, label]) => (
                <button
                  key={val}
                  onClick={() => setJobApplicant(val === "yes")}
                  className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                    jobApplicant === (val === "yes")
                      ? "bg-brown text-white shadow-soft"
                      : "text-body/70 hover:text-ink"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-xs leading-relaxed text-body/70">
              Answering Yes shows two extra questions Scout uses to tune what
              opportunities to surface for you.
            </p>
          </div>

          {jobApplicant && (
            <div className="mt-5 grid gap-5 sm:grid-cols-2">
              <div>
                <Label>Company size you want</Label>
                <div className="inline-flex flex-wrap gap-1 rounded-xl border border-warm-border bg-surface p-1">
                  {(
                    [
                      ["any", "Any"],
                      ["small", "Small / startup"],
                      ["big", "Big / established"],
                    ] as const
                  ).map(([val, label]) => (
                    <button
                      key={val}
                      onClick={() => onCompanySize(val)}
                      className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                        companySize === val
                          ? "bg-brown text-white shadow-soft"
                          : "text-body/70 hover:text-ink"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <Label>Competitiveness</Label>
                <div className="inline-flex flex-wrap gap-1 rounded-xl border border-warm-border bg-surface p-1">
                  {(
                    [
                      ["any", "Any"],
                      ["beginner", "Beginner"],
                      ["intermediate", "Intermediate"],
                      ["competitive", "Competitive"],
                    ] as const
                  ).map(([val, label]) => (
                    <button
                      key={val}
                      onClick={() => onCompetitiveness(val)}
                      className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                        competitiveness === val
                          ? "bg-brown text-white shadow-soft"
                          : "text-body/70 hover:text-ink"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-body/70">
                  First-time applicant? Pick <span className="font-semibold">Beginner</span> —
                  Scout will skip the ultra-selective programs and surface ones you can
                  realistically land.
                </p>
              </div>
            </div>
          )}
        </div>

        <div className="mt-5">
          <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
            <Label className="mb-0">Resume, LinkedIn, or bio</Label>
            <div className="flex items-center gap-1.5">
              <MicButton onAppend={(t) => onBio(joinSpoken(bio, t))} />
              <button
                onClick={() => readAndFill(bio, false)}
                disabled={!bio.trim() || parsing}
                className="rounded-lg border border-warm-border px-3 py-1.5 text-xs font-semibold text-accent transition hover:bg-warm-bg disabled:opacity-40"
              >
                {parsing ? "Reading…" : "Read this & fill in my profile"}
              </button>
            </div>
          </div>
          <textarea
            value={bio}
            onChange={(e) => onBio(e.target.value)}
            onPaste={(e) => {
              // Pasting a resume / bio / About section auto-fills your name and
              // use case, no button needed. Only for a substantial paste, so a
              // stray word or URL doesn't kick off a parse.
              const pasted = (e.clipboardData?.getData("text") || "")
                .replace(/\s+/g, " ")
                .trim();
              if (parsing || pasted.length < 120) return;
              const el = e.currentTarget;
              // Let the paste land in the box (onChange updates bio), then parse
              // the full contents without re-setting the bio we just updated.
              setTimeout(() => readAndFill(el.value, false), 0);
            }}
            rows={11}
            placeholder="Your resume text appears here after you upload it, or paste anything that tells us who you are: your LinkedIn About section, a short bio, your company's about page, your experience. Paste it and Scout fills your name and use case in automatically. The more you give, the more personal your outreach becomes."
            className="w-full resize-y rounded-xl border border-warm-border px-3.5 py-3 text-sm leading-relaxed text-ink outline-none transition focus:border-coral focus:ring-4 focus:ring-coral/15"
          />
        </div>

        {/* -------- Email signature -------- */}
        <div className="mt-5">
          <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
            <Label className="mb-0">Email signature</Label>
            <button
              onClick={buildSignatureFromResume}
              disabled={!bio.trim() || buildingSig}
              title="Build a signature from your resume / bio (you can edit it after)"
              className="rounded-lg border border-warm-border px-3 py-1.5 text-xs font-semibold text-accent transition hover:bg-warm-bg disabled:opacity-40"
            >
              {buildingSig
                ? "Building…"
                : signature.trim()
                ? "Rebuild from resume"
                : "Build from my resume"}
            </button>
          </div>
          <textarea
            value={signature}
            onChange={(e) => onSignature(e.target.value)}
            rows={4}
            placeholder={"e.g.\nAlex Rivera\nMarketing Manager, Acme Studio\nalex@acmestudio.com · (555) 010-0142"}
            className="w-full resize-y rounded-xl border border-warm-border px-3.5 py-3 text-sm leading-relaxed text-ink outline-none transition focus:border-coral focus:ring-4 focus:ring-coral/15"
          />
          <p className="mt-1.5 text-xs leading-relaxed text-body/70">
            Added to the end of every email Scout drafts for you. Build it from your
            resume above, then edit freely. Leave blank to let Scout sign off with just
            your name. Only used on emails, not DMs.
          </p>
        </div>

        <hr className="my-7 border-warm-border" />

        {/* -------- Projects & categories, editable here as well as on Outreach -------- */}
        <ProjectsCategoriesEditor
          projects={projects}
          categories={categories}
          onAddProject={onAddProject}
          onRenameProject={onRenameProject}
          onRemoveProject={onRemoveProject}
          onAddCategory={onAddCategory}
          onRenameCategory={onRenameCategory}
          onRemoveCategory={onRemoveCategory}
          onRemoveCategories={onRemoveCategories}
          onReorderCategories={onReorderCategories}
          onDeriveGoal={onDeriveGoal}
        />

        <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-warm-border pt-6">
          <button
            onClick={onConfirm}
            disabled={!canConfirm}
            className="rounded-xl bg-brand-gradient px-6 py-3 text-sm font-bold text-white shadow-soft transition hover:opacity-95 disabled:opacity-50"
          >
            Save &amp; start scouting
          </button>
          <span className="text-xs text-body/70">
            {canConfirm
              ? "Saved automatically to your account. This is only visible to you."
              : "Add your name to continue. A resume or bio is optional, it just makes messages more personal."}
          </span>
        </div>
      </FadeIn>
    </main>
  );
}

/* ---------------- Account section (login info, password, delete) ---------------- */
function AccountCard({
  email,
  busy,
  note,
  onChangePassword,
  onDeleteAccount,
  onLogout,
}: {
  email: string;
  busy: string;
  note: string;
  onChangePassword: (pw: string) => void;
  onDeleteAccount: () => void;
  onLogout?: () => void;
}) {
  const [pw, setPw] = useState("");
  const [confirming, setConfirming] = useState(false);

  return (
    <section className="mt-7 rounded-3xl border border-warm-border bg-surface p-6 shadow-soft sm:p-8">
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-warm-border bg-warm-bg/40 px-4 py-3">
        <div className="min-w-0">
          <div className="text-[11px] font-bold uppercase tracking-wider text-body/60">
            Signed in as
          </div>
          <div className="truncate text-sm font-semibold text-ink">{email}</div>
        </div>
        {onLogout && (
          <button
            onClick={onLogout}
            className="ml-auto rounded-lg border border-warm-border px-3 py-1.5 text-xs font-semibold text-body transition hover:bg-warm-bg"
          >
            Log out
          </button>
        )}
      </div>

      {/* Change password */}
      <div className="mt-5">
        <Label>Change password</Label>
        <div className="flex flex-wrap gap-2">
          <input
            type="password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            placeholder="New password (min 6 characters)"
            className="min-w-[220px] flex-1 rounded-xl border border-warm-border px-3.5 py-2.5 text-sm text-ink outline-none transition focus:border-coral focus:ring-4 focus:ring-coral/15"
          />
          <button
            onClick={() => {
              onChangePassword(pw);
              setPw("");
            }}
            disabled={busy === "password" || pw.length < 6}
            className="rounded-xl border border-warm-border px-4 py-2.5 text-sm font-semibold text-body transition hover:bg-warm-bg disabled:opacity-50"
          >
            {busy === "password" ? "Updating…" : "Update"}
          </button>
        </div>
      </div>

      {note && (
        <div className="mt-3 rounded-xl border border-warm-border bg-warm-bg/70 px-4 py-2.5 text-xs font-medium text-ink">
          {note}
        </div>
      )}

      {/* Delete account */}
      <div className="mt-6 border-t border-warm-border pt-5">
        <div className="text-sm font-bold text-ink">Delete account</div>
        <p className="mt-1 text-xs leading-relaxed text-body/70">
          Permanently removes your account, profile, projects, finds, and any
          connected email. This can&apos;t be undone.
        </p>
        {confirming ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-accent">
              Really delete everything?
            </span>
            <button
              onClick={onDeleteAccount}
              disabled={busy === "delete"}
              className="rounded-lg bg-red-600 px-3.5 py-1.5 text-xs font-bold text-white transition hover:bg-red-700 disabled:opacity-50"
            >
              {busy === "delete" ? "Deleting…" : "Yes, delete my account"}
            </button>
            <button
              onClick={() => setConfirming(false)}
              className="rounded-lg border border-warm-border px-3.5 py-1.5 text-xs font-semibold text-body transition hover:bg-warm-bg"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirming(true)}
            className="mt-3 rounded-lg border border-red-200 px-3.5 py-1.5 text-xs font-bold text-red-600 transition hover:bg-red-50"
          >
            Delete my account
          </button>
        )}
      </div>
    </section>
  );
}

/* ---------------- Reusable file drop (resume, cover letters) ---------------- */
// Append spoken text to an existing value with sensible spacing.
function joinSpoken(prev: string, add: string): string {
  const a = String(prev || "");
  const b = String(add || "").trim();
  if (!b) return a;
  return (a && !/\s$/.test(a) ? a + " " : a) + b;
}

// Voice dictation button using the browser's built-in Web Speech API (no external
// service). Renders nothing on browsers that don't support it. Calls onAppend with
// each finalized phrase so the caller can add it to a text field.
function MicButton({
  onAppend,
  className = "",
}: {
  onAppend: (text: string) => void;
  className?: string;
}) {
  const [listening, setListening] = useState(false);
  const [supported, setSupported] = useState(false);
  const recRef = useRef<any>(null);

  useEffect(() => {
    const SR =
      typeof window !== "undefined" &&
      ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
    setSupported(!!SR);
    return () => {
      try {
        recRef.current?.stop();
      } catch {}
    };
  }, []);

  function start() {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return;
    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = false; // append only finalized phrases, once each
    rec.lang = "en-US";
    rec.onresult = (e: any) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal && r[0]?.transcript) onAppend(r[0].transcript.trim());
      }
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recRef.current = rec;
    try {
      rec.start();
      setListening(true);
    } catch {}
  }
  function stop() {
    try {
      recRef.current?.stop();
    } catch {}
    setListening(false);
  }

  if (!supported) return null;
  return (
    <button
      type="button"
      onClick={() => (listening ? stop() : start())}
      title={listening ? "Stop dictation" : "Dictate with your voice"}
      aria-label={listening ? "Stop dictation" : "Dictate with your voice"}
      aria-pressed={listening}
      className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-semibold transition ${
        listening
          ? "border-coral bg-coral/10 text-accent"
          : "border-warm-border text-body/70 hover:bg-warm-bg"
      } ${className}`}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={listening ? "animate-pulse" : ""}
      >
        <rect x="9" y="2" width="6" height="12" rx="3" />
        <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
      </svg>
      {listening ? "Listening…" : "Dictate"}
    </button>
  );
}

function FileDrop({
  onText,
  onFile,
  label = "Drop a file here, or click to upload",
  accept = ".pdf,.docx,.html,.htm,.txt,.md",
  hint = "PDF, Word (.docx), HTML, or text file",
}: {
  onText: (text: string) => void;
  onFile?: (file: File) => void; // also hand back the raw file (e.g. to attach later)
  label?: string;
  accept?: string;
  hint?: string;
}) {
  const [reading, setReading] = useState(false);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  async function handle(file?: File | null) {
    if (!file) return;
    setErr("");
    setNote("");
    setReading(true);
    try {
      if (onFile) onFile(file);
      // Images (jpg/png/etc.) can be attached but not read for text (no OCR).
      const isImage =
        file.type.startsWith("image/") || /\.(jpe?g|png|webp|heic|gif)$/i.test(file.name);
      if (isImage) {
        if (onFile) setNote(`Saved “${file.name}” to attach to your emails.`);
        else setErr("That's an image, which can't be read as text. Upload a PDF or paste the text.");
        return;
      }
      const text = await fileToText(file);
      if (text) onText(text);
      else setErr("That file had no readable text, try pasting it instead.");
    } catch (e: any) {
      setErr(e?.message || "Couldn't read that file.");
    } finally {
      setReading(false);
    }
  }

  return (
    <div
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        handle(e.dataTransfer.files?.[0]);
      }}
      onClick={() => inputRef.current?.click()}
      className="cursor-pointer rounded-xl border border-dashed border-warm-border bg-warm-bg/40 px-4 py-5 text-center transition hover:border-coral/40 hover:bg-warm-bg/70"
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => handle(e.target.files?.[0])}
      />
      <div className="text-sm font-semibold text-ink">
        {reading ? "Reading…" : label}
      </div>
      <div className="mt-0.5 text-xs text-body/70">{hint}</div>
      {note && <div className="mt-1.5 text-xs font-semibold text-sage">{note}</div>}
      {err && <div className="mt-1.5 text-xs font-semibold text-accent">{err}</div>}
    </div>
  );
}

/* ---------------- Profile gate (shown until a profile exists) ---------------- */
function ProfileGate({ onSetup }: { onSetup: () => void }) {
  return (
    <section className="mt-6 rounded-3xl border border-warm-border bg-surface p-8 text-center shadow-soft sm:p-12">
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-gradient">
        <svg
          width="26"
          height="26"
          viewBox="0 0 24 24"
          fill="none"
          stroke="white"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <circle cx="12" cy="8" r="3.5" />
          <path d="M5 20a7 7 0 0 1 14 0" />
        </svg>
      </div>
      <h2 className="mt-5 text-2xl font-extrabold tracking-tight text-ink">
        First, tell <span className="brand-text">Scout</span> who you are
      </h2>
      <p className="mx-auto mt-2.5 max-w-md text-[15px] leading-relaxed text-body">
        Just your name is enough to start. Adding a resume, LinkedIn, or website is
        optional, it only makes your messages more personal.
      </p>
      <button
        onClick={onSetup}
        className="mt-6 rounded-xl bg-brand-gradient px-7 py-3.5 text-sm font-bold text-white shadow-soft transition hover:opacity-95"
      >
        Set up your Profile
      </button>
      <div className="mx-auto mt-7 flex max-w-md flex-wrap justify-center gap-2">
        {["Add your name", "Resume or website (optional)", "Start scouting"].map(
          (s, i) => (
            <span
              key={s}
              className="rounded-full border border-warm-border bg-warm-bg/60 px-3 py-1 text-xs font-medium text-body"
            >
              {i + 1}. {s}
            </span>
          )
        )}
      </div>
    </section>
  );
}

/* ---------------- Small UI bits ---------------- */
function Label({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label
      className={`mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-body/60 ${className}`}
    >
      {children}
    </label>
  );
}

function Count({ n }: { n: number }) {
  return (
    <span className="ml-1.5 rounded-full bg-brand-gradient px-1.5 py-0.5 text-[10px] font-bold text-white">
      {n}
    </span>
  );
}
function Dot() {
  return (
    <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-brand-gradient align-middle" />
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="relative -mb-px px-1 pb-3 pt-1 text-sm font-bold transition"
    >
      <span className={active ? "text-ink" : "text-body/50 hover:text-body"}>
        {children}
      </span>
      {active && (
        <span className="absolute inset-x-0 -bottom-px h-[3px] rounded-full bg-brand-gradient" />
      )}
    </button>
  );
}

function Step({
  n,
  title,
  body,
  icon,
}: {
  n: string;
  title: string;
  body: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-warm-border bg-surface p-5 shadow-card">
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-gradient text-white">
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {icon}
          </svg>
        </span>
        <span className="text-xs font-bold uppercase tracking-wider text-accent">
          Step {n}
        </span>
      </div>
      <h3 className="mt-3 text-[15px] font-bold text-ink">{title}</h3>
      <p className="mt-1.5 text-[13px] leading-relaxed text-body">{body}</p>
    </div>
  );
}

function Tail({ side }: { side: "left" | "right" }) {
  return (
    <span
      aria-hidden
      className={`absolute top-4 h-3.5 w-3.5 rotate-45 bg-surface ${
        side === "left"
          ? "-left-[7px] border-b border-l border-warm-border"
          : "-right-[7px] border-r border-t border-warm-border"
      }`}
    />
  );
}

function Avatar() {
  return (
    <span className="mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-gradient">
      <Logo white />
    </span>
  );
}

function WarnIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#b45309"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="mt-0.5 shrink-0"
    >
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4 M12 17h.01" />
    </svg>
  );
}

/* ---------------- List manager (pencil popover: add / rename / remove) ---------------- */
// One project's categories: drag to reorder, click to multi-select and delete,
// rename inline, and add your own (suggestions + free text, with the goal the
// search will use derived so the API understands what to look for).
function ProjectCategoryList({
  project,
  cats,
  onRename,
  onRemoveMany,
  onReorder,
  onAdd,
  onDeriveGoal,
}: {
  project: Project;
  cats: Category[];
  onRename: (id: string, name: string) => void;
  onRemoveMany: (ids: string[]) => void;
  onReorder: (orderedIds: string[]) => void;
  onAdd: (name: string, goal?: string) => void;
  onDeriveGoal: (name: string, useCase: string) => Promise<string>;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dragId, setDragId] = useState("");
  const [overId, setOverId] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [addText, setAddText] = useState("");
  const [deriving, setDeriving] = useState(false);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  const deleteSelected = () => {
    onRemoveMany([...selected]);
    setSelected(new Set());
  };
  const drop = (targetId: string) => {
    if (dragId && dragId !== targetId) {
      const order = cats.map((c) => c.id).filter((id) => id !== dragId);
      const at = order.indexOf(targetId);
      order.splice(at < 0 ? order.length : at, 0, dragId);
      onReorder(order);
    }
    setDragId("");
    setOverId("");
  };
  const submitFree = async () => {
    const name = addText.trim();
    if (!name || deriving) return;
    setDeriving(true);
    try {
      const goal = await onDeriveGoal(name, project.useCase);
      onAdd(name, goal);
      setAddText("");
    } finally {
      setDeriving(false);
    }
  };

  const existing = new Set(cats.map((c) => c.name.trim().toLowerCase()));
  const suggestions = suggestionsFor(project.useCase).filter(
    (s) => !existing.has(s.name.trim().toLowerCase())
  );

  return (
    <div>
      {/* Multi-select toolbar */}
      {selected.size > 0 && (
        <div className="mb-2 flex items-center gap-2 rounded-lg bg-warm-bg px-2.5 py-1.5 text-xs">
          <span className="font-semibold text-ink">{selected.size} selected</span>
          <button
            onClick={deleteSelected}
            className="rounded-md bg-brand-gradient px-2.5 py-1 font-bold text-white transition hover:opacity-95"
          >
            Delete
          </button>
          <button
            onClick={() => setSelected(new Set())}
            className="font-semibold text-body/60 transition hover:text-ink"
          >
            Clear
          </button>
        </div>
      )}

      {cats.length === 0 && (
        <p className="px-1 text-xs text-body/50">No categories yet. Add one below.</p>
      )}

      <ul className="space-y-1">
        {cats.map((c) => {
          const isSel = selected.has(c.id);
          return (
            <li
              key={c.id}
              onDragOver={(e) => {
                e.preventDefault();
                if (dragId) setOverId(c.id);
              }}
              onDrop={() => drop(c.id)}
              className={`flex items-center gap-1.5 rounded-lg px-1 py-0.5 transition ${
                overId === c.id && dragId !== c.id ? "bg-coral/10 ring-1 ring-coral/30" : ""
              } ${isSel ? "bg-sage/10" : ""}`}
            >
              <span
                draggable
                onDragStart={() => setDragId(c.id)}
                onDragEnd={() => {
                  setDragId("");
                  setOverId("");
                }}
                title="Drag to reorder"
                aria-label="Drag to reorder"
                className="cursor-grab select-none px-0.5 text-body/40 active:cursor-grabbing"
              >
                ⠿
              </span>
              <input
                type="checkbox"
                checked={isSel}
                onChange={() => toggle(c.id)}
                aria-label={`Select ${c.name}`}
                className="h-3.5 w-3.5 shrink-0 accent-brown"
              />
              <input
                defaultValue={c.name}
                key={c.name}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v && v !== c.name) onRename(c.id, v);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
                aria-label={`Category name for ${c.name}`}
                className="min-w-0 flex-1 rounded-md border border-transparent px-2 py-1 text-sm text-ink outline-none transition hover:border-warm-border focus:border-coral"
              />
              <button
                onClick={() => onRemoveMany([c.id])}
                title={`Remove ${c.name}`}
                aria-label={`Remove category ${c.name}`}
                className="shrink-0 rounded-md border border-warm-border p-1 text-body/60 transition hover:border-coral/40 hover:bg-warm-bg hover:text-accent"
              >
                <TrashIcon />
              </button>
            </li>
          );
        })}
      </ul>

      {/* Add: a plus that opens suggestions + free text */}
      {!addOpen ? (
        <button
          onClick={() => setAddOpen(true)}
          className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-dashed border-warm-border px-2.5 py-1.5 text-xs font-semibold text-accent transition hover:bg-warm-bg"
        >
          <span className="text-sm leading-none">+</span> Add a category
        </button>
      ) : (
        <div className="mt-2 rounded-xl border border-warm-border bg-warm-bg/40 p-2.5">
          {suggestions.length > 0 && (
            <>
              <div className="mb-1.5 text-[10px] font-bold uppercase tracking-wide text-body/50">
                Suggestions
              </div>
              <div className="mb-2.5 flex flex-wrap gap-1.5">
                {suggestions.map((s) => (
                  <button
                    key={s.name}
                    onClick={() => onAdd(s.name, s.goal)}
                    title={s.goal}
                    className="rounded-full border border-warm-border bg-surface px-2.5 py-1 text-xs font-medium text-ink transition hover:border-coral/40 hover:bg-warm-bg"
                  >
                    + {s.name}
                  </button>
                ))}
              </div>
            </>
          )}
          <div className="flex items-center gap-1.5">
            <input
              value={addText}
              onChange={(e) => setAddText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitFree();
              }}
              placeholder="Or type your own (Scout figures out who to find)"
              className="min-w-0 flex-1 rounded-lg border border-warm-border px-2.5 py-1.5 text-sm text-ink outline-none transition focus:border-coral"
            />
            <button
              onClick={submitFree}
              disabled={!addText.trim() || deriving}
              className="shrink-0 rounded-lg bg-brand-gradient px-3 py-1.5 text-xs font-bold text-white transition hover:opacity-95 disabled:opacity-40"
            >
              {deriving ? "Reading…" : "Add"}
            </button>
            <button
              onClick={() => {
                setAddOpen(false);
                setAddText("");
              }}
              className="shrink-0 rounded-lg px-2 py-1.5 text-xs font-semibold text-body/60 transition hover:text-ink"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Inline, always-visible editor for the user's projects and their categories.
// Lives on the Profile tab (the popover CategoryManager stays on Outreach).
function ProjectsCategoriesEditor({
  projects,
  categories,
  onAddProject,
  onRenameProject,
  onRemoveProject,
  onAddCategory,
  onRenameCategory,
  onRemoveCategory,
  onRemoveCategories,
  onReorderCategories,
  onDeriveGoal,
}: {
  projects: Project[];
  categories: Category[];
  onAddProject: (name: string) => void;
  onRenameProject: (id: string, name: string) => void;
  onRemoveProject: (id: string) => void;
  onAddCategory: (projectId: string, name: string, goal?: string) => void;
  onRenameCategory: (id: string, name: string) => void;
  onRemoveCategory: (id: string) => void;
  onRemoveCategories: (ids: string[]) => void;
  onReorderCategories: (projectId: string, orderedIds: string[]) => void;
  onDeriveGoal: (name: string, useCase: string) => Promise<string>;
}) {
  const [newProject, setNewProject] = useState("");

  return (
    <div>
      <Label>Your projects and categories</Label>
      <p className="mt-1 mb-3 text-xs leading-relaxed text-body/70">
        A project is usually one client, brand, or goal you're working on; its
        categories are the kinds of people you search for. Drag to reorder,
        click to select and delete, or add your own. Synced with the Outreach tab.
      </p>

      <div className="space-y-3">
        {projects.map((p) => {
          const cats = categories.filter((c) => c.projectId === p.id);
          return (
            <div
              key={p.id}
              className="rounded-2xl border border-warm-border bg-surface p-4 shadow-card"
            >
              <div className="flex items-center gap-2">
                <span
                  className="grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-warm-bg text-[11px] font-bold text-body/60"
                  aria-hidden
                >
                  {p.name.trim().charAt(0).toUpperCase() || "?"}
                </span>
                <input
                  defaultValue={p.name}
                  key={p.name}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v && v !== p.name) onRenameProject(p.id, v);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                  }}
                  aria-label={`Project name for ${p.name}`}
                  className="min-w-0 flex-1 rounded-lg border border-transparent px-2 py-1.5 text-sm font-bold text-ink outline-none transition hover:border-warm-border focus:border-coral"
                />
                {projects.length > 1 && (
                  <button
                    onClick={() => {
                      if (
                        window.confirm(
                          `Delete the project "${p.name}" and its categories? Finds saved under it stay in your Finds list.`
                        )
                      )
                        onRemoveProject(p.id);
                    }}
                    title={`Delete ${p.name}`}
                    aria-label={`Delete project ${p.name}`}
                    className="shrink-0 rounded-lg border border-warm-border p-1.5 text-body/60 transition hover:border-coral/40 hover:bg-warm-bg hover:text-accent"
                  >
                    <TrashIcon />
                  </button>
                )}
              </div>

              <div className="mt-2.5 border-t border-warm-border pt-2.5">
                <ProjectCategoryList
                  project={p}
                  cats={cats}
                  onRename={onRenameCategory}
                  onRemoveMany={onRemoveCategories}
                  onReorder={(orderedIds) => onReorderCategories(p.id, orderedIds)}
                  onAdd={(name, goal) => onAddCategory(p.id, name, goal)}
                  onDeriveGoal={onDeriveGoal}
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* Add a project */}
      <div className="mt-3 flex items-center gap-1.5">
        <input
          value={newProject}
          onChange={(e) => setNewProject(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && newProject.trim()) {
              onAddProject(newProject);
              setNewProject("");
            }
          }}
          placeholder="New project (e.g. another client or brand)"
          className="min-w-0 flex-1 rounded-xl border border-warm-border px-3.5 py-2.5 text-sm text-ink outline-none transition focus:border-coral focus:ring-4 focus:ring-coral/15"
        />
        <button
          onClick={() => {
            if (newProject.trim()) {
              onAddProject(newProject);
              setNewProject("");
            }
          }}
          disabled={!newProject.trim()}
          className="shrink-0 rounded-xl bg-brand-gradient px-4 py-2.5 text-sm font-bold text-white shadow-soft transition hover:opacity-95 disabled:opacity-40"
        >
          Add project
        </button>
      </div>
    </div>
  );
}

function CategoryManager({
  cats,
  onAdd,
  onRename,
  onRemove,
  onClose,
  title = "Edit categories",
  addPlaceholder = "New category name",
  emptyText = "No categories yet. Add one below.",
  canRemove = true,
}: {
  cats: { id: string; name: string }[];
  onAdd: (name: string) => void;
  onRename: (id: string, name: string) => void;
  onRemove: (id: string) => void;
  onClose: () => void;
  title?: string;
  addPlaceholder?: string;
  emptyText?: string;
  canRemove?: boolean;
}) {
  const [newName, setNewName] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [onClose]);

  function add() {
    if (!newName.trim()) return;
    onAdd(newName);
    setNewName("");
  }

  return (
    <div
      ref={ref}
      className="absolute left-0 top-full z-30 mt-2 w-[300px] rounded-2xl border border-warm-border bg-surface p-3 shadow-soft"
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-bold uppercase tracking-wider text-body/60">
          {title}
        </span>
        <button
          onClick={onClose}
          className="text-xs font-semibold text-accent transition hover:underline"
        >
          Done
        </button>
      </div>

      <div className="max-h-56 space-y-1.5 overflow-auto">
        {cats.length === 0 && (
          <p className="px-1 py-2 text-xs text-body/60">{emptyText}</p>
        )}
        {cats.map((c) => (
          <div key={c.id} className="flex items-center gap-1.5">
            <input
              defaultValue={c.name}
              onBlur={(e) => {
                if (e.target.value.trim() && e.target.value.trim() !== c.name)
                  onRename(c.id, e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
              className="min-w-0 flex-1 rounded-lg border border-warm-border px-2.5 py-1.5 text-sm text-ink outline-none transition focus:border-coral"
            />
            {canRemove && cats.length > 1 && (
              <button
                onClick={() => onRemove(c.id)}
                title={`Remove ${c.name}`}
                aria-label={`Remove ${c.name}`}
                className="shrink-0 rounded-lg border border-warm-border p-1.5 text-body/60 transition hover:border-coral/40 hover:bg-warm-bg hover:text-accent"
              >
                <TrashIcon />
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="mt-2.5 flex items-center gap-1.5 border-t border-warm-border pt-2.5">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
          placeholder={addPlaceholder}
          className="min-w-0 flex-1 rounded-lg border border-warm-border px-2.5 py-1.5 text-sm text-ink outline-none transition focus:border-coral"
        />
        <button
          onClick={add}
          disabled={!newName.trim()}
          className="shrink-0 rounded-lg bg-brand-gradient px-3 py-1.5 text-xs font-bold text-white transition hover:opacity-95 disabled:opacity-40"
        >
          Add
        </button>
      </div>
    </div>
  );
}

function TrashIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 6h18 M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2 M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6 M14 11v6" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" />
    </svg>
  );
}

function ExpandIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M15 3h6v6 M9 21H3v-6 M21 3l-7 7 M3 21l7-7" />
    </svg>
  );
}

function HeroArt() {
  return (
    <div className="relative mx-auto h-56 w-full max-w-sm">
      <div className="absolute right-6 top-2 w-60 rounded-2xl rounded-tr-sm border border-warm-border bg-surface p-3.5 shadow-soft">
        <span
          aria-hidden
          className="absolute -right-[6px] top-5 h-3 w-3 rotate-45 border-r border-t border-warm-border bg-surface"
        />
        <div className="mb-2 flex items-center gap-2">
          <span className="h-6 w-6 rounded-full bg-brand-gradient" />
          <span className="text-xs font-bold text-ink">You</span>
          <span className="ml-auto text-[10px] font-semibold uppercase tracking-wide text-accent">
            Email
          </span>
        </div>
        <div className="h-2 w-full rounded-full bg-warm-bg" />
        <div className="mt-1.5 h-2 w-4/5 rounded-full bg-warm-bg" />
      </div>
      <div className="absolute left-2 top-24 w-52 rounded-2xl rounded-tl-sm bg-brand-gradient p-3.5 text-white shadow-soft">
        <span
          aria-hidden
          className="absolute -left-[6px] top-5 h-3 w-3 rotate-45 bg-[#ff8159]"
        />
        <div className="mb-2 flex items-center gap-2">
          <span className="h-6 w-6 rounded-full bg-white/30" />
          <span className="text-xs font-bold">Reply</span>
          <span className="ml-auto text-[10px] font-semibold uppercase tracking-wide text-white/80">
            LinkedIn
          </span>
        </div>
        <div className="h-2 w-full rounded-full bg-white/35" />
        <div className="mt-1.5 h-2 w-3/4 rounded-full bg-white/35" />
      </div>
      <div className="absolute bottom-1 right-10 flex items-center gap-1.5 rounded-full border border-warm-border bg-surface px-3 py-2 shadow-card">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-coral" />
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-blush [animation-delay:150ms]" />
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-coral [animation-delay:300ms]" />
      </div>
    </div>
  );
}

function Logo({ small = false, white = false }: { small?: boolean; white?: boolean }) {
  const s = white ? 18 : small ? 18 : 24;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/scout-logo.png"
      alt="Scout"
      width={s}
      height={s}
      // On a brown background (the Avatar), tint the brown mark to white.
      className={white ? "[filter:brightness(0)_invert(1)]" : ""}
    />
  );
}
