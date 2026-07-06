"use client";

import { useEffect, useRef, useState } from "react";
import { ucInfo, ucKey, USE_CASE_SUGGESTIONS } from "@/lib/templates";
import type { Draft, Opportunity, OutreachTemplate, SourceRef } from "@/lib/types";
import type { Session } from "@supabase/supabase-js";
import AuthScreen from "./AuthScreen";
import AccountOnboarding from "./AccountOnboarding";
import CornerDog from "./CornerDog";
import { Reveal, CountUp, FadeIn } from "./motion";
import { ActivityChart, PipelineBar, MatchGauge, Sparkline } from "./charts";
import Tutorial, { type TourStep } from "./Tutorial";
import ImportOutreach from "./ImportOutreach";
import ComboInput from "./ComboInput";
import { CITY_SUGGESTIONS, SCHOOL_SUGGESTIONS } from "./suggest";
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
// Keyed by ucKey(), the deep presets have tailored sets; anything else falls
// back to GENERIC_SUGGESTIONS.
const SUGGESTED: Record<string, { name: string; goal: string }[]> = {
  networking: [
    { name: "Coffee Chats", goal: "professionals in my field open to a quick coffee or call" },
    { name: "Mentors", goal: "experienced people in my field open to mentoring" },
    { name: "Job Opportunities", goal: "companies in my field hiring for roles I'd want" },
    { name: "Sponsorship Opportunities", goal: "brands or companies that sponsor people or work like mine" },
    { name: "Press & Media", goal: "journalists, blogs, and podcasts that cover work like mine" },
  ],
  jobs: [
    { name: "Job Opportunities", goal: "companies in my field hiring for roles I'd want" },
    { name: "Internships", goal: "internships in my field accepting applications" },
    { name: "Recruiters", goal: "recruiters and hiring managers in my field" },
    { name: "Coffee Chats", goal: "people doing the job I want, open to a quick chat for advice" },
  ],
  musicpr: [
    { name: "Playlist Curators", goal: "playlist curators accepting submissions" },
    { name: "Press & Blogs", goal: "music blogs and press that cover artists like me" },
    { name: "Radio & Podcasts", goal: "radio shows and podcasts that play my kind of music" },
    { name: "Sync & Licensing", goal: "music supervisors placing songs in TV, film, and ads" },
  ],
};

// Tangible fallback categories for any free-text use case that isn't a preset.
// Concrete opportunity types, so a new user immediately sees real things to
// scout for rather than abstract labels.
const GENERIC_SUGGESTIONS: { name: string; goal: string }[] = [
  { name: "Coffee Chats", goal: "people connected to my goal open to a quick coffee or call" },
  { name: "Job Opportunities", goal: "companies hiring for roles I'd want" },
  { name: "Sponsorship Opportunities", goal: "brands or companies that sponsor people or projects like mine" },
  { name: "Press & Media", goal: "journalists, blogs, and podcasts that cover work like mine" },
  { name: "Partnerships", goal: "people or organizations who could partner with me" },
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
// Advice the user marked "Not helpful", the negative mirror of COACH_KEY.
// Same key OutreachAdvice used to hide dismissed tips locally; lifted to
// top-level state so drafting can also avoid what the user rejected.
const DISMISSED_ADVICE_KEY = "scout_dismissed_tips";
const EDITS_KEY = "scout_edit_pairs"; // learn-from-edits before/after voice deltas
const RESUME_KEY = "scout_resume_file"; // resume file (name + data URL) for attaching
const SIG_KEY = "scout_signature"; // email signature appended to drafts
const TOUR_KEY = "scout_tutorial_seen"; // "1" once the intro tour is finished or skipped
const AUTOSCHED_KEY = "scout_auto_schedule"; // "1" → after-hours sends auto-queue for the next business hour

// Whether after-hours sends should silently queue for the recipient's next
// business hour instead of prompting. Read at send time so it's always current.
function autoScheduleOn(): boolean {
  try {
    return localStorage.getItem(AUTOSCHED_KEY) === "1";
  } catch {
    return false;
  }
}

// Guided intro tour. Each step spotlights a sidebar item (matched by its
// data-tour id) and switches to that tab so the real screen shows behind.
const TOUR_STEPS: TourStep[] = [
  {
    tab: "dashboard",
    title: "Welcome to Scout",
    body: "Scout finds the right people and opportunities, then drafts personalized outreach in your own voice. Here's a 60-second tour of how it works.",
  },
  {
    tab: "dashboard",
    target: "nav-dashboard",
    title: "Your Dashboard",
    body: "Your home base, a snapshot of activity, saved templates, and coaching tips that sharpen every draft over time.",
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
    body: "A project is a self-contained workspace, one per client, brand, or goal. Each keeps its own categories, finds, and context so pitches sound like they're really about that project.",
  },
  {
    tab: "outreach",
    target: "category-switcher",
    title: "Categories: presets for each kind of search",
    body: "Inside a project, categories are reusable search presets, e.g. \"brand partnerships\" vs \"press writers\" vs \"software engineering internships.\" Pick one to shape who Scout looks for, or type your own goal for a one-off search.",
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
// "" = not specified. Drives how outreach frames the sender's stage.
type EducationStatus =
  | ""
  | "highschool"
  | "college"
  | "graduated"
  | "middleschool"
  | "gradschool"
  | "phd"
  | "bootcamp"
  | "vocational"
  | "selftaught"
  | "working";
const EDU_STATUS_LABEL: Record<Exclude<EducationStatus, "">, string> = {
  highschool: "In high school",
  college: "In college",
  graduated: "Graduated",
  middleschool: "In middle school",
  gradschool: "In grad school",
  phd: "PhD / doctoral",
  bootcamp: "Bootcamp / certificate",
  vocational: "Trade / vocational school",
  selftaught: "Self-taught",
  working: "Working professional",
};
// The four shown as quick toggles; the rest live under the "Other" dropdown.
const EDU_MAIN: EducationStatus[] = ["", "highschool", "college", "graduated"];
const EDU_OTHER: Exclude<EducationStatus, "">[] = [
  "middleschool",
  "gradschool",
  "phd",
  "bootcamp",
  "vocational",
  "selftaught",
  "working",
];

// Chosen once at first sign-in (blocking) and never toggled afterward, it
// decides which onboarding + profile shape the user gets. "" = not chosen yet,
// which is what gates the app behind the account-type modal.
type AccountType = "" | "individual" | "company";

interface Profile {
  name: string;
  bio: string;
  useCase: string; // free text; matched to a preset when it can be, else read as-is
  linkedin?: string;
  // Individual vs company, set at signup. Company profiles ask about the role
  // you serve and how you contribute to the company's projects, and skip the
  // resume/education-heavy individual fields.
  accountType?: AccountType;
  companyName?: string;
  companyRole?: string; // your specific role/title at the company
  companyContribution?: string; // how you serve / what you do on the company's projects
  companyWorkspaceId?: string; // the Teams workspace this company maps to (created or joined)
  // Optional personalization. Stored locally only for now (the Supabase
  // `profiles` row keeps its original columns; these ride along in the browser's
  // scout_profile blob and flow into aboutText so the LLM can use them).
  age?: number;
  eduStatus?: EducationStatus; // high school / college / graduated
  college?: string;
  major?: string; // major / field of study
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
  context: string; // who this outreach is for, fed into discovery + drafting
  // Optional per-project email signature. Falls back to the account-wide
  // default (SIG_KEY/profile signature) when unset, different projects can
  // sign off as different people/brands without touching the global default.
  signature?: string;
  // Whether searches in this project read your Profile and learn from your
  // history in OTHER projects. Default true. Turn OFF when the project is
  // disconnected from you (representing someone outside your industry) so the
  // search doesn't bias toward you. Remembered per project.
  usesProfile?: boolean;
}
interface Category {
  id: string;
  name: string;
  goal: string;
  projectId: string; // categories belong to a project
  // Which contact channels this search should try to come back with (values
  // from CONTACT_CHANNELS below, e.g. ["email","phone"]). Empty/undefined =
  // no specific preference, Scout returns whatever it finds.
  wantedChannels?: string[];
}

// The contact channels a user can ask Scout to prioritize per search.
const CONTACT_CHANNELS: { key: string; label: string; hint: string }[] = [
  { key: "email", label: "Email", hint: "an email address" },
  { key: "phone", label: "Phone", hint: "a phone number" },
  { key: "linkedin", label: "LinkedIn", hint: "a LinkedIn profile" },
  { key: "website", label: "Website", hint: "a website link" },
];

// Read the value on an Opportunity for one of the CONTACT_CHANNELS keys, 
// shared by the find card and detail modal's "requested contact info" sections.
function channelValue(o: Opportunity, key: string): string {
  if (key === "email") return o.contactEmail || "";
  if (key === "phone") return o.contactPhone || "";
  if (key === "linkedin") return o.contactHandle || "";
  if (key === "website") return o.url || "";
  return "";
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
  gmailThreadId?: string; // set when sent/drafted via Gmail, enables reply tracking
  outlookThreadId?: string; // Outlook conversation id, enables reply tracking
  denyReason?: string; // why the user passed on this find
  requirements?: string; // what this target asks for (pasted or found by deep-scan)
  sentAt?: number; // when the outreach actually went out (drives follow-up timing)
  lastFollowUpAt?: number; // when the most recent follow-up nudge was drafted/sent
  scanned?: boolean; // deep-scan has already run on this find's site
  pinned?: boolean; // pinned to the top of the finds list
  scheduledSendAt?: string; // ISO timestamp: when the queued send will fire (via cron)
  // Meeting / interview prep, factual highlights about the contact + outlet,
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
// name suffixes, and middle names/initials, then keeps first + last token.
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

// "pinned" is a cross-cutting bucket, not a status: pinning a find moves it
// into the Pinned tab and pulls it out of its status/all lists (a working
// shortlist), rather than just floating it to the top of its current tab.
type FindFilter = FindStatus | "all" | "pinned";
const FIND_STATUSES: { key: FindFilter; label: string }[] = [
  { key: "pinned", label: "Pinned" },
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
  // Set when the user arrives via a password-reset email link, shows the
  // "set a new password" screen even though a (recovery) session now exists.
  const [recovery, setRecovery] = useState(false);
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
  // is the reliable cross-browser signal, beforeunload gets killed on mobile.
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
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      setChecked(true);
      if (!s) setProfileLoaded(false);
      // Arriving from a reset-password email link: force the set-new-password
      // screen regardless of the session the link established.
      if (event === "PASSWORD_RECOVERY") setRecovery(true);
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
          if (typeof parsed.accountType === "string") localExtras.accountType = parsed.accountType;
          if (typeof parsed.companyName === "string") localExtras.companyName = parsed.companyName;
          if (typeof parsed.companyRole === "string") localExtras.companyRole = parsed.companyRole;
          if (typeof parsed.companyContribution === "string")
            localExtras.companyContribution = parsed.companyContribution;
          if (typeof parsed.companyWorkspaceId === "string")
            localExtras.companyWorkspaceId = parsed.companyWorkspaceId;
          if (typeof parsed.age === "number") localExtras.age = parsed.age;
          if (typeof parsed.eduStatus === "string") localExtras.eduStatus = parsed.eduStatus;
          if (typeof parsed.college === "string") localExtras.college = parsed.college;
          if (typeof parsed.major === "string") localExtras.major = parsed.major;
          if (typeof parsed.location === "string") localExtras.location = parsed.location;
          if (typeof parsed.companySize === "string") localExtras.companySize = parsed.companySize;
          if (typeof parsed.competitiveness === "string")
            localExtras.competitiveness = parsed.competitiveness;
        }
      } catch {
        /* localStorage unavailable, nothing to migrate */
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
      const allowedEdu = new Set<EducationStatus>([
        "highschool",
        "college",
        "graduated",
        ...EDU_OTHER,
      ]);
      const allowedAcct = new Set<AccountType>(["individual", "company"]);
      const mergedExtras: Partial<Profile> = {};
      if (raw.accountType && allowedAcct.has(raw.accountType as AccountType))
        mergedExtras.accountType = raw.accountType as AccountType;
      if (typeof raw.companyName === "string") mergedExtras.companyName = raw.companyName;
      if (typeof raw.companyRole === "string") mergedExtras.companyRole = raw.companyRole;
      if (typeof raw.companyContribution === "string")
        mergedExtras.companyContribution = raw.companyContribution;
      if (typeof raw.companyWorkspaceId === "string")
        mergedExtras.companyWorkspaceId = raw.companyWorkspaceId;
      if (typeof raw.age === "number") mergedExtras.age = raw.age;
      if (raw.eduStatus && allowedEdu.has(raw.eduStatus as EducationStatus))
        mergedExtras.eduStatus = raw.eduStatus as EducationStatus;
      if (typeof raw.college === "string") mergedExtras.college = raw.college;
      if (typeof raw.major === "string") mergedExtras.major = raw.major;
      if (typeof raw.location === "string") mergedExtras.location = raw.location;
      if (raw.companySize && allowedSize.has(raw.companySize as CompanySize))
        mergedExtras.companySize = raw.companySize as CompanySize;
      if (raw.competitiveness && allowedComp.has(raw.competitiveness as Competitiveness))
        mergedExtras.competitiveness = raw.competitiveness as Competitiveness;
      // Seed the display name from the sign-up metadata (first/last name) when
      // there's no saved profile name yet, so new accounts feel personal at once.
      const meta = (session?.user?.user_metadata || {}) as Record<string, string>;
      const metaName = (
        meta.full_name ||
        [meta.first_name, meta.last_name].filter(Boolean).join(" ")
      ).trim();
      setInitial(
        p
          ? {
              name: p.name || metaName,
              bio: p.bio,
              useCase: p.useCase || "Networking",
              linkedin: p.linkedin || "",
              ...mergedExtras,
            }
          : { name: metaName, bio: "", useCase: "Networking", linkedin: "", ...mergedExtras }
      );
      setInitialState(s);
      setProfileLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [uid]);

  if (!checked) return <Loading />;
  if (recovery)
    return <AuthScreen recovery onRecoveryDone={() => setRecovery(false)} />;
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

interface BillingStatus {
  billingEnabled: boolean;
  tier: "free" | "starter" | "pro";
  status: string;
  comp?: boolean; // free-forever access via a redeemed code
  searchLimit: number;
  searchesUsed: number;
  freeLimit: number;
  freeUsed: number;
  periodEnd: string | null;
  freeResetsAt: string | null;
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
    "outreach" | "finds" | "dashboard" | "team" | "templates" | "profile" | "account" | "settings" | "billing"
  >("dashboard");

  // ---- Billing / plan state ----
  // Shown when a search is blocked by the plan limit (code: 'quota' | 'free_exhausted').
  const [upgradePrompt, setUpgradePrompt] = useState<{ code: string; tier: string } | null>(null);
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const [billingBusy, setBillingBusy] = useState(false);

  // ---- Command palette (⌘K) + row peek ----
  const [cmdOpen, setCmdOpen] = useState(false);
  const [peekFind, setPeekFind] = useState<Find | null>(null);
  // Global ⌘K / Ctrl+K toggles the palette; Esc closes the open overlays.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdOpen((v) => !v);
      } else if (e.key === "Escape") {
        setCmdOpen(false);
        setPeekFind(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
  // Contact channels this search should prioritize (email/phone/linkedin/website).
  // Mirrors the selected category's wantedChannels; persisted back onto it.
  const [wantedChannels, setWantedChannels] = useState<string[]>([]);
  const [editingCats, setEditingCats] = useState(false); // category manager open?
  const [editingProjects, setEditingProjects] = useState(false); // project manager open?
  const [goal, setGoal] = useState("");
  const [discovering, setDiscovering] = useState(false);
  // Live count of finds streamed in so far this search (for the "Stop" button).
  const [liveCount, setLiveCount] = useState(0);
  // Pre-search "understanding" gate: when Scout has real gaps, this holds the
  // % understood + confidence questions + the plan, and the popup under the
  // category card offers to answer them or run anyway. Null = no popup.
  const [planGate, setPlanGate] = useState<
    {
      understanding: number;
      questions: { question: string; options: string[] }[];
      plan: any;
    } | null
  >(null);
  const [gating, setGating] = useState(false); // the understanding pass is running
  // Multiple-choice picks for the current round, keyed by question index. The
  // value is the chosen option, or "__other__" when the write-in is active.
  const [picks, setPicks] = useState<Record<number, string>>({});
  const [otherText, setOtherText] = useState<Record<number, string>>({});
  // Lets the user cancel an in-flight search but keep what was already scouted.
  const discoverAbort = useRef<AbortController | null>(null);
  // When discovery started (ms epoch), so the progress bar can resume at the
  // right % after tab switches, SearchProgress is scoped to the Outreach tab
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
  // The refine box above Messages: you type an instruction ("make these
  // shorter", "more casual", "mention I'm a recent grad") and it rewrites every
  // draft shown. Scout does NOT chat back, it just applies the change.
  // redraftChat is only a log of the instructions you've sent, so you can see
  // what you've already asked for.
  const [redraftInstruction, setRedraftInstruction] = useState("");
  const [revisingBatch, setRevisingBatch] = useState(false);
  const [redraftChat, setRedraftChat] = useState<{ text: string }[]>([]);
  const redraftScrollRef = useRef<HTMLDivElement | null>(null);
  // Keep the request log pinned to the latest entry.
  useEffect(() => {
    const el = redraftScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [redraftChat, revisingBatch]);
  const [stats, setStats] = useState("");
  const [expanded, setExpanded] = useState(false);

  // As the cursor moves toward the Scout button, nudge the mascot (CornerDog)
  // to wag. Proximity, not hover, it starts as you head that way. Throttled
  // to one signal per ~350ms while near, and skipped under reduced-motion.
  const scoutBtnRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const RADIUS = 180; // px from the button's edge that counts as "heading over"
    let raf = 0;
    let lastSignal = 0;
    const onMove = (e: MouseEvent) => {
      if (raf) return; // coalesce to one check per frame
      raf = requestAnimationFrame(() => {
        raf = 0;
        const btn = scoutBtnRef.current;
        if (!btn || btn.offsetParent === null) return; // not mounted / hidden tab
        const r = btn.getBoundingClientRect();
        const dx = Math.max(r.left - e.clientX, 0, e.clientX - r.right);
        const dy = Math.max(r.top - e.clientY, 0, e.clientY - r.bottom);
        if (Math.hypot(dx, dy) <= RADIUS) {
          const now = Date.now();
          if (now - lastSignal > 350) {
            lastSignal = now;
            window.dispatchEvent(new Event("scout:wag"));
          }
        }
      });
    };
    window.addEventListener("mousemove", onMove, { passive: true });
    return () => {
      window.removeEventListener("mousemove", onMove);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

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
  const [findFilter, setFindFilter] = useState<FindFilter>("new");
  const [findDraftingId, setFindDraftingId] = useState(""); // find being drafted
  // Coaching directives the user approved (applied to every draft) + the
  // before/after voice deltas learned from drafts they hand-edited.
  const [coaching, setCoaching] = useState<string[]>([]);
  // Advice the user marked "Not helpful", fed into drafting as things to
  // avoid, the negative mirror of `coaching`.
  const [dismissedAdvice, setDismissedAdvice] = useState<string[]>([]);
  const [editPairs, setEditPairs] = useState<{ before: string; after: string }[]>([]);
  // True after the user edits a draft while other un-sent drafts still exist, 
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
    // Local-only (not part of cross-device sync): advice dismissed as "not helpful".
    try {
      const raw = localStorage.getItem(DISMISSED_ADVICE_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      setDismissedAdvice(Array.isArray(arr) ? arr.map((s: unknown) => String(s)) : []);
    } catch {}

    if (!projs.length) {
      // First run under the projects model. Create one empty project that
      // invites the user to name it and set their own use case, no seeded
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
      setWantedChannels(mine[0].wantedChannels || []);
    } else {
      setCatId("");
      // Leave the goal empty so the example shows as greyed placeholder advice
      // (goalPlaceholder), not real text the user has to delete before typing.
      setGoal("");
      setWantedChannels([]);
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
      // lived in localStorage before this, which meant it evaporated on any
      // fresh hydrate.
      profileExtras: {
        accountType: profile.accountType,
        companyName: profile.companyName,
        companyRole: profile.companyRole,
        companyContribution: profile.companyContribution,
        companyWorkspaceId: profile.companyWorkspaceId,
        age: profile.age,
        eduStatus: profile.eduStatus,
        college: profile.college,
        major: profile.major,
        location: profile.location,
        companySize: profile.companySize,
        competitiveness: profile.competitiveness,
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myTemplates, projects, categories, activeId, activity, finds, coaching, editPairs, resumeFile, signature, profile.accountType, profile.companyName, profile.companyRole, profile.companyContribution, profile.companyWorkspaceId, profile.age, profile.eduStatus, profile.college, profile.major, profile.location, profile.companySize, profile.competitiveness]);

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
      /* localStorage unavailable, skip the tour rather than crash */
    }
  }, []);

  // Probe /api/admin/whoami on load. Server never leaks the allowlist, 
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
        /* silent, user is just treated as non-owner */
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
  // Runs entirely client-side, nothing leaves the browser except the download.
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
  // Mark advice "Not helpful": hides it AND feeds it to drafting as something
  // to avoid (see dismissedAdviceBlock in lib/draft.ts). Dedupe, cap at 12.
  const dismissAdvice = (tip: string) => {
    const t = String(tip || "").trim().toLowerCase();
    if (!t) return;
    const next = [t, ...dismissedAdvice.filter((d) => d !== t)].slice(0, 12);
    setDismissedAdvice(next);
    try {
      localStorage.setItem(DISMISSED_ADVICE_KEY, JSON.stringify(next));
    } catch {}
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
  // Build an email signature from the user's bio/resume text (used by the
  // Templates tab's "Build from resume" button). Returns "" on failure.
  async function buildSignatureFromBio(): Promise<string> {
    const t = (profile.bio || "").trim();
    if (!t) return "";
    try {
      const res = await fetch("/api/parse-profile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: t }),
      });
      const data = await res.json();
      return res.ok && data.signature ? String(data.signature) : "";
    } catch {
      return "";
    }
  }
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
    // this freshly-learned voice. Only "drafted" finds are eligible, sent or
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
    setRedraftChat([]);
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
    // Empty body, trust the HTTP status.
    if (!text.trim()) {
      if (res.ok) return {};
      return {
        error:
          res.status === 504 || res.status === 408
            ? "The server took too long to respond. Try a narrower goal, or run it again."
            : `Request failed (HTTP ${res.status}).`,
      };
    }
    // Try JSON first, every well-behaved route returns it.
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
      setWantedChannels(mine[0].wantedChannels || []);
    } else {
      setCatId("");
      // Empty goal -> the greyed placeholder advice shows instead of real text.
      setGoal("");
      setWantedChannels([]);
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
  // Toggle whether this project's searches read your Profile + cross-project history.
  function setProjectUsesProfile(id: string, usesProfile: boolean) {
    saveProjects(projects.map((p) => (p.id === id ? { ...p, usesProfile } : p)));
  }

  // Per-project email signature, falling back to the account-wide default
  // when a project hasn't set its own. Every draft-generating call site
  // should use this instead of the flat `signature` value.
  function signatureFor(projectId: string): string {
    const proj = projects.find((p) => p.id === projectId);
    return (proj?.signature ?? signature) || "";
  }
  function setProjectSignature(id: string, sig: string) {
    saveProjects(projects.map((p) => (p.id === id ? { ...p, signature: sig } : p)));
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
    // Only fill fields the user hasn't set, a resume drop never overwrites
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
    if (c) {
      setGoal(c.goal);
      setWantedChannels(c.wantedChannels || []);
    } else {
      setWantedChannels([]);
    }
    resetResults();
  }

  // A short, readable default name from a goal string, first few words, capped
  // length. Used to auto-save a custom search as a category (see
  // autoSaveCustomSearch below); renameable anytime via the pencil.
  function deriveCategoryName(g: string): string {
    const s = g.trim().replace(/\s+/g, " ");
    if (!s) return "New search";
    const words = s.split(" ").slice(0, 6).join(" ");
    const capped = words.length > 42 ? words.slice(0, 42).replace(/\s+\S*$/, "") : words;
    return capped.charAt(0).toUpperCase() + capped.slice(1);
  }

  // Every search you run is automatically saved as a category, no manual
  // "Save Search" step. If the "Custom search…" slot is still active, promote
  // the current goal to a real category now and select it. Returns the
  // category id to use for this run (existing catId, or the freshly created
  // one) since `catId` state won't reflect a same-tick setCatId until the next
  // render, callers that create finds in this same pass need the fresh id.
  function autoSaveCustomSearch(): string {
    if (catId || !goal.trim()) return catId;
    const c: Category = {
      id: `cat-${Date.now()}`,
      name: deriveCategoryName(goal),
      goal,
      projectId: activeId,
      wantedChannels: wantedChannels.length ? wantedChannels : undefined,
    };
    saveCats([...categories, c]);
    setCatId(c.id);
    return c.id;
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
    setWantedChannels([]);
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
        setWantedChannels(mine[0].wantedChannels || []);
      } else {
        setCatId("");
        setWantedChannels([]);
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
        setWantedChannels(mine[0].wantedChannels || []);
      } else {
        setCatId("");
        setWantedChannels([]);
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

  // Edit an existing template in place (channel, text, and where it applies).
  function updateTemplate(
    id: string,
    patch: { channel: string; text: string; projectId?: string; categoryId?: string }
  ) {
    saveTpls(
      myTemplates.map((t) =>
        t.id === id
          ? {
              ...t,
              channel: patch.channel,
              text: patch.text,
              projectId: patch.projectId,
              categoryId: patch.categoryId,
            }
          : t
      )
    );
  }

  // Which templates apply when drafting for a given project + category. Global
  // templates (no projectId) always apply; project-scoped ones apply to that
  // project; category-scoped ones only when that exact category is in play.
  // If a project has none of its own (and no global ones exist either), fall
  // back to ALL the user's templates as a voice reference, a template saved
  // under a different project is still real evidence of how this person
  // writes. Safe to borrow: draftFor's prompt already says to match voice, not
  // copy content, and to adapt every detail to the actual recipient.
  function templatesFor(projectId: string, categoryId?: string): OutreachTemplate[] {
    const scoped = myTemplates.filter((t) => {
      if (t.projectId && t.projectId !== projectId) return false;
      if (t.categoryId && t.categoryId !== (categoryId || "")) return false;
      return true;
    });
    return scoped.length ? scoped : myTemplates;
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
    profile.accountType === "company" && profile.companyName
      ? `Reaching out on behalf of ${profile.companyName}` +
        (profile.companyRole ? ` as ${profile.companyRole}` : "")
      : "",
    profile.accountType === "company" && profile.companyContribution
      ? `Their role / how they serve the company's work: ${profile.companyContribution}`
      : "",
    profile.age ? `Age: ${profile.age}` : "",
    profile.eduStatus ? `Education stage: ${EDU_STATUS_LABEL[profile.eduStatus]}` : "",
    profile.college ? `Education: ${profile.college}` : "",
    profile.major ? `Major / field of study: ${profile.major}` : "",
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
  // optional, they just make outreach more personal.
  const profileComplete = !!(profile.name.trim() || profile.bio.trim());

  // ---- Personalized "who are you looking for?" placeholder ----
  // The greyed-out example under the goal field is tailored to THIS user's
  // industry (from aboutText) and the category they're about to search, and it
  // varies per person via their salt, so the example looks different for
  // everyone instead of being one static string. Falls back to the static
  // template placeholder until a personalized one loads (or if there's no
  // profile to personalize from). Cached per (useCase + category + profile) so
  // we don't refetch on every render or when flipping back to a seen category.
  const activeCatName = myCats.find((c) => c.id === catId)?.name || "";
  const exampleCacheRef = useRef<Record<string, string>>({});
  const [dynExample, setDynExample] = useState("");
  useEffect(() => {
    // Only personalize when we have something to personalize from.
    if (!aboutText.trim()) {
      setDynExample("");
      return;
    }
    // Signature keeps the fetch stable: same inputs → cached example reused.
    const aboutSig = aboutText.slice(0, 400);
    const key = `${ucKey(activeUseCase)}::${activeCatName.toLowerCase()}::${aboutSig}`;
    const cached = exampleCacheRef.current[key];
    if (cached !== undefined) {
      setDynExample(cached);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/example-goal", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            category: activeCatName,
            useCase: activeUseCase,
            about: aboutText,
            salt: outreachSalt(accountEmail),
          }),
        });
        const data = await res.json().catch(() => ({}));
        const ex = typeof data?.example === "string" ? data.example : "";
        exampleCacheRef.current[key] = ex; // cache even "" so we don't retry a dud
        if (!cancelled) setDynExample(ex);
      } catch {
        if (!cancelled) setDynExample("");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeUseCase, activeCatName, aboutText, accountEmail]);
  // What the goal textarea actually shows as its placeholder.
  const goalPlaceholder = dynExample
    ? `e.g. ${dynExample}`
    : uc.goalPlaceholder;

  // Persist edits to the goal back onto the selected saved category, so a
  // category like "Companies" REMEMBERS what you mean by it instead of making
  // you retype the search every time. Debounced; only writes when the text
  // actually changed from what's stored, and never for the "Custom search" slot
  // (catId === ""). saveCats bumps `categories`, which re-runs this effect, but
  // then goal === cat.goal so it no-ops, no loop.
  useEffect(() => {
    if (!catId) return; // "Custom search…", one-off, nothing to persist onto
    const cat = categories.find((c) => c.id === catId);
    if (!cat || goal === cat.goal) return;
    const t = setTimeout(() => {
      saveCats(
        categories.map((c) => (c.id === catId ? { ...c, goal } : c))
      );
    }, 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goal, catId, categories]);

  // Same auto-save, for which contact channels this search should prioritize.
  // Immediate (not debounced) since it's discrete toggle clicks, not typing.
  function toggleWantedChannel(key: string) {
    setWantedChannels((prev) => {
      const next = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key];
      if (catId) {
        saveCats(
          categories.map((c) =>
            c.id === catId ? { ...c, wantedChannels: next.length ? next : undefined } : c
          )
        );
      }
      return next;
    });
  }

  // Finds belonging to the active project (newest first), and the count still to work.
  const myFinds = activeProject
    ? finds.filter((f) => f.projectId === activeProject.id)
    : [];
  const newFindCount = myFinds.filter((f) => f.status === "new").length;

  // ---- Finds pipeline ----
  // Add newly discovered people to the active project's finds (deduped, keeping
  // any status/draft already set). Returns how many were genuinely new.
  // categoryIdOverride: when a search auto-saves as a brand-new category mid-run
  // (see runDiscover), `catId` state hasn't re-rendered yet, this closure would
  // still see the old "" and tag fresh finds as uncategorized. Pass the fresh
  // id explicitly so newly-found people land under the new category right away.
  function mergeFinds(newOpps: Opportunity[], categoryIdOverride?: string): number {
    const effectiveCatId = categoryIdOverride !== undefined ? categoryIdOverride : catId;
    // Two dedup layers: exact id match (same person + same host, historic key)
    // AND normalized-name/handle match against every find in this project. The
    // second catches "same person, different article" cases, for those we
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
        // Same person, different article, append this URL as another source
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
        // multi-source'd it), same URL check keeps things clean.
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
        categoryId: effectiveCatId || undefined,
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
  // Mark contacted from the button, same as setting status to sent.
  function markContacted(id: string) {
    setFindStatus(id, "sent");
    const f = finds.find((x) => x.id === id);
    if (f) recordExposure(f.opp); // contacted -> feed the shared ledger
  }
  // Pin/unpin a find so it sorts to the top of the list.
  function togglePin(id: string) {
    saveFinds(finds.map((f) => (f.id === id ? { ...f, pinned: !f.pinned } : f)));
  }
  // Move a find to a different project. `id` bakes in the project (project::
  // name::host), so a move needs a fresh id in the target project's scheme, 
  // otherwise a future search there wouldn't recognize this person as already
  // found and would add a duplicate. Categories are project-scoped, so the old
  // categoryId no longer means anything in the new project; drop it.
  function moveFindToProject(id: string, targetProjectId: string) {
    const f = finds.find((x) => x.id === id);
    if (!f || f.projectId === targetProjectId) return;
    const newId = findKey(targetProjectId, f.opp);
    if (finds.some((x) => x.id === newId)) {
      setError("That person is already in the target project.");
      return;
    }
    saveFinds(
      finds.map((x) =>
        x.id === id
          ? { ...x, id: newId, projectId: targetProjectId, categoryId: undefined }
          : x
      )
    );
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
  // replied finds are left alone, they already went out. Batched through
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
            goal, // so drafting knows if this is a product pitch vs a job hunt
            // Use each find's own template scope where possible; fall back to
            // the active project's templates for the batch.
            templates: templatesFor(activeId, catId),
            coaching,
            dismissedAdvice,
            editPairs,
            signature: signatureFor(activeId),
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
  // Only personal outreach counts, job/internship openings are meant to get many
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
  // categorized facts, not questions to ask. Gated at the UI layer to
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
          // Only fill gaps, never overwrite a contact we already trust.
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
          dismissedAdvice,
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
          goal: categories.find((c) => c.id === find.categoryId)?.goal || goal,
          templates: templatesFor(find.projectId, find.categoryId),
          coaching,
          dismissedAdvice,
          editPairs,
          signature: signatureFor(find.projectId),
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
      // Mark the find locally as scheduled so the UI reflects the queue, 
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

  async function runDiscover(precomputedPlan: any = null, clarifyText = "") {
    if (!profileComplete) {
      setTab("profile");
      return;
    }
    setPlanGate(null); // close the confidence popup if it was open
    const runCatId = autoSaveCustomSearch();
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
      // Beginners get pointed at small companies by default (more responsive,
      // less competitive, and the right audience for a "please consider me"
      // cold email), unless they've explicitly chosen a company size.
      const explicitSize = profile.companySize && profile.companySize !== "any";
      const sizePref: CompanySize = jobish
        ? explicitSize
          ? (profile.companySize as CompanySize)
          : compLevel === "beginner"
            ? "small"
            : "any"
        : "any";
      const extras: string[] = [];
      if (compLevel !== "any") extras.push(COMPETITIVENESS_HINTS[compLevel]);
      if (sizePref !== "any") extras.push(COMPANY_SIZE_HINTS[sizePref]);
      // Contact channels the user picked for this search, read by discover's
      // "REQUIRED CHANNELS" instruction, which favors results exposing all of them.
      if (wantedChannels.length) {
        const hints = CONTACT_CHANNELS.filter((c) => wantedChannels.includes(c.key)).map(
          (c) => c.hint
        );
        extras.push(
          `The user specifically wants these contact channels back for every result: ${hints.join(", ")}.`
        );
      }
      // Answers the user gave to Scout's confidence questions ride along with
      // the goal so the search understands more.
      const clarifyBlock = clarifyText.trim()
        ? `\n\nMore detail from me: ${clarifyText.trim()}`
        : "";
      const goalForApi =
        (extras.length ? `${goal}\n\n${extras.join(" ")}` : goal) + clarifyBlock;
      // Per-project "read my profile" setting (default on). When OFF, the search
      // ignores your Profile and your cross-project history, using only who this
      // project is for — so representing someone outside your world doesn't bias
      // results back toward you.
      const usesProfile = activeProject?.usesProfile !== false;
      const projectOnlyAbout = activeProject?.context
        ? "This outreach is on behalf of / for: " + activeProject.context
        : "";
      const aboutForApi = usesProfile ? aboutText : projectOnlyAbout;
      const token = getToken ? await getToken() : null;
      const controller = new AbortController();
      discoverAbort.current = controller;
      setLiveCount(0);
      const res = await fetch("/api/discover", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          goal: goalForApi,
          about: aboutForApi,
          useCase: activeUseCase,
          feedback,
          // Reuse the plan from the understanding step (skips a 2nd decompose)
          // unless the user added detail, which warrants a fresh plan.
          plan: clarifyText.trim() ? undefined : precomputedPlan || undefined,
          salt: outreachSalt(accountEmail),
          cohortHint: cohortHintFrom(community),
          // When profile-reading is off, don't learn from cross-project/team history either.
          useHistory: usesProfile,
          // Company accounts learn team-wide (highest priority); individuals omit this.
          teamWorkspaceId:
            usesProfile && profile.accountType === "company"
              ? profile.companyWorkspaceId || ""
              : "",
        }),
        signal: controller.signal,
      });
      // Errors (quota, credits) come back as a normal JSON response, not a stream.
      const ct = res.headers.get("content-type") || "";
      if (!res.ok || !ct.includes("ndjson")) {
        const data = await parseApiResponse(res);
        if (res.status === 402 && data?.code) {
          setUpgradePrompt({ code: data.code, tier: data.tier || "free" });
          return;
        }
        reportError(data);
        return;
      }

      // Stream: accumulate finds as they arrive so a cancel keeps what's scouted.
      const live: Opportunity[] = [];
      let done: any = null;
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let stopped = false;
      try {
        while (true) {
          const { value, done: streamDone } = await reader.read();
          if (streamDone) break;
          buf += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            let msg: any;
            try {
              msg = JSON.parse(line);
            } catch {
              continue;
            }
            if (msg.type === "opp" && msg.opp) {
              live.push(msg.opp);
              setOpps([...live]);
              setLiveCount(live.length);
            } else if (msg.type === "done") {
              done = msg.result;
            } else if (msg.type === "error") {
              reportError(msg);
              return;
            }
          }
        }
      } catch (streamErr: any) {
        // AbortError = the user hit Stop; keep the finds already streamed in.
        if (streamErr?.name === "AbortError") stopped = true;
        else throw streamErr;
      }

      // Normal finish: use the fully processed set (sorted, capped, enriched).
      // Cancelled finish: keep the raw finds already streamed in.
      const finalOpps: Opportunity[] = done?.opportunities || live;
      setOpps(finalOpps);
      setSelected({}); // nothing pre-approved, you approve who you want to reach
      setSkipped(done && Array.isArray(done.skipped) ? done.skipped : []);
      if (done) {
        setStats(
          `${finalOpps.length} found · ${done.searched} searches · ${done.candidates} pages read · skipped ${done.skippedDupes} duplicates, ${done.skippedNotFit} not a fit`
        );
      } else {
        setStats(`Stopped early · kept the ${finalOpps.length} ${finalOpps.length === 1 ? "find" : "finds"} scouted so far`);
      }
      const added = mergeFinds(finalOpps, runCatId);
      // Only count a search against usage when it ran to completion.
      if (done) bumpActivity({ searches: 1, found: finalOpps.length });
      if (added) setStats((s) => `${s} · ${added} new saved to Finds`);
    } catch (e: any) {
      if (e?.name === "AbortError") return; // cancelled before any stream read
      setError(e.message);
    } finally {
      discoverAbort.current = null;
      setDiscovering(false);
      setDiscoverStartedAt(null);
      setLiveCount(0);
    }
  }

  // Cancel an in-flight search but keep the finds already scouted (runDiscover
  // catches the abort and finalizes with whatever streamed in).
  function stopDiscover() {
    discoverAbort.current?.abort();
  }

  // Ask Scout to decompose the goal (no searching). Returns understanding %,
  // questions, and the plan. Best-effort; on any hiccup, acts as fully understood.
  async function fetchUnderstanding(clarifyText = "", asked: string[] = []) {
    const usesProfile = activeProject?.usesProfile !== false;
    const aboutForApi = usesProfile
      ? aboutText
      : activeProject?.context
        ? "This outreach is on behalf of / for: " + activeProject.context
        : "";
    const g = clarifyText.trim() ? `${goal}\n\nMore detail from me: ${clarifyText.trim()}` : goal;
    const token = getToken ? await getToken() : null;
    try {
      const res = await fetch("/api/plan", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ goal: g, about: aboutForApi, useCase: activeUseCase, asked }),
      });
      const d = await res.json().catch(() => ({}));
      // Questions may arrive as {question,options} objects (new) or bare strings
      // (older server / fallback). Normalize to the object shape the card wants.
      const questions = Array.isArray(d.questions)
        ? d.questions
            .map((q: any) =>
              typeof q === "string"
                ? { question: q, options: [] as string[] }
                : {
                    question: String(q?.question || "").trim(),
                    options: Array.isArray(q?.options)
                      ? q.options.map((o: any) => String(o || "").trim()).filter(Boolean)
                      : [],
                  }
            )
            .filter((q: { question: string }) => q.question)
        : [];
      return {
        understanding: typeof d.understanding === "number" ? d.understanding : 100,
        questions,
        plan: d.plan ?? null,
      };
    } catch {
      return {
        understanding: 100,
        questions: [] as { question: string; options: string[] }[],
        plan: null,
      };
    }
  }

  // The Scout button: first check how well Scout understands the goal. If there
  // are real gaps, pop the confidence card under the category and let the user
  // answer or run anyway. If it already understands well, just search.
  const UNDERSTAND_GATE = 90;
  async function startScout() {
    if (!profileComplete) {
      setTab("profile");
      return;
    }
    if (!goal.trim() || discovering || gating) return;
    setPlanGate(null);
    setPicks({});
    setOtherText({});
    setGating(true);
    try {
      const u = await fetchUnderstanding();
      if (u.understanding >= UNDERSTAND_GATE || u.questions.length === 0) {
        await runDiscover(u.plan);
      } else {
        setPlanGate(u);
      }
    } finally {
      setGating(false);
    }
  }

  // Compose EVERY answered question (across all sharpen rounds) into one string,
  // e.g. "Within 25 miles? This city only. Budget? Up to $2k". The picks map
  // persists and is keyed by the question's index in the accumulated list, so
  // the user can revise any earlier answer and this recomputes from the full set.
  function composeAllAnswers(): string {
    if (!planGate) return "";
    return planGate.questions
      .map((q, i) => {
        const pick = picks[i];
        if (!pick) return "";
        const ans = pick === "__other__" ? (otherText[i] || "").trim() : pick;
        return ans ? `${q.question} ${ans}` : "";
      })
      .filter(Boolean)
      .join(". ");
  }

  // How many questions the user has answered so far (gates Sharpen). Counts an
  // "Other" pick only once it has text.
  const answeredCount = planGate
    ? planGate.questions.filter((_, i) => {
        const pick = picks[i];
        if (!pick) return false;
        return pick === "__other__" ? (otherText[i] || "").trim().length > 0 : true;
      }).length
    : 0;

  // "Sharpen": re-run the understanding pass with ALL answers folded in, so the
  // % climbs as detail accumulates. Keep every question already shown (and its
  // answer) and only APPEND genuinely new questions — never reset picks — so the
  // user can always go back and change an earlier answer.
  async function sharpenPlan() {
    if (gating || answeredCount === 0) return;
    const answers = composeAllAnswers();
    const alreadyAsked = planGate ? planGate.questions.map((q) => q.question) : [];
    setGating(true);
    try {
      const u = await fetchUnderstanding(answers, alreadyAsked);
      setPlanGate((prev) => {
        const existing = prev ? prev.questions : [];
        const seen = new Set(existing.map((q) => q.question.trim().toLowerCase()));
        const added = u.questions.filter(
          (q: { question: string; options: string[] }) =>
            !seen.has(q.question.trim().toLowerCase())
        );
        return {
          understanding: u.understanding,
          questions: [...existing, ...added],
          plan: u.plan,
        };
      });
    } finally {
      setGating(false);
    }
  }

  // ---- Billing helpers ----
  // Load the signed-in user's plan + usage (source of truth is the server).
  async function loadBilling() {
    if (!getToken) return;
    const token = await getToken();
    if (!token) return;
    try {
      const res = await fetch("/api/billing/status", {
        headers: { authorization: `Bearer ${token}` },
      });
      if (res.ok) setBilling(await res.json());
    } catch {
      /* non-fatal: the UI falls back to a neutral state */
    }
  }

  // Redirect to Stripe Checkout for a plan (subscribe or upgrade).
  async function startCheckout(tier: "starter" | "pro") {
    if (!getToken) return;
    setBillingBusy(true);
    try {
      const token = await getToken();
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ tier }),
      });
      const j = await res.json().catch(() => ({}));
      if (j?.url) {
        window.location.href = j.url;
      } else if (j?.updated) {
        // Plan switched in place (existing subscriber), no redirect needed.
        setUpgradePrompt(null);
        setRepliesNote("Your plan was updated. Enjoy the extra searches!");
        setTimeout(loadBilling, 1500);
        setBillingBusy(false);
      } else {
        setError(j?.error || "Could not start checkout.");
        setBillingBusy(false);
      }
    } catch (e: any) {
      setError(e?.message || "Could not start checkout.");
      setBillingBusy(false);
    }
  }

  // Open the Stripe Customer Portal (manage/cancel/switch/update card).
  async function openBillingPortal() {
    if (!getToken) return;
    setBillingBusy(true);
    try {
      const token = await getToken();
      const res = await fetch("/api/billing/portal", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      const j = await res.json().catch(() => ({}));
      if (j?.url) {
        window.location.href = j.url;
      } else {
        setError(j?.error || "Could not open the billing portal.");
        setBillingBusy(false);
      }
    } catch (e: any) {
      setError(e?.message || "Could not open the billing portal.");
      setBillingBusy(false);
    }
  }

  // Redeem an access code for free-forever (comp) access. Returns an error
  // string on failure (shown inline in the Billing tab), or "" on success.
  async function redeemCode(code: string): Promise<string> {
    if (!getToken) return "Please sign in first.";
    const token = await getToken();
    if (!token) return "Please sign in first.";
    try {
      const res = await fetch("/api/billing/redeem", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ code }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j?.ok) {
        await loadBilling();
        return "";
      }
      return j?.error || "Could not redeem that code.";
    } catch (e: any) {
      return e?.message || "Could not redeem that code.";
    }
  }

  // ---- Company onboarding (Teams) helpers ----
  // The directory of existing companies a new user can join.
  async function listCompanies(): Promise<
    { id: string; name: string; about: string; industry: string; memberCount: number; domainMatch: boolean; alreadyMember: boolean }[]
  > {
    if (!getToken) return [];
    const token = await getToken();
    if (!token) return [];
    try {
      const res = await fetch("/api/team/companies", {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) return [];
      const j = await res.json();
      return j.companies || [];
    } catch {
      return [];
    }
  }
  // Create a new company (workspace). Returns its id, or an error string.
  async function createCompany(info: {
    name: string;
    about?: string;
    website?: string;
    industry?: string;
  }): Promise<{ id?: string; error?: string }> {
    if (!getToken) return { error: "Please sign in first." };
    const token = await getToken();
    if (!token) return { error: "Please sign in first." };
    try {
      const res = await fetch("/api/team/workspace", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(info),
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j?.workspace?.id) return { id: j.workspace.id };
      return { error: j?.error || "Could not create the company." };
    } catch (e: any) {
      return { error: e?.message || "Could not create the company." };
    }
  }
  // Join an existing company by id. Returns its name, or an error string.
  async function joinCompany(workspaceId: string): Promise<{ name?: string; error?: string }> {
    if (!getToken) return { error: "Please sign in first." };
    const token = await getToken();
    if (!token) return { error: "Please sign in first." };
    try {
      const res = await fetch("/api/team/companies", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ workspaceId }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j?.workspace) return { name: j.workspace.name };
      return { error: j?.error || "Could not join that company." };
    } catch (e: any) {
      return { error: e?.message || "Could not join that company." };
    }
  }

  // Load plan/usage on mount. If we're returning from Checkout (?billing=success),
  // Stripe's webhook may land a beat later, so re-check shortly after and clean the URL.
  useEffect(() => {
    loadBilling();
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const billingParam = params.get("billing");
    if (params.get("tab") === "billing") setTab("billing");
    if (billingParam === "success") {
      setTab("billing");
      setRepliesNote("Thanks, your plan is active. It may take a moment to update.");
      const t = setTimeout(loadBilling, 2500);
      window.history.replaceState({}, "", "/app");
      return () => clearTimeout(t);
    }
    if (billingParam === "cancel") {
      window.history.replaceState({}, "", "/app");
    }
    // Run once on mount; getToken reads the live session each call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
          dismissedAdvice,
          editPairs,
          signature: signatureFor(activeId),
        }),
      });
      const data = await parseApiResponse(res);
      if (!res.ok || data?.error) {
        reportError(data);
        return;
      }
      const newDrafts: Draft[] = data.drafts || [];
      setDrafts(newDrafts);
      setRedraftChat([]); // fresh batch, start the refine thread clean
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

  // "Direct the AI" chat box above Messages: apply one free-text instruction
  // across every draft currently shown, in a single pass. Revises subject/body
  // only (see reviseDraft in lib/draft.ts), everything else about the draft
  // (recipient, channel, attach-resume) stays put. Persists onto the matching
  // finds so the revision survives navigating away.
  async function reviseAllDrafts() {
    const instruction = redraftInstruction.trim();
    if (!instruction || !drafts.length || revisingBatch) return;
    setError("");
    // Log the request (so you can see what you've already asked for) and clear
    // the input. Scout never replies here, it just applies the change.
    setRedraftChat((c) => [...c, { text: instruction }]);
    setRedraftInstruction("");
    setRevisingBatch(true);
    try {
      const res = await fetch("/api/redraft-batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ drafts, instruction, about: aboutText }),
      });
      const data = await parseApiResponse(res);
      if (!res.ok || data?.error) {
        reportError(data);
        return;
      }
      const revised: Draft[] = data.drafts || [];
      setDrafts(revised);
      const byOppId = new Map(revised.map((d) => [d.opportunityId, d]));
      saveFinds(
        finds.map((f) =>
          f.draft && byOppId.has(f.draft.opportunityId)
            ? { ...f, draft: byOppId.get(f.draft.opportunityId)! }
            : f
        )
      );
    } catch (e: any) {
      setError(e.message);
    } finally {
      setRevisingBatch(false);
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
          dismissedAdvice,
          editPairs,
          signature: signatureFor(activeId),
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
      {/* Blocking first-run gate: you can't reach Scout until you pick
          individual vs company (and answer the company questions if company).
          profileLoaded gates ScoutTool, so profile.accountType is already
          authoritative here, no flash for returning users. */}
      {!profile.accountType && (
        <AccountOnboarding
          name={profile.name.trim().split(/\s+/)[0] || ""}
          onComplete={(patch) => patchProfile(patch)}
          listCompanies={listCompanies}
          createCompany={createCompany}
          joinCompany={joinCompany}
        />
      )}
      <SideNav
        tab={tab}
        setTab={setTab}
        newFindCount={newFindCount}
        templatesCount={myTemplates.length}
        profileHasBio={!!profile.bio.trim()}
        hasAccount={!!accountEmail}
        isCompany={profile.accountType === "company"}
        billingTier={billing?.tier}
        openCommand={() => setCmdOpen(true)}
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

            {/* -------- Import your existing outreach (dedup + learn) -------- */}
            <section className="mb-6 flex flex-wrap items-center gap-3 rounded-2xl border border-warm-border bg-surface p-4 shadow-card">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brown-tint text-brown-deep">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M7 10l5 5 5-5" /><path d="M12 15V3" /></svg>
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-extrabold text-ink">
                  Already reaching out somewhere else?
                </div>
                <p className="mt-0.5 text-xs leading-relaxed text-body/80">
                  Drop in a CSV of how you&apos;ve been tracking your contacts. Scout won&apos;t
                  resurface them and starts learning what a fit looks like for you.
                </p>
              </div>
              <button
                onClick={() => setImportOpen(true)}
                className="shrink-0 rounded-xl bg-brown px-4 py-2 text-xs font-bold text-white shadow-soft transition hover:opacity-90"
              >
                Import a CSV
              </button>
            </section>

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
                    <Label className="mb-0">What is this project for?</Label>
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

                  {/* Per-project: read my profile + learn from my other searches? */}
                  <label className="mt-3 flex cursor-pointer items-start gap-2.5">
                    <input
                      type="checkbox"
                      checked={activeProject?.usesProfile !== false}
                      onChange={(e) => setProjectUsesProfile(activeId, e.target.checked)}
                      className="mt-0.5 h-4 w-4 shrink-0 rounded border-warm-border text-brown accent-brown focus:ring-brown/30"
                    />
                    <span className="text-xs leading-relaxed text-body/80">
                      <span className="font-semibold text-ink">Use my Profile for this project</span>
                      <br />
                      On, searches match your industry and learn from your other projects. Turn
                      it off when this project is disconnected from you (representing someone
                      outside your field) so results don&apos;t bias toward you.
                    </span>
                  </label>
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
                  <p className="mt-3 text-xs leading-relaxed text-body/70">
                    {catId
                      ? "Edits here save automatically to this category."
                      : "Running this custom search saves it as a new category automatically."}{" "}
                    Categories belong to{" "}
                    <span className="font-semibold text-body">
                      {activeProject?.name || "this project"}
                    </span>
                    . Tap the pencil to rename or remove them.
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
                            ? "Any level, Scout won't filter by selectivity."
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
                    placeholder={goalPlaceholder}
                    rows={3}
                    className="w-full resize-y rounded-xl border border-warm-border px-3.5 py-3 text-sm text-ink outline-none transition focus:border-coral focus:ring-4 focus:ring-coral/15"
                  />
                  <p className="mt-1.5 text-xs text-body/70">
                    Tip: add your industry, genre, or city to sharpen the results.
                  </p>

                  <div className="mt-3">
                    <ContactChannelsPicker
                      selected={wantedChannels}
                      onToggle={toggleWantedChannel}
                      saved={!!catId}
                    />
                  </div>

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
                  ref={scoutBtnRef}
                  onClick={startScout}
                  disabled={discovering || gating || !goal.trim()}
                  className="rounded-xl bg-brand-gradient px-6 py-3 text-sm font-bold text-white shadow-soft transition hover:opacity-95 disabled:opacity-50"
                >
                  {discovering ? "Scouting…" : gating ? "Understanding…" : "Scout"}
                </button>
                {discovering && (
                  <button
                    onClick={stopDiscover}
                    className="rounded-xl border border-warm-border px-4 py-3 text-sm font-semibold text-body transition hover:border-coral/40 hover:bg-warm-bg hover:text-accent"
                  >
                    {liveCount > 0
                      ? `Stop & keep ${liveCount} ${liveCount === 1 ? "find" : "finds"}`
                      : "Stop"}
                  </button>
                )}
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

              {/* Confidence gate: Scout has gaps, so ask before running. */}
              {planGate && (
                <div className="mt-5 overflow-hidden rounded-2xl border border-coral/30 bg-warm-bg/50 shadow-card">
                  <div className="flex flex-wrap items-center gap-3 border-b border-warm-border bg-surface px-5 py-4">
                    <div className="relative h-11 w-11 shrink-0">
                      <svg viewBox="0 0 36 36" className="h-11 w-11 -rotate-90">
                        <circle cx="18" cy="18" r="15.5" fill="none" stroke="currentColor" strokeWidth="3" className="text-warm-border" />
                        <circle
                          cx="18" cy="18" r="15.5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"
                          className="text-coral transition-all"
                          strokeDasharray={`${(planGate.understanding / 100) * 97.4} 97.4`}
                        />
                      </svg>
                      <span className="absolute inset-0 grid place-items-center text-[11px] font-extrabold text-ink">
                        {planGate.understanding}%
                      </span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-extrabold tracking-tight text-ink">
                        Scout understands {planGate.understanding}% of your inquiry
                      </div>
                      <p className="mt-0.5 text-xs leading-relaxed text-body/80">
                        A few details would sharpen the search. Answer what you can, or run
                        Scout now.
                      </p>
                    </div>
                  </div>
                  <div className="px-5 py-4">
                    <div className="space-y-4">
                      {planGate.questions.map((q, i) => (
                        <div key={i}>
                          <div className="text-xs font-bold leading-relaxed text-ink">
                            {q.question}
                          </div>
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {q.options.map((opt, j) => {
                              const active = picks[i] === opt;
                              return (
                                <button
                                  key={j}
                                  onClick={() =>
                                    setPicks((p) => ({ ...p, [i]: opt }))
                                  }
                                  className={
                                    "rounded-full border px-3 py-1.5 text-xs font-semibold transition " +
                                    (active
                                      ? "border-coral bg-coral text-white"
                                      : "border-warm-border bg-surface text-body hover:border-coral/40 hover:text-accent")
                                  }
                                >
                                  {opt}
                                </button>
                              );
                            })}
                            <button
                              onClick={() =>
                                setPicks((p) => ({ ...p, [i]: "__other__" }))
                              }
                              className={
                                "rounded-full border border-dashed px-3 py-1.5 text-xs font-semibold transition " +
                                (picks[i] === "__other__"
                                  ? "border-coral bg-coral text-white"
                                  : "border-warm-border bg-surface text-body hover:border-coral/40 hover:text-accent")
                              }
                            >
                              Other…
                            </button>
                          </div>
                          {picks[i] === "__other__" && (
                            <input
                              value={otherText[i] || ""}
                              onChange={(e) =>
                                setOtherText((t) => ({ ...t, [i]: e.target.value }))
                              }
                              autoFocus
                              placeholder="Type your answer…"
                              className="mt-2 w-full rounded-xl border border-warm-border bg-surface px-3.5 py-2 text-sm leading-relaxed text-ink outline-none transition focus:border-coral focus:ring-4 focus:ring-coral/15"
                            />
                          )}
                        </div>
                      ))}
                    </div>
                    <div className="mt-4 flex flex-wrap items-center gap-2">
                      <button
                        onClick={sharpenPlan}
                        disabled={answeredCount === 0 || gating}
                        className="rounded-xl bg-brown px-4 py-2 text-sm font-bold text-white shadow-soft transition hover:bg-brown-deep disabled:opacity-40"
                      >
                        {gating ? "Sharpening…" : "Sharpen understanding"}
                      </button>
                      <button
                        onClick={() => runDiscover(planGate.plan, composeAllAnswers())}
                        disabled={discovering}
                        className="rounded-xl border border-warm-border px-4 py-2 text-sm font-semibold text-body transition hover:border-coral/40 hover:bg-warm-bg hover:text-accent"
                      >
                        Run Scout
                      </button>
                      <button
                        onClick={() => setPlanGate(null)}
                        className="ml-auto text-xs font-semibold text-body/50 transition hover:text-accent"
                      >
                        Dismiss
                      </button>
                    </div>
                  </div>
                </div>
              )}

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

            {/* ---------------- Results as a chat bubble ---------------- */}
            {visibleOpps.length > 0 && (
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
                          I found {visibleOpps.length} {uc.targetNoun} who fit. Pick who to
                          reach out to.
                          {opps.length > visibleOpps.length && (
                            <>
                              {" "}
                              <span className="text-body/50">
                                ({opps.length - visibleOpps.length} you already passed on
                                hidden)
                              </span>
                            </>
                          )}
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
                {/* Refine box: type an instruction, it rewrites every draft
                    below. No back-and-forth, it just applies the change and
                    keeps a short log of what you've asked for. */}
                <div className="mb-5 overflow-hidden rounded-2xl border border-warm-border bg-surface shadow-soft">
                  <div className="border-b border-warm-border px-4 py-3">
                    <div className="text-sm font-bold text-ink">Refine your messages</div>
                    <div className="text-xs text-body/70">
                      Tell Scout how to rewrite all {drafts.length} message
                      {drafts.length === 1 ? "" : "s"} below.
                    </div>
                  </div>

                  {redraftChat.length > 0 && (
                    <div
                      ref={redraftScrollRef}
                      className="max-h-40 space-y-1.5 overflow-y-auto px-4 py-3"
                    >
                      {redraftChat.map((m, i) => (
                        <div key={i} className="flex items-start gap-2 text-sm text-body">
                          <span className="mt-0.5 shrink-0 text-body/40" aria-hidden>
                            ✓
                          </span>
                          <span>{m.text}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="flex items-end gap-2 border-t border-warm-border px-3 py-3">
                    <textarea
                      value={redraftInstruction}
                      onChange={(e) => setRedraftInstruction(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          reviseAllDrafts();
                        }
                      }}
                      rows={1}
                      placeholder={
                        redraftChat.length
                          ? "Another change…"
                          : "e.g. make these shorter and more casual, and mention I'm a recent grad"
                      }
                      className="min-h-[42px] max-h-32 min-w-0 flex-1 resize-none rounded-xl border border-warm-border px-3.5 py-2.5 text-sm text-ink outline-none transition focus:border-coral focus:ring-4 focus:ring-coral/15"
                    />
                    <MicButton
                      onAppend={(t) => setRedraftInstruction((g) => joinSpoken(g, t))}
                    />
                    <button
                      onClick={reviseAllDrafts}
                      disabled={revisingBatch || !redraftInstruction.trim()}
                      className="shrink-0 rounded-xl bg-brand-gradient px-4 py-2.5 text-sm font-bold text-white shadow-soft transition hover:opacity-95 disabled:opacity-40"
                    >
                      {revisingBatch ? "Applying…" : "Apply"}
                    </button>
                  </div>
                </div>

                <h2 className="mb-4 text-lg font-bold text-ink">
                  Messages ({drafts.length})
                </h2>
                <div className="space-y-4">
                  {drafts.map((d, i) => {
                    const opp = opps.find((o) => o.id === d.opportunityId);
                    // Every draft here already has a backing Find record (runDraft
                    // stamps status "drafted" onto it), look it up so status can
                    // be changed right here instead of forcing a trip to Finds.
                    const relatedFind = opp
                      ? finds.find((f) => f.id === findKey(activeId, opp))
                      : undefined;
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
                          {relatedFind && (
                            <FindStatusBadge
                              status={relatedFind.status}
                              onStatus={(s) => setFindStatus(relatedFind.id, s)}
                            />
                          )}
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
          categories={categories}
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
          onMoveProject={(f, pid) => moveFindToProject(f.id, pid)}
          getSignatureFor={signatureFor}
          onEditSignature={setProjectSignature}
          onCheckReplies={checkReplies}
          repliesBusy={repliesBusy}
          repliesNote={repliesNote}
          goOutreach={() => setTab("outreach")}
          senderName={profile.name || ""}
          senderEmail={accountEmail || activeMailbox.email || ""}
          senderExtra={{
            location: profile.location || "",
            linkedin: profile.linkedin || "",
            company: profile.accountType === "company" ? profile.companyName || "" : "",
            role: profile.companyRole || "",
          }}
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
          dismissedAdvice={dismissedAdvice}
          editPairs={editPairs}
          onApplyTip={addCoaching}
          onRemoveTip={removeCoaching}
          onDismissAdvice={dismissAdvice}
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
          getToken={getToken}
          openCommand={() => setCmdOpen(true)}
          onOpenFind={(f) => setPeekFind(f)}
        />
      )}

      {tab === "team" && profile.accountType === "company" && (
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
          onUpdate={updateTemplate}
          projects={projects}
          categories={categories}
          scopeProjectId={mtProjectId}
          scopeCategoryId={mtCategoryId}
          setScopeProjectId={(id) => {
            setMtProjectId(id);
            setMtCategoryId(""); // switching project clears the category choice
          }}
          setScopeCategoryId={setMtCategoryId}
          signature={signature}
          onSignature={saveSignature}
          onBuildSignature={buildSignatureFromBio}
          setProjectSignature={setProjectSignature}
          activeProjectId={activeId}
        />
      )}

      {tab === "profile" && (
        <ProfileTab
          name={profile.name}
          bio={profile.bio}
          linkedin={profile.linkedin || ""}
          useCase={profile.useCase}
          accountType={profile.accountType || ""}
          companyWorkspaceId={profile.companyWorkspaceId || ""}
          getToken={getToken}
          companyName={profile.companyName || ""}
          companyRole={profile.companyRole || ""}
          companyContribution={profile.companyContribution || ""}
          onCompanyName={(v) => patchProfile({ companyName: v })}
          onCompanyRole={(v) => patchProfile({ companyRole: v })}
          onCompanyContribution={(v) => patchProfile({ companyContribution: v })}
          age={profile.age}
          eduStatus={profile.eduStatus || ""}
          college={profile.college || ""}
          major={profile.major || ""}
          location={profile.location || ""}
          companySize={profile.companySize || "any"}
          competitiveness={profile.competitiveness || "any"}
          onName={(v) => patchProfile({ name: v })}
          onBio={(v) => patchProfile({ bio: v })}
          onLinkedin={(v) => patchProfile({ linkedin: v })}
          onAge={(v) => patchProfile({ age: v })}
          onEduStatus={(v) => patchProfile({ eduStatus: v })}
          onCollege={(v) => patchProfile({ college: v })}
          onMajor={(v) => patchProfile({ major: v })}
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
          onSetProjectContext={setProjectContext}
          onSetProjectUsesProfile={setProjectUsesProfile}
          resumeFileName={resumeFile?.name || ""}
          onResumeFile={storeResumeFile}
          onClearResume={() => saveResumeFile(null)}
          signature={signature}
          onSignature={saveSignature}
        />
      )}

      {tab === "account" && accountEmail && (
        <main className="mx-auto max-w-3xl px-6 py-12">
          <h1 className="text-2xl font-semibold tracking-tight text-ink">
            Your <span className="text-brown">account</span>
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

          {/* Send from your email — connect the mailbox Scout sends outreach from. */}
          {!!getToken && (
            <section className="mt-6 rounded-3xl border border-warm-border bg-surface p-6 shadow-soft sm:p-8">
              <h2 className="text-base font-extrabold tracking-tight text-ink">
                Send from your email
              </h2>
              <p className="mt-1.5 text-sm leading-relaxed text-body">
                Connect Gmail or Outlook so Scout can draft and send outreach from your
                own inbox in one click.
              </p>
              <div className="mt-4">
                {!gmail.connected && !outlook.connected && (
                  <ConnectEmailCard
                    note={gmailNote || outlookNote}
                    onConnectGmail={connectGmail}
                    onConnectOutlook={connectOutlook}
                  />
                )}
                {gmail.connected && (
                  <MailboxCard
                    provider="gmail"
                    conn={gmail}
                    note={gmailNote}
                    onConnect={connectGmail}
                    onDisconnect={disconnectGmail}
                    onMode={setGmailMode}
                  />
                )}
                {outlook.connected && (
                  <MailboxCard
                    provider="outlook"
                    conn={outlook}
                    note={outlookNote}
                    onConnect={connectOutlook}
                    onDisconnect={disconnectOutlook}
                    onMode={setOutlookMode}
                  />
                )}
              </div>
            </section>
          )}

          {isOwner && (
            <section className="mt-6 rounded-3xl border border-warm-border bg-surface p-6 shadow-soft sm:p-8">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="max-w-md">
                  <h2 className="text-base font-extrabold tracking-tight text-ink">
                    Team admin
                  </h2>
                  <p className="mt-1.5 text-sm leading-relaxed text-body">
                    Aggregate view of every user's denials, approvals, and
                    reasons, the signal for tuning Scout's discovery. Only
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
        <SettingsTab
          onStartTour={startTour}
          onExport={exportMyData}
          onRedeem={redeemCode}
          isComp={!!billing?.comp}
        />
      )}

      {tab === "billing" && (
        <BillingTab
          billing={billing}
          busy={billingBusy}
          onSubscribe={startCheckout}
          onManage={openBillingPortal}
          onRefresh={loadBilling}
          onRedeem={redeemCode}
        />
      )}

      </div>

      {/* ---------------- Footer ---------------- */}
      <footer className="relative border-t border-warm-border bg-surface/70">
        <CornerDog />
        <div className="flex w-full flex-wrap items-center gap-2 px-6 py-6 text-xs text-body/70">
          <Logo small />
          <span className="font-semibold text-ink">
            <span className="text-brown">Scout</span>
          </span>
          <span className="ml-auto font-semibold text-body">Find Your People</span>
        </div>
      </footer>

      {/* ---------------- Command palette (⌘K) + row peek ---------------- */}
      <CommandPalette
        open={cmdOpen}
        onClose={() => setCmdOpen(false)}
        finds={finds}
        hasAccount={!!accountEmail}
        onGo={(t) => {
          setTab(t);
          setCmdOpen(false);
        }}
        onOpenFind={(f) => {
          setPeekFind(f);
          setCmdOpen(false);
        }}
      />
      <FindPeek
        find={peekFind}
        onClose={() => setPeekFind(null)}
        onOpenInFinds={() => {
          setPeekFind(null);
          setTab("finds");
        }}
      />

      {/* ---------------- Out-of-searches upgrade prompt ---------------- */}
      {upgradePrompt && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-ink/40 p-4 backdrop-blur-sm"
          onClick={() => setUpgradePrompt(null)}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-warm-border bg-surface p-6 shadow-soft"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="grid h-11 w-11 place-items-center rounded-xl bg-brown-tint text-brown-deep">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" />
              </svg>
            </div>
            <h2 className="mt-4 text-lg font-semibold tracking-tight text-ink">
              {upgradePrompt.code === "free_exhausted"
                ? "You've used your free searches"
                : upgradePrompt.tier === "starter"
                ? "You've hit your Starter limit"
                : "You've used every search this month"}
            </h2>
            <p className="mt-1.5 text-sm leading-relaxed text-body">
              {upgradePrompt.code === "free_exhausted"
                ? "You get 5 free searches a month. Pick a plan to keep scouting, it resets on the 1st either way."
                : upgradePrompt.tier === "starter"
                ? "Starter includes 30 searches a month. Upgrade to Pro for 60, you keep going right away, and Stripe only charges the difference."
                : "Pro includes 60 searches a month. Your allowance refreshes at the start of your next billing cycle."}
            </p>

            <div className="mt-5 space-y-2.5">
              {upgradePrompt.code === "free_exhausted" && (
                <>
                  <button
                    onClick={() => startCheckout("starter")}
                    disabled={billingBusy}
                    className="flex w-full items-center justify-between rounded-xl border border-warm-border px-4 py-3 text-left transition hover:border-brown hover:bg-brown-tint/40 disabled:opacity-50"
                  >
                    <span>
                      <span className="block text-sm font-semibold text-ink">Starter, 30 searches</span>
                      <span className="block text-xs text-muted">$15 / month</span>
                    </span>
                    <span className="text-sm font-semibold text-brown">Choose →</span>
                  </button>
                  <button
                    onClick={() => startCheckout("pro")}
                    disabled={billingBusy}
                    className="flex w-full items-center justify-between rounded-xl border border-brown bg-brown-tint/40 px-4 py-3 text-left transition hover:bg-brown-tint disabled:opacity-50"
                  >
                    <span>
                      <span className="block text-sm font-semibold text-ink">Pro, 60 searches</span>
                      <span className="block text-xs text-muted">$30 / month</span>
                    </span>
                    <span className="text-sm font-semibold text-brown">Choose →</span>
                  </button>
                </>
              )}
              {upgradePrompt.code === "quota" && upgradePrompt.tier === "starter" && (
                <button
                  onClick={() => startCheckout("pro")}
                  disabled={billingBusy}
                  className="w-full rounded-xl bg-brown px-4 py-3 text-sm font-semibold text-white shadow-soft transition hover:bg-brown-deep disabled:opacity-50"
                >
                  {billingBusy ? "Opening checkout…" : "Upgrade to Pro, $30/mo for 60"}
                </button>
              )}
            </div>

            <button
              onClick={() => setUpgradePrompt(null)}
              className="mt-3 w-full rounded-xl border border-warm-border px-4 py-2.5 text-sm font-semibold text-body transition hover:bg-warm-bg"
            >
              {upgradePrompt.tier === "pro" && upgradePrompt.code === "quota" ? "Got it" : "Maybe later"}
            </button>
          </div>
        </div>
      )}
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
                  {visibleOpps.length} {uc.targetNoun} who fit
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
 * Discovery takes ~30-60s and the API doesn't stream progress, so we show a
 * synthetic bar that eases toward ~92% (fast at first, slow near the end) and
 * rotates through stage labels. `startedAt` is a timestamp lifted to the parent
 * so the bar computes progress from the real search start, that way switching
 * tabs and coming back resumes at the correct percentage instead of restarting.
 * When `active` flips false we snap to 100% before unmounting. */
const SEARCH_STAGES = [
  "Reading the web",
  "Finding real contacts",
  "Checking who fits",
  "Ranking your matches",
  "Almost there",
];
const SEARCH_TAU = 22000; // easing time constant, controls approach speed
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
  // Transient display values, updated every animation frame directly on the
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
  // Same trick as SearchProgress, write to the DOM directly in the RAF tick
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
  isCompany,
  billingTier,
  openCommand,
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
  isCompany: boolean;
  billingTier?: "free" | "starter" | "pro";
  openCommand: () => void;
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
    ...(hasAccount && isCompany
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
    <aside className="sticky top-0 flex h-screen w-[236px] shrink-0 flex-col gap-0.5 border-r border-warm-border bg-surface-2 p-2.5">
      <a
        href="/"
        aria-label="Scout home"
        title="Back to homepage"
        className="flex items-center gap-2.5 rounded-lg px-2 pb-3 pt-1.5 transition hover:opacity-80"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/scout-logo.png" alt="Scout" width={22} height={22} className="h-[22px] w-[22px]" />
        <span className="text-[15px] font-semibold tracking-tight text-ink">Scout</span>
      </a>

      <button
        onClick={openCommand}
        className="mb-1 flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13.5px] text-muted transition hover:bg-warm-bg"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-muted/80"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
        Search
        <span className="ml-auto text-[11px] text-muted/70">⌘K</span>
      </button>
      <nav className="flex flex-col gap-0.5">
        {items.map((it) => {
          const active = tab === it.key;
          return (
            <button
              key={it.key}
              data-tour={`nav-${it.key}`}
              onClick={() => setTab(it.key)}
              className={`flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[14px] transition ${
                active
                  ? "bg-brown-tint font-medium text-brown-deep"
                  : "font-normal text-body hover:bg-warm-bg"
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
            className={`mt-2 flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[14px] transition ${
              tab === "account"
                ? "bg-brown-tint font-medium text-brown-deep"
                : "font-normal text-body hover:bg-warm-bg"
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
        {hasAccount && (
          <button
            onClick={() => setTab("billing")}
            className={`mt-0.5 flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[14px] transition ${
              tab === "billing"
                ? "bg-brown-tint font-medium text-brown-deep"
                : "font-normal text-body hover:bg-warm-bg"
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
              className={tab === "billing" ? "" : "opacity-80"}
            >
              <rect x="2" y="5" width="20" height="14" rx="2.5" />
              <path d="M2 10h20" />
            </svg>
            Plan &amp; billing
            {billingTier && billingTier !== "free" && (
              <span
                className={`ml-auto rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                  tab === "billing" ? "bg-brown text-white" : "bg-brown-tint text-brown-deep"
                }`}
              >
                {billingTier}
              </span>
            )}
          </button>
        )}
        <button
          onClick={() => setTab("settings")}
          className={`mt-0.5 flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[14px] transition ${
            tab === "settings"
              ? "bg-brown-tint font-medium text-brown-deep"
              : "font-normal text-body hover:bg-warm-bg"
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
    // Plain grid, NOT <Reveal>: these cards are inserted dynamically after a
    // search, inside a scrollable container. A scroll-triggered reveal leaves
    // them stuck at opacity 0 because ScrollTrigger's positions are stale, so
    // the whole result list renders blank. (That was the "search did nothing"
    // bug.)
    <div className={`grid gap-3 ${roomy ? "lg:grid-cols-2" : "grid-cols-1"}`}>
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
                {o.targetType === "listing" && (
                  <span className="rounded-full bg-sage px-2 py-0.5 text-[10px] font-bold text-white">
                    Apply
                  </span>
                )}
                {o.targetType === "company" && (
                  <span className="rounded-full border border-warm-border bg-surface px-2 py-0.5 text-[10px] font-semibold text-body/80">
                    Cold email
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
                {o.contactPhone && (
                  <span className="text-body/70">
                    {o.contactEmail || o.contactName || o.contactHandle ? "  ·  " : ""}
                    <a
                      href={`tel:${o.contactPhone.replace(/[^\d+]/g, "")}`}
                      className="text-body/70 underline-offset-2 hover:text-accent hover:underline"
                    >
                      {o.contactPhone}
                    </a>
                  </span>
                )}
                {!o.contactEmail && !o.contactName && !o.contactHandle && !o.contactPhone && (
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
    </div>
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
  // A domain/handle like "linkedin.com/in/x" or "twitter.com/x", make it absolute.
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
// Split a stored deny reason back into its preset + free-text elaboration, so
// editing an existing reason repopulates both parts.
function parseDenyReason(current?: string): { base: string | null; extra: string } {
  const c = (current || "").trim();
  if (!c) return { base: null, extra: "" };
  for (const r of DENY_REASONS) {
    if (c === r) return { base: r, extra: "" };
    if (c.startsWith(r + ", ")) return { base: r, extra: c.slice((r + ", ").length) };
  }
  return { base: "", extra: c }; // fully custom ("Other") reason
}

function DenyReasons({
  current,
  onPick,
}: {
  current?: string;
  onPick: (reason: string) => void;
}) {
  const parsed = parseDenyReason(current);
  // "pick" = choosing a reason chip; "elaborate" = optional detail step that
  // pops up after a chip is chosen. Start in elaborate when editing an existing
  // reason so its detail is visible.
  const [phase, setPhase] = useState<"pick" | "elaborate">(current ? "elaborate" : "pick");
  const [base, setBase] = useState<string>(parsed.base ?? "");
  const [extra, setExtra] = useState<string>(parsed.extra);

  function choose(label: string) {
    setBase(label);
    setExtra("");
    setPhase("elaborate");
  }
  function commit() {
    const b = base.trim();
    const e = extra.trim();
    const final = b && e ? `${b}, ${e}` : b || e;
    if (!final) return;
    onPick(final);
  }

  if (phase === "pick") {
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        {DENY_REASONS.map((r) => (
          <button
            key={r}
            onClick={() => choose(r)}
            className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold transition ${
              current === r
                ? "border-coral/50 bg-brand-gradient text-white"
                : "border-warm-border bg-surface text-body hover:bg-warm-bg"
            }`}
          >
            {r}
          </button>
        ))}
        <button
          onClick={() => choose("")}
          className="rounded-full border border-warm-border bg-surface px-2.5 py-1 text-[11px] font-semibold text-body/70 transition hover:bg-warm-bg"
        >
          Other…
        </button>
      </div>
    );
  }

  return (
    <div className="w-full max-w-md rounded-xl border border-warm-border bg-surface p-2.5 shadow-card">
      <div className="mb-1.5 flex items-center gap-1.5">
        {base ? (
          <span className="rounded-full bg-brand-gradient px-2.5 py-1 text-[11px] font-semibold text-white">
            {base}
          </span>
        ) : (
          <span className="text-[11px] font-semibold text-body/70">Other reason</span>
        )}
        <button
          onClick={() => setPhase("pick")}
          className="text-[11px] font-semibold text-body/45 transition hover:text-accent"
        >
          change
        </button>
      </div>
      <div className="relative">
        <textarea
          autoFocus
          value={extra}
          onChange={(e) => setExtra(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) commit();
          }}
          rows={2}
          placeholder={
            base ? "Add a detail (optional), e.g. what made them wrong" : "Your reason…"
          }
          className="w-full resize-y rounded-lg border border-warm-border bg-warm-bg/30 px-2.5 py-2 pr-9 text-[12px] leading-relaxed text-ink outline-none transition focus:border-coral focus:ring-2 focus:ring-coral/15"
        />
        <div className="absolute right-1.5 top-1.5">
          <DictateButton onText={(t) => setExtra((v) => (v.trim() ? v.trim() + " " + t : t))} />
        </div>
      </div>
      <div className="mt-1.5 flex items-start gap-1.5 rounded-lg bg-sage/10 px-2 py-1.5 text-[10.5px] leading-snug text-body/70">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="mt-px shrink-0 text-sage">
          <path d="M12 2a7 7 0 0 0-4 12.7V17a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-2.3A7 7 0 0 0 12 2Z" />
          <path d="M9 22h6" />
        </svg>
        <span>Elaborating teaches Scout what to skip next time, the more you say, the better it learns your taste.</span>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={commit}
          disabled={!base && !extra.trim()}
          className="rounded-lg bg-brand-gradient px-3 py-1.5 text-[11px] font-bold text-white shadow-card transition hover:opacity-95 disabled:opacity-40"
        >
          {extra.trim() ? "Save reason" : base ? "Save reason" : "Save"}
        </button>
        <span className="text-[10px] text-body/40">Detail is optional · ⌘⏎ to save</span>
      </div>
    </div>
  );
}

// Mic button that dictates into a text field via the browser's Web Speech API.
// Silently hides when the browser doesn't support it (e.g. Firefox). Each final
// phrase is handed back via onText so the caller can append it.
function DictateButton({ onText }: { onText: (t: string) => void }) {
  const [listening, setListening] = useState(false);
  const [supported, setSupported] = useState(false);
  const recRef = useRef<any>(null);

  useEffect(() => {
    const SR =
      (typeof window !== "undefined" &&
        ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition)) ||
      null;
    if (!SR) return;
    setSupported(true);
    const rec = new SR();
    rec.lang = "en-US";
    rec.continuous = true;
    rec.interimResults = false;
    rec.onresult = (e: any) => {
      let finalText = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) finalText += e.results[i][0].transcript;
      }
      finalText = finalText.trim();
      if (finalText) onText(finalText);
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recRef.current = rec;
    return () => {
      try {
        rec.stop();
      } catch {
        /* already stopped */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggle() {
    const rec = recRef.current;
    if (!rec) return;
    if (listening) {
      try {
        rec.stop();
      } catch {}
      setListening(false);
    } else {
      try {
        rec.start();
        setListening(true);
      } catch {
        /* start() throws if already running, ignore */
      }
    }
  }

  if (!supported) return null;
  return (
    <button
      type="button"
      onClick={toggle}
      title={listening ? "Stop dictation" : "Dictate your reason"}
      aria-label={listening ? "Stop dictation" : "Dictate your reason"}
      className={`grid h-7 w-7 place-items-center rounded-lg border transition ${
        listening
          ? "animate-pulse border-coral bg-coral/10 text-coral"
          : "border-warm-border bg-surface text-body/60 hover:bg-warm-bg hover:text-accent"
      }`}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
        <rect x="9" y="2" width="6" height="12" rx="3" />
        <path d="M5 10a7 7 0 0 0 14 0" />
        <path d="M12 19v3" />
      </svg>
    </button>
  );
}

// URLs that are almost certainly a job/application posting rather than a plain
// company site, used to label the primary link as "Open application".
function looksLikeApplication(url?: string): boolean {
  const u = String(url || "").toLowerCase();
  if (!u) return false;
  return /(greenhouse\.io|lever\.co|myworkdayjobs|workday|ashbyhq|jobs\.|\/jobs|\/careers|\/apply|smartrecruiters|icims|taleo|bamboohr|breezy\.hr|workable|jobvite|recruitee)/.test(
    u
  );
}

/* ---------------- Find detail modal ----------------
 * Click into a find to see everything about it in one place: all contact info
 * neatly formatted, why it fits, what they ask for, its sources, plus a live,
 * in-page preview of their website you can expand/contract (or drag to resize),
 * and a prominent link to the application when the target is a job posting.
 * Read-only: the draft/send actions stay on the card behind it. */
function FindDetailModal({
  find,
  onClose,
  wantedChannels,
  gmail,
  drafting,
  gmailBusy,
  onDraft,
  onDeny,
  onSetReason,
  onReopen,
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
  otherProjects,
  onMoveProject,
  currentSignature,
  onEditSignature,
  senderName,
  senderEmail,
  senderExtra,
}: {
  find: Find;
  onClose: () => void;
  wantedChannels: string[];
  gmail: { connected: boolean; email?: string; sendMode?: "draft" | "send"; label?: string };
  drafting: boolean;
  gmailBusy: boolean;
  onDraft: () => void;
  onDeny: (reason?: string) => void;
  onSetReason: (reason: string) => void;
  onReopen: () => void;
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
  otherProjects: Project[];
  onMoveProject: (projectId: string) => void;
  currentSignature: string;
  onEditSignature: (sig: string) => void;
  senderName: string;
  senderEmail: string;
  senderExtra?: {
    phone?: string;
    company?: string;
    role?: string;
    location?: string;
    linkedin?: string;
    website?: string;
  };
}) {
  const o = find.opp;
  const [tall, setTall] = useState(false); // preview height: compact vs expanded
  const [frameLoaded, setFrameLoaded] = useState(false);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  // Whether the previewed page has a fillable form (reported by the autofill
  // bridge injected into the proxied HTML), and the last fill result.
  const [formDetected, setFormDetected] = useState(false);
  const [formQuestions, setFormQuestions] = useState<string[]>([]);
  const [showQuestions, setShowQuestions] = useState(false);
  const [fillNote, setFillNote] = useState("");
  // Listen for the bridge's messages (same-origin proxied iframe → this window).
  useEffect(() => {
    function onMsg(ev: MessageEvent) {
      const d = ev.data;
      if (!d || typeof d !== "object") return;
      if (d.type === "scout-form-detected") {
        setFormDetected(!!d.hasForm);
        setFormQuestions(Array.isArray(d.questions) ? d.questions : []);
      }
      if (d.type === "scout-autofill-done") {
        setFillNote(
          d.filled
            ? "Filled every field Scout could. Review it, then submit on the site."
            : "Couldn't match this form's fields, use Open ↗ to fill it directly."
        );
      }
    }
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);
  // Reset per-find as the preview reloads.
  useEffect(() => {
    setFormDetected(false);
    setFormQuestions([]);
    setShowQuestions(false);
    setFillNote("");
  }, [o.url]);
  // Pre-fill the previewed contact/application form with everything Scout knows
  // about the sender + the drafted message. Never submits, only populates.
  function fillForm() {
    const win = frameRef.current?.contentWindow;
    if (!win) return;
    const parts = (senderName || "").trim().split(/\s+/);
    const first = parts[0] || "";
    const last = parts.length > 1 ? parts.slice(1).join(" ") : "";
    const message = (find.draft?.body || "").trim();
    win.postMessage(
      {
        type: "scout-autofill",
        payload: {
          name: senderName.trim(),
          first,
          last,
          email: senderEmail.trim(),
          message,
          phone: senderExtra?.phone || "",
          company: senderExtra?.company || "",
          role: senderExtra?.role || "",
          location: senderExtra?.location || "",
          linkedin: senderExtra?.linkedin || "",
          website: senderExtra?.website || "",
        },
      },
      "*"
    );
    setFillNote("Filling…");
  }
  const recipientTz = o.timezone || guessTimezone(o.location);
  const isApplication =
    !!find.application || looksLikeApplication(o.url) || o.channel === "Company Portal";
  const host = (() => {
    try {
      return o.url ? new URL(o.url).hostname.replace(/^www\./, "") : "";
    } catch {
      return "";
    }
  })();

  // Close on Escape.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  // Neatly-formatted contact rows, only the ones we actually have.
  // Any channel the search explicitly requested gets its own labeled box
  // below ("Requested contact info"), found or not, so leave it out of this
  // general list too, or it shows twice.
  const rows: { label: string; node: React.ReactNode }[] = [];
  if (o.contactEmail && !wantedChannels.includes("email"))
    rows.push({
      label: "Email",
      node: <ContactValue value={o.contactEmail} className="font-semibold text-accent" />,
    });
  if (o.contactPhone && !wantedChannels.includes("phone"))
    rows.push({
      label: "Phone",
      node: (
        <a
          href={`tel:${o.contactPhone.replace(/[^\d+]/g, "")}`}
          className="font-semibold text-ink underline decoration-dotted underline-offset-2 hover:text-accent"
        >
          {o.contactPhone}
        </a>
      ),
    });
  if (o.contactName)
    rows.push({
      label: "Contact",
      node: (
        <span className="text-ink">
          {o.contactName}
          {o.contactRole ? <span className="text-body/70"> · {o.contactRole}</span> : null}
        </span>
      ),
    });
  if (o.contactHandle && !wantedChannels.includes("linkedin"))
    rows.push({
      label: "Profile",
      node: <ContactValue value={o.contactHandle} className="text-ink" />,
    });
  if (o.outlet) rows.push({ label: "Organization", node: <span className="text-ink">{o.outlet}</span> });
  if (o.location)
    rows.push({
      label: "Location",
      node: (
        <span className="text-ink">
          {o.location}
          {recipientTz ? (
            <span className="text-body/60"> · {localTimeLabel(recipientTz)} their time</span>
          ) : null}
        </span>
      ),
    });
  if (o.url && !wantedChannels.includes("website"))
    rows.push({
      label: "Website",
      node: (
        <a
          href={o.url}
          target="_blank"
          rel="noreferrer"
          className="break-all text-accent underline decoration-dotted underline-offset-2 hover:text-brown-deep"
        >
          {host || o.url}
        </a>
      ),
    });

  return (
    <div
      className="fixed inset-0 z-50 bg-surface"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Details for ${o.name}`}
    >
      <div
        className="flex h-full w-full flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start gap-3 border-b border-warm-border px-6 py-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate text-lg font-bold text-ink">{o.name}</span>
              {o.fitScore != null && (
                <span className="rounded-full bg-brand-gradient px-2 py-0.5 text-[10px] font-bold text-white">
                  {Math.round(o.fitScore * 100)}% fit
                </span>
              )}
              <span className="rounded-full border border-warm-border bg-warm-bg px-2 py-0.5 text-[10px] font-medium text-body">
                {o.channel}
              </span>
              <span className="rounded-full border border-warm-border bg-warm-bg px-2 py-0.5 text-[10px] font-semibold capitalize text-body/80">
                {find.status}
              </span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 rounded-lg border border-warm-border px-3 py-1.5 text-xs font-semibold text-body transition hover:bg-warm-bg"
          >
            Close
          </button>
        </div>

        {/* Body: info + website preview, fills the rest of the fullscreen modal */}
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-0 lg:grid-cols-[minmax(280px,340px)_1fr]">
          {/* Left: neatly formatted info */}
          <div className="space-y-4 overflow-y-auto border-b border-warm-border p-5 lg:border-b-0 lg:border-r">
            <div>
              <div className="mb-2 text-[11px] font-bold uppercase tracking-wider text-body/50">
                Contact
              </div>
              {rows.length ? (
                <dl className="space-y-2">
                  {rows.map((r) => (
                    <div key={r.label} className="grid grid-cols-[84px_1fr] items-start gap-2 text-sm">
                      <dt className="pt-0.5 text-[11px] font-semibold uppercase tracking-wide text-body/45">
                        {r.label}
                      </dt>
                      <dd className="min-w-0 break-words leading-relaxed">{r.node}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className="text-sm text-body/50">No direct contact found yet.</p>
              )}
            </div>

            {/* A labeled section for EVERY channel this search asked for, found
                or not, so it's obvious at a glance what's still missing. */}
            {wantedChannels.length > 0 && (
              <div>
                <div className="mb-2 text-[11px] font-bold uppercase tracking-wider text-body/50">
                  Requested contact info
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  {CONTACT_CHANNELS.filter((c) => wantedChannels.includes(c.key)).map((c) => {
                    const val = channelValue(o, c.key);
                    return (
                      <div
                        key={c.key}
                        className={`rounded-lg border px-2.5 py-1.5 text-xs ${
                          val
                            ? "border-sage/40 bg-sage/10 text-brown-deep"
                            : "border-warm-border bg-warm-bg/40 text-body/40"
                        }`}
                      >
                        <div className="font-bold uppercase tracking-wide text-[10px]">
                          {c.label}
                        </div>
                        <div className="mt-0.5 truncate">
                          {val ? (
                            c.key === "phone" ? (
                              <a
                                href={`tel:${val.replace(/[^\d+]/g, "")}`}
                                className="hover:underline"
                              >
                                {val}
                              </a>
                            ) : (
                              <ContactValue value={val} className="" />
                            )
                          ) : (
                            "Not found yet"
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Quick actions */}
            <div className="flex flex-wrap gap-2">
              {o.url && (
                <a
                  href={o.url}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-lg bg-brand-gradient px-3 py-1.5 text-xs font-bold text-white shadow-card transition hover:opacity-95"
                >
                  {isApplication ? "Open application ↗" : "Open site ↗"}
                </a>
              )}
              {o.contactEmail && mailHref(o.contactEmail) && (
                <a
                  href={`mailto:${o.contactEmail}`}
                  className="rounded-lg border border-warm-border px-3 py-1.5 text-xs font-semibold text-body transition hover:bg-warm-bg"
                >
                  Email
                </a>
              )}
              {o.contactPhone && (
                <a
                  href={`tel:${o.contactPhone.replace(/[^\d+]/g, "")}`}
                  className="rounded-lg border border-warm-border px-3 py-1.5 text-xs font-semibold text-body transition hover:bg-warm-bg"
                >
                  Call
                </a>
              )}
            </div>

            {o.whyItFits && (
              <div>
                <div className="mb-1 text-[11px] font-bold uppercase tracking-wider text-body/50">
                  Why it fits
                </div>
                <p className="text-sm leading-relaxed text-body">{o.whyItFits}</p>
              </div>
            )}

            {find.requirements && (
              <div className="rounded-xl border border-sage/40 bg-sage/10 p-2.5 text-xs leading-relaxed text-brown-deep">
                <span className="font-bold">What they ask for: </span>
                {find.requirements}
              </div>
            )}

            {o.sources && o.sources.length > 1 && <SourcesList sources={o.sources} />}

            {/* The whole drafting-and-sending workflow, right here, draft, edit,
                send/schedule, deny, follow up, without leaving this popup. */}
            <div className="border-t border-warm-border pt-4">
              <div className="mb-2 text-[11px] font-bold uppercase tracking-wider text-body/50">
                Outreach
              </div>
              <FindWorkflow
                find={find}
                gmail={gmail}
                drafting={drafting}
                gmailBusy={gmailBusy}
                onDraft={onDraft}
                onDeny={onDeny}
                onSetReason={onSetReason}
                onReopen={onReopen}
                onStatus={onStatus}
                onRemove={onRemove}
                onSendGmail={onSendGmail}
                onSchedule={onSchedule}
                onMeetingPrep={onMeetingPrep}
                meetingPrepBusy={meetingPrepBusy}
                onCopy={onCopy}
                onEditDraft={onEditDraft}
                onDeepScan={onDeepScan}
                scanning={scanning}
                onFollowUp={onFollowUp}
                followUpBusy={followUpBusy}
                jobMode={jobMode}
                onDraftApplication={onDraftApplication}
                applying={applying}
                hasResume={hasResume}
                onToggleAttach={onToggleAttach}
                otherProjects={otherProjects}
                onMoveProject={onMoveProject}
                currentSignature={currentSignature}
                onEditSignature={onEditSignature}
              />
            </div>
          </div>

          {/* Right: live website preview, fills all remaining height */}
          <div className="flex h-full min-h-0 flex-col p-5">
            <div className="mb-2 flex items-center gap-2">
              <div className="text-[11px] font-bold uppercase tracking-wider text-body/50">
                {isApplication ? "Application preview" : "Website preview"}
              </div>
              {host && <span className="truncate text-xs text-body/50">{host}</span>}
              {o.url && (
                <div className="ml-auto flex items-center gap-1.5">
                  {formDetected && formQuestions.length > 0 && (
                    <button
                      onClick={() => setShowQuestions((v) => !v)}
                      title="See the exact questions this form asks so you can prepare"
                      className="rounded-lg border border-warm-border px-2.5 py-1 text-[11px] font-semibold text-body transition hover:bg-warm-bg"
                    >
                      {showQuestions ? "Hide" : "See"} questions ({formQuestions.length})
                    </button>
                  )}
                  {formDetected && (
                    <button
                      onClick={fillForm}
                      title="Type your details and drafted message into every field Scout can. It never submits."
                      className="rounded-lg bg-brown px-2.5 py-1 text-[11px] font-semibold text-white shadow-soft transition hover:bg-brown-deep"
                    >
                      Autofill
                    </button>
                  )}
                  <button
                    onClick={() => setTall((v) => !v)}
                    className="rounded-lg border border-warm-border px-2.5 py-1 text-[11px] font-semibold text-body transition hover:bg-warm-bg"
                  >
                    {tall ? "Contract" : "Expand"}
                  </button>
                  <a
                    href={o.url}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-lg border border-warm-border px-2.5 py-1 text-[11px] font-semibold text-body transition hover:bg-warm-bg"
                  >
                    Open ↗
                  </a>
                </div>
              )}
            </div>

            {/* What this form/application will ask — so the user can prepare. */}
            {showQuestions && formQuestions.length > 0 && (
              <div className="mb-2 rounded-xl border border-warm-border bg-warm-bg/40 p-3">
                <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-body/50">
                  {isApplication ? "This application asks you" : "This form asks you"}
                </div>
                <ol className="list-decimal space-y-1 pl-5 text-xs leading-relaxed text-body">
                  {formQuestions.map((q, i) => (
                    <li key={i}>{q}</li>
                  ))}
                </ol>
              </div>
            )}
            {o.url ? (
              <div
                className="relative w-full min-h-0 flex-1 overflow-hidden rounded-xl border border-warm-border bg-white"
                style={{ height: tall ? "100%" : "65vh", resize: "vertical", minHeight: 240 }}
              >
                {!frameLoaded && (
                  <div className="absolute inset-0 flex items-center justify-center text-xs text-body/40">
                    Loading preview…
                  </div>
                )}
                <iframe
                  ref={frameRef}
                  // Routed through our own origin (see app/api/site-preview) so
                  // X-Frame-Options / CSP frame-ancestors on the target site
                  // can't refuse the embed, those headers apply to a direct
                  // cross-origin request, not to our own proxied response.
                  src={`/api/site-preview?url=${encodeURIComponent(o.url)}`}
                  title={`Preview of ${host || o.name}`}
                  onLoad={() => setFrameLoaded(true)}
                  referrerPolicy="no-referrer"
                  sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
                  className="h-full w-full"
                />
              </div>
            ) : (
              <div className="flex h-64 items-center justify-center rounded-xl border border-dashed border-warm-border text-sm text-body/40">
                No website on file for this find.
              </div>
            )}
            {fillNote && (
              <p className="mt-2 text-[11px] font-medium leading-relaxed text-brown-deep">
                {fillNote}
              </p>
            )}
            {o.url && (
              <p className="mt-2 text-[11px] leading-relaxed text-body/50">
                A few sites still resist previewing here (login walls, aggressive
                anti-bot checks). If the preview stays blank, use{" "}
                <a
                  href={o.url}
                  target="_blank"
                  rel="noreferrer"
                  className="font-semibold text-accent hover:underline"
                >
                  Open ↗
                </a>{" "}
                to view it in a new tab. Drag the bottom edge to resize.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Finds tab (pipeline: review / draft / deny / mark sent) ---------------- */
function FindsTab({
  finds,
  categories,
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
  onMoveProject,
  getSignatureFor,
  onEditSignature,
  onCheckReplies,
  repliesBusy,
  repliesNote,
  goOutreach,
  senderName,
  senderEmail,
  senderExtra,
}: {
  finds: Find[];
  categories: Category[];
  projectName: string;
  projects: Project[];
  activeProjectId: string;
  onSelectProject: (id: string) => void;
  voiceRefreshAvailable: boolean;
  refreshingVoice: boolean;
  onRefreshDrafts: () => void;
  filter: FindFilter;
  setFilter: (f: FindFilter) => void;
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
  onMoveProject: (f: Find, projectId: string) => void;
  getSignatureFor: (projectId: string) => string;
  onEditSignature: (projectId: string, sig: string) => void;
  onCheckReplies: () => void;
  repliesBusy: boolean;
  repliesNote: string;
  goOutreach: () => void;
  senderName: string;
  senderEmail: string;
  senderExtra?: {
    phone?: string;
    company?: string;
    role?: string;
    location?: string;
    linkedin?: string;
    website?: string;
  };
}) {
  // Pinned finds live in their own tab and are excluded from the status/all
  // lists, so status counts count only the un-pinned ones.
  const counts: Record<string, number> = {
    pinned: finds.filter((f) => f.pinned).length,
    all: finds.filter((f) => !f.pinned).length,
  };
  for (const s of ["new", "drafted", "sent", "replied", "denied"] as FindStatus[]) {
    counts[s] = finds.filter((f) => f.status === s && !f.pinned).length;
  }
  const trackable = finds.some(
    (f) =>
      (f.gmailThreadId || f.outlookThreadId) &&
      f.status !== "replied" &&
      f.status !== "denied"
  );
  const shown = finds
    .filter((f) =>
      filter === "pinned"
        ? f.pinned
        : filter === "all"
          ? !f.pinned
          : f.status === filter && !f.pinned
    )
    .slice()
    .sort((a, b) => (b.opp.fitScore || 0) - (a.opp.fitScore || 0));

  // Which find's detail modal is open. Looked up from `finds` (not a snapshot)
  // so it reflects live updates while open.
  const [detailId, setDetailId] = useState("");
  const detailFind = detailId ? finds.find((f) => f.id === detailId) || null : null;

  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">
            Your <span className="text-brown">finds</span>
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
          ) : filter === "pinned" ? (
            "No pinned finds yet. Pin a find to move it here as your working shortlist."
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
              onOpenDetail={() => setDetailId(f.id)}
              wantedChannels={
                categories.find((c) => c.id === f.categoryId)?.wantedChannels || []
              }
              otherProjects={projects.filter((p) => p.id !== f.projectId)}
              onMoveProject={(pid) => onMoveProject(f, pid)}
              currentSignature={getSignatureFor(f.projectId)}
              onEditSignature={(sig) => onEditSignature(f.projectId, sig)}
            />
          ))}
        </div>
      )}

      {detailFind && (
        <FindDetailModal
          find={detailFind}
          onClose={() => setDetailId("")}
          wantedChannels={
            categories.find((c) => c.id === detailFind.categoryId)?.wantedChannels || []
          }
          gmail={gmail}
          drafting={draftingId === detailFind.id}
          gmailBusy={!!detailFind.draft && gmailBusyId === detailFind.draft.opportunityId}
          onDraft={() => onDraft(detailFind)}
          onDeny={(reason) => onDeny(detailFind, reason)}
          onSetReason={(reason) => onSetReason(detailFind, reason)}
          onReopen={() => onReopen(detailFind)}
          onStatus={(s) => onStatus(detailFind, s)}
          onRemove={() => onRemove(detailFind)}
          onSendGmail={() => onSendGmail(detailFind)}
          onSchedule={(date) => onSchedule(detailFind, date)}
          onMeetingPrep={() => onMeetingPrep(detailFind)}
          meetingPrepBusy={meetingPrepId === detailFind.id}
          onCopy={onCopy}
          onEditDraft={(subject, body) => onEditDraft(detailFind, subject, body)}
          onDeepScan={() => onDeepScan(detailFind)}
          scanning={scanningId === detailFind.id}
          onFollowUp={() => onFollowUp(detailFind)}
          followUpBusy={followUpId === detailFind.id}
          jobMode={jobMode}
          onDraftApplication={() => onDraftApplication(detailFind)}
          applying={applyingId === detailFind.id}
          hasResume={hasResume}
          onToggleAttach={(on) => onToggleAttach(detailFind, on)}
          otherProjects={projects.filter((p) => p.id !== detailFind.projectId)}
          onMoveProject={(pid) => onMoveProject(detailFind, pid)}
          currentSignature={getSignatureFor(detailFind.projectId)}
          onEditSignature={(sig) => onEditSignature(detailFind.projectId, sig)}
          senderName={senderName}
          senderEmail={senderEmail}
          senderExtra={senderExtra}
        />
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
  onOpenDetail,
  wantedChannels,
  otherProjects,
  onMoveProject,
  currentSignature,
  onEditSignature,
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
  onOpenDetail: () => void;
  wantedChannels: string[];
  otherProjects: Project[];
  onMoveProject: (projectId: string) => void;
  currentSignature: string;
  onEditSignature: (sig: string) => void;
}) {
  const o = find.opp;
  // Recipient timezone is also needed by FindWorkflow below, which recomputes
  // it independently since it's a standalone component.
  const recipientTz = o.timezone || guessTimezone(o.location);

  return (
    <div
      className={`rounded-2xl border p-4 shadow-card transition ${findCardTone(find)} ${
        find.pinned ? "ring-1 ring-coral/30" : ""
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={onOpenDetail}
          title="Open details, contact info, and a website preview"
          className="text-left font-semibold text-ink underline-offset-2 transition hover:text-accent hover:underline"
        >
          {o.name}
        </button>
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
              isBusinessHours(recipientTz) ? "" : ", outside business hours"
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
          onClick={onOpenDetail}
          title="Open details, contact info, and a website preview"
          className="ml-auto shrink-0 inline-flex items-center gap-1 rounded-lg border border-warm-border bg-surface px-2.5 py-1 text-[11px] font-semibold text-body transition hover:border-coral/40 hover:bg-warm-bg hover:text-accent"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 3h6v6" />
            <path d="M10 14 21 3" />
            <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
          </svg>
          Details
        </button>
        <button
          onClick={onTogglePin}
          title={find.pinned ? "Unpin, return to its status list" : "Pin, moves it to the Pinned tab"}
          aria-label={find.pinned ? "Unpin find" : "Pin find to the Pinned tab"}
          aria-pressed={!!find.pinned}
          className={`shrink-0 rounded-lg border p-1 transition ${
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
      {/* Any channel the search explicitly requested gets its own labeled box
          below ("Requested contact info"), found or not, so leave it out of
          this compact line too, or it shows twice. */}
      {(() => {
        const showEmail = !!o.contactEmail && !wantedChannels.includes("email");
        const showHandle = !!o.contactHandle && !wantedChannels.includes("linkedin");
        const showPhone = !!o.contactPhone && !wantedChannels.includes("phone");
        // Nothing left to show inline (e.g. a company search where every
        // channel is in the requested-info row below), skip the empty line.
        if (!showEmail && !o.contactName && !showHandle && !showPhone) return null;
        return (
          <div className="mt-1 text-xs">
            {showEmail && (
              <ContactValue value={o.contactEmail} className="font-semibold text-accent" />
            )}
            {o.contactName && (
              <span className="text-body">
                {showEmail ? "  ·  " : ""}
                {o.contactName}
                {o.contactRole ? ` (${o.contactRole})` : ""}
              </span>
            )}
            {showHandle && (
              <span className="text-body/70">
                {showEmail || o.contactName ? "  ·  " : ""}
                <ContactValue value={o.contactHandle} className="text-body/70" />
              </span>
            )}
            {showPhone && (
              <span className="text-body/70">
                {showEmail || o.contactName || showHandle ? "  ·  " : ""}
                <a
                  href={`tel:${o.contactPhone.replace(/[^\d+]/g, "")}`}
                  className="text-body/70 underline-offset-2 hover:text-accent hover:underline"
                >
                  {o.contactPhone}
                </a>
              </span>
            )}
          </div>
        );
      })()}
      {o.whyItFits && (
        <div className="mt-1.5 text-xs leading-relaxed text-body">{o.whyItFits}</div>
      )}

      {/* Every contact channel the search asked for, found or not, as one
          compact line (label + value, missing shown as a muted dash) instead
          of a grid of boxes that wrapped into two cluttered rows. */}
      {wantedChannels.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px]">
          {CONTACT_CHANNELS.filter((c) => wantedChannels.includes(c.key)).map((c) => {
            const val = channelValue(o, c.key);
            return (
              <span key={c.key} className="inline-flex min-w-0 items-baseline gap-1.5">
                <span
                  className={`font-bold uppercase tracking-wide ${
                    val ? "text-sage-deep" : "text-body/40"
                  }`}
                >
                  {c.label}
                </span>
                <span className="min-w-0 truncate">
                  {val ? (
                    c.key === "phone" ? (
                      <a
                        href={`tel:${val.replace(/[^\d+]/g, "")}`}
                        className="text-body hover:text-accent hover:underline"
                      >
                        {val}
                      </a>
                    ) : (
                      <ContactValue value={val} className="text-body" />
                    )
                  ) : (
                    <span className="text-body/35">, </span>
                  )}
                </span>
              </span>
            );
          })}
        </div>
      )}

      {/* Multiple articles that mention this same person, collapsed by default
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

      <FindWorkflow
        find={find}
        gmail={gmail}
        drafting={drafting}
        gmailBusy={gmailBusy}
        onDraft={onDraft}
        onDeny={onDeny}
        onSetReason={onSetReason}
        onReopen={onReopen}
        onStatus={onStatus}
        onRemove={onRemove}
        onSendGmail={onSendGmail}
        onSchedule={onSchedule}
        onMeetingPrep={onMeetingPrep}
        meetingPrepBusy={meetingPrepBusy}
        onCopy={onCopy}
        onEditDraft={onEditDraft}
        onDeepScan={onDeepScan}
        scanning={scanning}
        onFollowUp={onFollowUp}
        followUpBusy={followUpBusy}
        jobMode={jobMode}
        onDraftApplication={onDraftApplication}
        applying={applying}
        hasResume={hasResume}
        onToggleAttach={onToggleAttach}
        otherProjects={otherProjects}
        onMoveProject={onMoveProject}
        currentSignature={currentSignature}
        onEditSignature={onEditSignature}
      />
    </div>
  );
}

/* ---------------- Find workflow: draft, edit, send/schedule, deny, follow up ----------------
 * The whole drafting-and-sending process for one find, factored out of
 * FindCard so it can also run inside FindDetailModal, the fullscreen "Details"
 * popup goes through the entire workflow (draft, edit, send, schedule, deny,
 * follow up) without leaving the popup. */
function FindWorkflow({
  find,
  gmail,
  drafting,
  gmailBusy,
  onDraft,
  onDeny,
  onSetReason,
  onReopen,
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
  otherProjects,
  onMoveProject,
  currentSignature,
  onEditSignature,
}: {
  find: Find;
  gmail: { connected: boolean; email?: string; sendMode?: "draft" | "send"; label?: string };
  drafting: boolean;
  gmailBusy: boolean;
  onDraft: () => void;
  onDeny: (reason?: string) => void;
  onSetReason: (reason: string) => void;
  onReopen: () => void;
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
  otherProjects: Project[];
  onMoveProject: (projectId: string) => void;
  currentSignature: string;
  onEditSignature: (sig: string) => void;
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
  // When the draft's body cleanly ends with this project's current signature,
  // the editor splits it into its own field, editing just the sign-off and
  // saving updates THAT PROJECT's signature going forward, not just this one
  // draft. Null means no clean split was found (body edited as one blob, as
  // before, never silently mangles a draft we can't confidently split).
  const [editSignature, setEditSignature] = useState<string | null>(null);
  const hasSignatureSplit = editSignature !== null;
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
      // Auto-schedule setting on → silently queue for the recipient's next
      // business hour instead of prompting.
      if (autoScheduleOn()) {
        onSchedule(suggestBusinessHour(recipientTz));
        return;
      }
      setSendGuard({
        local: localTimeLabel(recipientTz),
        next: nextBusinessLabel(recipientTz),
      });
    } else {
      onSendGmail();
    }
  };

  return (
    <>
      {/* Meeting / interview prep, factual highlights about the contact.
          Unlocked once status ≥ sent, so keeping statuses current pays out
          with real prep. Prep persists on the find once generated. */}
      <MeetingPrepBlock
        find={find}
        busy={meetingPrepBusy}
        onGenerate={onMeetingPrep}
      />

      {/* Stored draft, read view or inline editor */}
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
              const body = d.body || "";
              // Only split when this draft's body cleanly ends with the
              // project's CURRENT signature, anything less exact (already
              // customized, signature changed since drafting, no signature at
              // all) falls back to editing the whole body as one blob.
              const sig = currentSignature.trim();
              const suffix = sig ? `\n\n${sig}` : "";
              if (d.channelType === "email" && sig && body.endsWith(suffix)) {
                setEditBody(body.slice(0, body.length - suffix.length));
                setEditSignature(sig);
              } else {
                setEditBody(body);
                setEditSignature(null);
              }
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
          {hasSignatureSplit && (
            <div className="mt-2">
              <div className="mb-1 text-[11px] font-semibold text-body/60">
                Signature, editing this updates the default for every draft in this project
              </div>
              <textarea
                value={editSignature || ""}
                onChange={(e) => setEditSignature(e.target.value)}
                rows={Math.min(6, Math.max(2, (editSignature || "").split("\n").length + 1))}
                className="w-full rounded-lg border border-sage/40 bg-sage/5 px-2.5 py-2 font-sans text-xs leading-relaxed text-body outline-none focus:ring-2 focus:ring-sage/20"
              />
            </div>
          )}
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={() => {
                const sig = (editSignature || "").trim();
                const body = hasSignatureSplit && sig ? `${editBody.trimEnd()}\n\n${sig}` : editBody;
                onEditDraft(editSubject, body);
                if (hasSignatureSplit && sig !== currentSignature.trim()) {
                  onEditSignature(sig);
                }
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

        {/* Move to a different project, a find isn't stuck wherever it was
            first surfaced. Resets after firing since the find leaves this list. */}
        {otherProjects.length > 0 && (
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) onMoveProject(e.target.value);
            }}
            title="Move this find to a different project"
            className="scout-select rounded-lg border border-warm-border bg-surface px-2.5 py-1.5 text-xs font-semibold text-body outline-none transition hover:bg-warm-bg"
          >
            <option value="">Move to project…</option>
            {otherProjects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
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

        {/* The status pill dropdown at the top of the card can set any status;
            these two sit right next to the follow-up action since "did they
            reply" / "not going anywhere" are the two real outcomes of a sent
            message, moves it straight to that filter tab in Finds. */}
        {find.status === "sent" && (
          <>
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
            <button
              onClick={() => onStatus("replied")}
              title="Mark this contact as having replied"
              className="rounded-lg border border-sage/50 px-3 py-1.5 text-xs font-semibold text-sage transition hover:bg-sage/10"
            >
              Mark replied
            </button>
            <button
              onClick={() => onStatus("denied")}
              title="Mark this as not going anywhere"
              className="rounded-lg border border-warm-border px-3 py-1.5 text-xs font-semibold text-body transition hover:bg-warm-bg"
            >
              Mark denied
            </button>
          </>
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

      {/* Deny reason on passed finds, editable */}
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
    </>
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
  // Reply rate over messages known to have gone out (sent or replied), the
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
// Concrete signals about HOW the user writes their drafts, opener style,
// sign-off, sentence length, formality, surfaced under "What Scout has
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
        text: `Your messages average ${writing.avgWords} words, ${feel}.`,
        basis: `${writing.count} drafts`,
      });
    }
    if (writing.contractionRate != null && writing.contractionRate >= 0.6) {
      out.push({
        text: "You write informally, contractions like \"don't\" and \"I'll\" show up in most drafts. Scout matches that register.",
        basis: `${writing.count} drafts`,
      });
    } else if (writing.contractionRate != null && writing.contractionRate <= 0.2 && writing.count >= 4) {
      out.push({
        text: "You lean formal, contractions rarely appear. Scout keeps drafts professional and full-form.",
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
  dismissedAdvice,
  editPairs,
  onApplyTip,
  onRemoveTip,
  onDismissAdvice,
  goOutreach,
  goTemplates,
  goProfile,
  goFinds,
  onEditProject,
  onSeedTemplateForChannel,
  getToken,
  openCommand,
  onOpenFind,
}: {
  activity: Activity;
  profile: Profile;
  templates: OutreachTemplate[];
  projects: Project[];
  categoriesCount: number;
  finds: Find[];
  community: CommunityStats | null;
  coaching: string[];
  dismissedAdvice: string[];
  editPairs: { before: string; after: string }[];
  onApplyTip: (tip: string) => void;
  onRemoveTip: (tip: string) => void;
  onDismissAdvice: (tip: string) => void;
  goOutreach: () => void;
  goTemplates: () => void;
  goProfile: () => void;
  goFinds: () => void;
  onEditProject: (id: string) => void;
  onSeedTemplateForChannel: (channel: string) => void;
  getToken?: () => Promise<string | null>;
  openCommand: () => void;
  onOpenFind: (f: Find) => void;
}) {
  // Two-tab split: personal signal in "You", aggregate/community in "Scout-wide".
  const [dashTab, setDashTab] = useState<"you" | "scout">("you");
  const learned = learnedFromFinds(finds);
  const writing = learnedFromDrafts(finds);
  const insights = recentInsights(learned, writing, coaching, editPairs);

  // Dev tool: turn real usage data into a ready-to-paste engineering prompt
  // for recalibrating lib/discover.ts. Separate from the user-facing "learned
  // about you" narrative above, this is raw numbers meant for tuning code.
  const [tuningPrompt, setTuningPrompt] = useState("");
  const [tuningBusy, setTuningBusy] = useState(false);
  const [tuningErr, setTuningErr] = useState("");
  const [tuningCopied, setTuningCopied] = useState(false);
  async function generateTuningPrompt() {
    setTuningBusy(true);
    setTuningErr("");
    setTuningPrompt("");
    try {
      const res = await fetch("/api/tuning-prompt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          useCase: profile.useCase,
          decided: learned.decided,
          denyRate: learned.denyRate,
          keptFit: learned.keptFit,
          deniedFit: learned.deniedFit,
          deniedReasons: learned.deniedReasonsTally,
          keptChannels: learned.keptChannels,
          deniedChannels: learned.deniedChannels,
          replyRate: learned.replyRate,
          repliedCount: learned.repliedCount,
          sentCount: learned.sentCount,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.error) {
        setTuningErr(data?.error || "Couldn't generate a tuning prompt.");
        return;
      }
      setTuningPrompt(data.prompt || "");
    } catch (e: any) {
      setTuningErr(e?.message || "Couldn't generate a tuning prompt.");
    } finally {
      setTuningBusy(false);
    }
  }

  // Algorithm change log: every edit the auto-tune cron has made (see
  // /api/cron/auto-tune + supabase/auto_tune_log.sql). "Seen" is tracked
  // locally so a badge can flag unread entries without touching the shared
  // account state that the auto-tune system deliberately keeps separate from.
  const AUTOTUNE_SEEN_KEY = "scout_autotune_log_seen_at";
  const [autoTuneEntries, setAutoTuneEntries] = useState<any[] | null>(null);
  const [autoTuneLogOpen, setAutoTuneLogOpen] = useState(false);
  const [autoTuneLogErr, setAutoTuneLogErr] = useState("");
  const [autoTuneSeenAt, setAutoTuneSeenAt] = useState<number>(() => {
    try {
      return Number(localStorage.getItem(AUTOTUNE_SEEN_KEY) || 0);
    } catch {
      return 0;
    }
  });
  useEffect(() => {
    if (!getToken) return;
    (async () => {
      const token = await getToken();
      if (!token) return;
      try {
        const res = await fetch("/api/auto-tune-log", {
          headers: { authorization: `Bearer ${token}` },
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) setAutoTuneEntries(data.entries || []);
        else setAutoTuneLogErr(data?.error || "");
      } catch {
        /* silent, the badge/log just stays empty */
      }
    })();
  }, [getToken]);
  const unseenAutoTuneCount = (autoTuneEntries || []).filter(
    (e) => new Date(e.created_at).getTime() > autoTuneSeenAt
  ).length;
  function openAutoTuneLog() {
    setAutoTuneLogOpen((v) => !v);
    const now = Date.now();
    setAutoTuneSeenAt(now);
    try {
      localStorage.setItem(AUTOTUNE_SEEN_KEY, String(now));
    } catch {}
  }

  // Contacts you reached out to about a week ago that still haven't replied, a
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

  // Rhythm stats, how much you've done in the last 7 and 30 days. Uses the
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

  // What Scout uses to personalize FOR YOU, each item is a real signal or a
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
        <div className="inline-flex shrink-0 rounded-xl border border-warm-border bg-warm-bg p-1">
          {(
            [
              ["you", "You"],
              ["scout", "Scout-wide"],
            ] as const
          ).map(([val, label]) => (
            <button
              key={val}
              onClick={() => setDashTab(val)}
              className={`rounded-lg px-4 py-1.5 text-sm font-medium transition ${
                dashTab === val
                  ? "bg-surface text-ink shadow-card"
                  : "text-muted hover:text-ink"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {dashTab === "you" && (
      <>
      {/* -------- Ask Scout spotlight (signature) -------- */}
      <button
        onClick={openCommand}
        aria-label="Ask Scout, open the command palette"
        className="mt-6 flex w-full items-center gap-3 rounded-2xl border border-warm-border bg-surface px-4 py-3.5 text-left shadow-float transition hover:border-clay"
      >
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-brown">
          <circle cx="11" cy="11" r="7" />
          <path d="m21 21-4.3-4.3" />
        </svg>
        <span className="flex-1 truncate text-[15px] text-muted">
          Ask Scout to find playlist curators, recruiters, or press…
        </span>
        <span className="shrink-0 rounded-md border border-warm-border bg-cream px-2 py-1 text-[11px] text-muted">
          ⌘K
        </span>
      </button>

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
                    ? "Sharper than when you started, fewer of Scout's finds are misses."
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
        <section className="relative mt-4 flex flex-wrap items-center gap-5 overflow-hidden rounded-2xl bg-brown-deep p-6 shadow-soft">
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
                "Your strongest still-open match, worth a short, specific intro."}
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

      {/* -------- Activity metrics (airy, hairline-separated) -------- */}
      <section className="mt-6 grid grid-cols-2 gap-y-6 border-t border-warm-border pt-6 sm:grid-cols-4">
        {metrics.map((m, i) => (
          <div
            key={m.label}
            className={`px-5 ${i === 0 ? "pl-0" : ""} ${
              i > 0 ? "sm:border-l sm:border-warm-border" : ""
            }`}
          >
            <div className="flex items-baseline gap-2">
              <div className="text-2xl font-semibold leading-none tracking-tight tabular-nums text-ink">
                {m.value}
              </div>
              {m.series && <Sparkline data={m.series} />}
            </div>
            <div className="mt-2 text-[12.5px] text-muted">{m.label}</div>
            {typeof m.delta === "number" && m.delta > 0 && (
              <div className="mt-1.5 text-[11.5px] font-medium text-success-deep">
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
                    <tr
                      key={f.id}
                      onClick={() => onOpenFind(f)}
                      className="cursor-pointer border-t border-warm-border transition hover:bg-warm-bg/50"
                    >
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
                        {f.opp.channel || "-"}
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
                          <span className="text-muted">, </span>
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
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpenFind(f);
                          }}
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
        dismissedAdvice={dismissedAdvice}
        onApplyTip={onApplyTip}
        onDismissAdvice={onDismissAdvice}
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

      {/* -------- Tune the search algorithm (dev tool) --------
          Raw, specific numbers from real decisions on this account, meant to
          be fed back into lib/discover.ts's search/extraction prompts, not
          just read. The button turns them into a ready-to-paste engineering
          prompt for a future Claude Code session. */}
      {learned.decided >= 5 ? (
        <section className="mt-10 rounded-3xl border border-warm-border bg-surface p-6 shadow-card">
          <h2 className="text-lg font-bold text-ink">Tune the search algorithm</h2>
          <p className="mt-1 text-sm text-body/80">
            Specific numbers from your {learned.decided} decided finds, the kind
            of data that should shape lib/discover.ts&apos;s search and
            fit-scoring prompts, not just sit in a dashboard.
          </p>

          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-xl border border-warm-border bg-warm-bg/40 p-3">
              <div className="text-xl font-extrabold text-ink">
                {Math.round(learned.denyRate * 100)}%
              </div>
              <div className="text-[11px] text-body/70">deny rate</div>
            </div>
            <div className="rounded-xl border border-warm-border bg-warm-bg/40 p-3">
              <div className="text-xl font-extrabold text-ink">
                {learned.keptFit != null ? `${Math.round(learned.keptFit * 100)}%` : "-"}
              </div>
              <div className="text-[11px] text-body/70">avg fit, kept</div>
            </div>
            <div className="rounded-xl border border-warm-border bg-warm-bg/40 p-3">
              <div className="text-xl font-extrabold text-ink">
                {learned.deniedFit != null ? `${Math.round(learned.deniedFit * 100)}%` : "-"}
              </div>
              <div className="text-[11px] text-body/70">avg fit, denied</div>
            </div>
            <div className="rounded-xl border border-warm-border bg-warm-bg/40 p-3">
              <div className="text-xl font-extrabold text-ink">
                {learned.replyRate != null ? `${Math.round(learned.replyRate * 100)}%` : "-"}
              </div>
              <div className="text-[11px] text-body/70">reply rate</div>
            </div>
          </div>

          {learned.keptFit != null &&
            learned.deniedFit != null &&
            learned.keptFit - learned.deniedFit < 0.1 && (
              <p className="mt-3 rounded-xl border border-amber-300/60 bg-amber-50 p-2.5 text-xs leading-relaxed text-amber-900">
                Kept and denied fit scores are only{" "}
                {Math.round((learned.keptFit - learned.deniedFit) * 100)} points apart, 
                fit_score isn&apos;t discriminating well and the extract() rubric in
                lib/discover.ts likely needs sharpening.
              </p>
            )}

          {learned.deniedReasonsTally.length > 0 && (
            <div className="mt-4">
              <div className="text-[11px] font-bold uppercase tracking-wider text-body/50">
                Why you pass (bucketed)
              </div>
              <div className="mt-1.5 space-y-1">
                {learned.deniedReasonsTally.slice(0, 6).map(([label, count]) => (
                  <div
                    key={label}
                    className="flex items-center justify-between rounded-lg bg-warm-bg/40 px-2.5 py-1.5 text-xs"
                  >
                    <span className="text-ink">{label}</span>
                    <span className="font-semibold text-body/70">{count}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {(learned.keptChannels.length > 0 || learned.deniedChannels.length > 0) && (
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div>
                <div className="text-[11px] font-bold uppercase tracking-wider text-body/50">
                  Channels kept
                </div>
                <div className="mt-1 text-xs text-body/80">
                  {learned.keptChannels.length
                    ? learned.keptChannels.map(([c, n]) => `${c} (${n})`).join(", ")
                    : "-"}
                </div>
              </div>
              <div>
                <div className="text-[11px] font-bold uppercase tracking-wider text-body/50">
                  Channels denied
                </div>
                <div className="mt-1 text-xs text-body/80">
                  {learned.deniedChannels.length
                    ? learned.deniedChannels.map(([c, n]) => `${c} (${n})`).join(", ")
                    : "-"}
                </div>
              </div>
            </div>
          )}

          <div className="mt-5 flex items-center gap-3">
            <button
              onClick={generateTuningPrompt}
              disabled={tuningBusy}
              className="rounded-xl bg-brand-gradient px-4 py-2.5 text-sm font-bold text-white shadow-soft transition hover:opacity-95 disabled:opacity-50"
            >
              {tuningBusy ? "Writing…" : "Generate tuning prompt"}
            </button>
            <span className="text-xs text-body/50">
              Writes a prompt you can paste into Claude Code to recalibrate the search.
            </span>
          </div>
          {tuningErr && (
            <p className="mt-2.5 text-xs font-semibold text-red-700">{tuningErr}</p>
          )}
          {tuningPrompt && (
            <div className="mt-3 rounded-xl border border-coral/30 bg-warm-bg/40 p-3">
              <pre className="whitespace-pre-wrap font-sans text-xs leading-relaxed text-ink">
                {tuningPrompt}
              </pre>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(tuningPrompt);
                  setTuningCopied(true);
                  setTimeout(() => setTuningCopied(false), 1500);
                }}
                className="mt-2 rounded-lg border border-warm-border px-3 py-1.5 text-xs font-semibold text-body transition hover:bg-warm-bg"
              >
                {tuningCopied ? "Copied ✓" : "Copy prompt"}
              </button>
            </div>
          )}

          {/* -------- Algorithm change log --------
              Everything the auto-tune cron has actually done, in full, 
              exactly what changed, why, and a link to the commit. */}
          <div className="mt-6 border-t border-warm-border pt-4">
            <button
              onClick={openAutoTuneLog}
              className="flex w-full items-center gap-2 text-left text-sm font-bold text-ink"
            >
              Algorithm change log
              {unseenAutoTuneCount > 0 && (
                <span className="rounded-full bg-brand-gradient px-2 py-0.5 text-[10px] font-bold text-white">
                  {unseenAutoTuneCount} new
                </span>
              )}
              <span className="ml-auto text-xs font-semibold text-body/60">
                {autoTuneLogOpen ? "Hide ▴" : "Show ▾"}
              </span>
            </button>
            <p className="mt-1 text-xs leading-relaxed text-body/70">
              Every edit the auto-tune cron has made to lib/discover.ts, unreviewed and
              already live, this is the audit trail.
            </p>
            {autoTuneLogOpen && (
              <div className="mt-3 space-y-3">
                {autoTuneLogErr && (
                  <p className="text-xs font-semibold text-red-700">{autoTuneLogErr}</p>
                )}
                {autoTuneEntries === null ? (
                  <p className="text-xs text-body/50">Loading…</p>
                ) : autoTuneEntries.length === 0 ? (
                  <p className="text-xs text-body/50">
                    No auto-tune edits yet, nothing has crossed the confidence gate.
                  </p>
                ) : (
                  autoTuneEntries.map((e) => (
                    <div
                      key={e.id}
                      className="rounded-xl border border-warm-border bg-warm-bg/40 p-3"
                    >
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="font-bold text-ink">{e.label}</span>
                        <span className="text-body/50">
                          {new Date(e.created_at).toLocaleString([], {
                            month: "short",
                            day: "numeric",
                            hour: "numeric",
                            minute: "2-digit",
                          })}
                        </span>
                        {e.commit_url && (
                          <a
                            href={e.commit_url}
                            target="_blank"
                            rel="noreferrer"
                            className="ml-auto font-semibold text-accent hover:underline"
                          >
                            View commit ↗
                          </a>
                        )}
                      </div>
                      <div className="mt-2 grid gap-2 sm:grid-cols-2">
                        <div>
                          <div className="text-[10px] font-bold uppercase tracking-wide text-body/50">
                            Before
                          </div>
                          <p className="mt-0.5 text-xs leading-relaxed text-body/80">
                            {e.old_clause}
                          </p>
                        </div>
                        <div>
                          <div className="text-[10px] font-bold uppercase tracking-wide text-body/50">
                            After
                          </div>
                          <p className="mt-0.5 text-xs leading-relaxed text-ink">
                            {e.new_clause}
                          </p>
                        </div>
                      </div>
                      {e.signal?.topBucket && (
                        <p className="mt-2 text-[11px] text-body/60">
                          Triggered by: {e.signal.decided} decided finds, &quot;
                          {e.signal.topBucket.label}&quot; was{" "}
                          {Math.round(e.signal.topBucket.share * 100)}% of denials (
                          {e.signal.topBucket.count} instances).
                        </p>
                      )}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </section>
      ) : (
        <section className="mt-10 rounded-2xl border border-dashed border-warm-border bg-surface/60 p-6 text-center text-sm text-body/60">
          Decide on a few more finds (kept {learned.decided}/5) and this section
          fills in with real numbers you can feed back into the search algorithm.
        </section>
      )}

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
  dismissedAdvice,
  onApplyTip,
  onDismissAdvice,
  goOutreach,
  goTemplates,
  onSeedTemplateForChannel,
}: {
  community: CommunityStats | null;
  finds: Find[];
  templates: OutreachTemplate[];
  coaching: string[];
  dismissedAdvice: string[];
  onApplyTip: (tip: string) => void;
  onDismissAdvice: (tip: string) => void;
  onSeedTemplateForChannel: (channel: string) => void;
  goOutreach: () => void;
  goTemplates: () => void;
}) {
  const p = community?.patterns;
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const isApplied = (s: string) =>
    coaching.some((c) => c.trim().toLowerCase() === s.trim().toLowerCase());
  // "Not helpful" advice is lifted to top-level state (dismissedAdvice) so
  // drafting can also avoid it, not just hide it here. dismissTip below just
  // forwards to the parent's handler, which persists + dedupes.
  const dismissTip = (tip: string) => onDismissAdvice(tip);
  const isDismissed = (s: string) => dismissedAdvice.includes(s.trim().toLowerCase());

  // Detect the specific outreach channel a tip references. Returns the
  // OUTREACH_KINDS label (matching the Templates dropdown) when found, so
  // "LinkedIn is doing well" → "LinkedIn message". If the user already has a
  // template for that channel we don't nudge, the goal is to seed the FIRST
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

  // Real, data-backed insights, each renders only when the community data
  // actually supports it (enough decisions, and the effect is really there).
  const insights: { title: string; body: string; basis: string }[] = [];
  if (p) {
    const top = p.channels[0];
    if (top) {
      insights.push({
        title: `${top.channel} finds get acted on most`,
        body: `${pct(top.keptRate)} of ${top.channel.toLowerCase()} finds are drafted or contacted, lead with searches likely to surface ${top.channel.toLowerCase()} contacts.`,
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

  // Established outreach practice, honestly labeled, not dressed up as Scout data.
  const playbook: { title: string; body: string; cta?: { label: string; go: () => void } }[] = [
    {
      title: "Open with something real about them",
      body: "One specific, true line about their work beats any template. Personalized outreach earns roughly 12-25% replies vs 1-3% for generic blasts (industry benchmarks).",
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
            Live patterns show up here once the community has made enough decisions, 
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
    v == null ? "-" : fmt === "pct" ? `${Math.round(v * 100)}%` : `${Math.round(v)}`;
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
 * Once a find's status is "sent" or later, meaning the user has actually
 * reached out, Scout offers to prep them for a meeting/interview by
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

/* ---------------- Contact channels picker ----------------
 * A dropdown on the search form: pick which contact channels this search
 * should try to come back with (email, phone, LinkedIn, website). Saved onto
 * the selected category, so re-opening that search remembers the choice, 
 * "Companies" can mean "get me a phone + email + website" every time. */
function ContactChannelsPicker({
  selected,
  onToggle,
  saved,
}: {
  selected: string[];
  onToggle: (key: string) => void;
  saved: boolean;
}) {
  const [open, setOpen] = useState(false);
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

  const label = selected.length
    ? CONTACT_CHANNELS.filter((c) => selected.includes(c.key))
        .map((c) => c.label)
        .join(", ")
    : "Any contact info";

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-xl border border-warm-border bg-surface px-3.5 py-2.5 text-xs font-semibold text-ink outline-none transition hover:bg-warm-bg"
      >
        <span className="text-body/60">Contact info wanted:</span>
        {label}
        <span aria-hidden className="text-body/50">
          {open ? "▴" : "▾"}
        </span>
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1.5 w-60 rounded-xl border border-warm-border bg-surface p-2.5 shadow-soft">
          {CONTACT_CHANNELS.map((c) => {
            const on = selected.includes(c.key);
            return (
              <label
                key={c.key}
                className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm text-ink transition hover:bg-warm-bg"
              >
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => onToggle(c.key)}
                  className="h-3.5 w-3.5 accent-brown"
                />
                {c.label}
              </label>
            );
          })}
          <p className="mt-1.5 border-t border-warm-border px-2 pt-2 text-[10px] leading-relaxed text-body/60">
            {selected.length
              ? "Scout favors results with all of these."
              : "Nothing selected, Scout returns whatever it finds."}
            {saved ? " Saved to this search." : " Save this search to remember your pick."}
          </p>
        </div>
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
                  // datetime-local can round the past, bounce anything within
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
      // Already business hours there, schedule 15 min out (still respects the
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

  // Owner-only: set how much a teammate's decisions count in team learning (1-5).
  const setWeight = (targetUserId: string, weight: number) =>
    run("weight-" + targetUserId, async () => {
      await authFetch("/api/team/member-weight", {
        method: "POST",
        body: JSON.stringify({ workspaceId: workspace.id, targetUserId, weight }),
      });
      await loadCtx();
    });
  const isOwner = workspace?.role === "owner";

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
        Your <span className="text-brown">team</span>
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
                  <span className="text-[9px] font-bold uppercase text-body/50">
                    {m.role === "owner" ? "admin" : "team member"}
                  </span>
                </span>
              ))}
            </div>

            {/* Owner-only: weight how much each member's decisions count in team
                learning. Default is 1 for everyone (equal). */}
            {isOwner && (workspace.members || []).length > 1 && (
              <div className="mt-4 border-t border-warm-border pt-4">
                <div className="text-xs font-bold uppercase tracking-wider text-body/50">
                  Team-learning weight
                </div>
                <p className="mt-0.5 text-xs leading-relaxed text-body/70">
                  Everyone counts equally (1) by default. As the owner, you can weigh a
                  member&apos;s keeps and passes more or less in what the team learns.
                </p>
                <div className="mt-3 space-y-1.5">
                  {(workspace.members || []).map((m: any) => (
                    <div key={m.user_id} className="flex items-center gap-3 text-sm">
                      <span className="min-w-0 flex-1 truncate text-ink">
                        {m.email === accountEmail ? "You" : m.email}
                        {m.role === "owner" && (
                          <span className="ml-1.5 text-[9px] font-bold uppercase text-body/40">
                            owner
                          </span>
                        )}
                      </span>
                      <select
                        value={String(Math.max(1, Math.min(5, Number(m.weight) || 1)))}
                        onChange={(e) => setWeight(m.user_id, Number(e.target.value))}
                        disabled={busy === "weight-" + m.user_id}
                        className="scout-select rounded-lg border border-warm-border bg-surface px-2.5 py-1.5 text-xs font-semibold text-ink outline-none transition focus:border-coral focus:ring-2 focus:ring-coral/15 disabled:opacity-50"
                      >
                        {[1, 2, 3, 4, 5].map((w) => (
                          <option key={w} value={w}>
                            {w}x
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {isOwner ? (
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
            ) : (
              <p className="mt-4 border-t border-warm-border pt-4 text-xs leading-relaxed text-body/60">
                Only a company admin can invite or remove members. Ask your admin to add
                someone.
              </p>
            )}
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

/* ---------------- Command palette (⌘K) ---------------- */
type NavTab =
  | "outreach" | "finds" | "dashboard" | "team" | "templates" | "profile" | "account" | "settings" | "billing";

const MONO_PALETTE = ["#7c5837", "#7d8a6a", "#a9761f", "#5d4026", "#3f7a52", "#3f6a8c"];
function monogram(name: string) {
  const initials =
    (name || "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() || "")
      .join("") || "?";
  const hash = (name || "").split("").reduce((s, c) => s + c.charCodeAt(0), 0);
  return { initials, color: MONO_PALETTE[hash % MONO_PALETTE.length] };
}

function CommandPalette({
  open,
  onClose,
  finds,
  onGo,
  onOpenFind,
  hasAccount,
}: {
  open: boolean;
  onClose: () => void;
  finds: Find[];
  onGo: (t: NavTab) => void;
  onOpenFind: (f: Find) => void;
  hasAccount: boolean;
}) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) {
      setQ("");
      setSel(0);
      const t = setTimeout(() => inputRef.current?.focus(), 20);
      return () => clearTimeout(t);
    }
  }, [open]);
  if (!open) return null;

  const ql = q.trim().toLowerCase();
  const m = (s: string) => !ql || s.toLowerCase().includes(ql);

  const actions = [
    { label: "Run a new search", run: () => onGo("outreach") },
    { label: "Draft outreach", run: () => onGo("outreach") },
    { label: "Import contacts", run: () => onGo("outreach") },
  ].filter((a) => m(a.label));
  const findItems = finds
    .filter((f) => m(f.opp.name))
    .slice(0, 8)
    .map((f) => ({ find: f }));
  const goItems = (
    [
      ["dashboard", "Home"],
      ["finds", "Finds"],
      ["outreach", "Outreach"],
      ["templates", "Templates"],
      ["profile", "Profile"],
      ...(hasAccount
        ? ([["billing", "Plan & billing"], ["settings", "Settings"]] as [NavTab, string][])
        : []),
    ] as [NavTab, string][]
  ).filter(([, l]) => m(l));

  const selectable: (() => void)[] = [
    ...actions.map((a) => a.run),
    ...findItems.map((fi) => () => onOpenFind(fi.find)),
    ...goItems.map(([t]) => () => onGo(t)),
  ];
  const csel = Math.min(sel, Math.max(0, selectable.length - 1));

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, selectable.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      selectable[csel]?.();
    }
  };

  let running = -1;
  const rowCls = (i: number) =>
    `flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition ${
      i === csel ? "bg-warm-bg" : ""
    }`;
  const sectionCls = "px-3 pb-1 pt-3 text-[10.5px] font-semibold uppercase tracking-wider text-faint";

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-ink/25 px-4 pt-[13vh] backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[580px] overflow-hidden rounded-2xl border border-warm-border bg-surface shadow-float"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-warm-border px-4 py-3.5">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-brown">
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setSel(0);
            }}
            onKeyDown={onKey}
            placeholder="Ask Scout or jump anywhere…"
            className="flex-1 bg-transparent text-[15.5px] text-ink outline-none placeholder:text-faint"
          />
        </div>
        <div className="max-h-[366px] overflow-y-auto p-1.5">
          {selectable.length === 0 && (
            <div className="px-3 py-6 text-center text-sm text-muted">No matches</div>
          )}
          {actions.length > 0 && <div className={sectionCls}>Ask Scout</div>}
          {actions.map((a) => {
            running++;
            const i = running;
            return (
              <button key={a.label} onMouseEnter={() => setSel(i)} onClick={a.run} className={rowCls(i)}>
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-warm-bg">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted"><path d="M12 5v14M5 12h14" /></svg>
                </span>
                <span className="text-ink">{a.label}</span>
              </button>
            );
          })}
          {findItems.length > 0 && <div className={sectionCls}>Finds</div>}
          {findItems.map(({ find }) => {
            running++;
            const i = running;
            const mo = monogram(find.opp.name);
            const fit = typeof find.opp.fitScore === "number" ? Math.round(find.opp.fitScore * 100) : null;
            return (
              <button key={find.id} onMouseEnter={() => setSel(i)} onClick={() => onOpenFind(find)} className={rowCls(i)}>
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-[9px] font-semibold text-white" style={{ backgroundColor: mo.color }}>
                  {mo.initials}
                </span>
                <span className="min-w-0 flex-1 truncate text-ink">{find.opp.name}</span>
                {fit != null && <span className="text-xs tabular-nums text-faint">{fit}%</span>}
              </button>
            );
          })}
          {goItems.length > 0 && <div className={sectionCls}>Go to</div>}
          {goItems.map(([t, label]) => {
            running++;
            const i = running;
            return (
              <button key={t} onMouseEnter={() => setSel(i)} onClick={() => onGo(t)} className={rowCls(i)}>
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-warm-bg">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted"><path d="M9 6l6 6-6 6" /></svg>
                </span>
                <span className="text-ink">{label}</span>
              </button>
            );
          })}
        </div>
        <div className="flex gap-4 border-t border-warm-border px-4 py-2.5 text-[11px] text-faint">
          <span>↑↓ navigate</span>
          <span>↵ select</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Find peek (slide-over) ---------------- */
function FindPeek({
  find,
  onClose,
  onOpenInFinds,
}: {
  find: Find | null;
  onClose: () => void;
  onOpenInFinds: (f: Find) => void;
}) {
  const [tab, setTab] = useState(0);
  const [shown, setShown] = useState<Find | null>(null);
  useEffect(() => {
    if (find) {
      setShown(find);
      setTab(0);
    }
  }, [find]);
  const open = !!find;
  const f = shown;
  const mo = f ? monogram(f.opp.name) : { initials: "", color: "#7c5837" };
  const st = f ? FIND_STATUS[f.status] : null;
  const fit = f && typeof f.opp.fitScore === "number" ? Math.round(f.opp.fitScore * 100) : null;

  return (
    <>
      <div
        className={`fixed inset-0 z-40 bg-ink/20 transition-opacity duration-200 ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
        onClick={onClose}
      />
      <aside
        className={`fixed right-0 top-0 z-50 flex h-screen w-[600px] max-w-[96vw] flex-col border-l border-warm-border bg-surface shadow-float transition-transform duration-300 ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
        style={{ transitionTimingFunction: "cubic-bezier(.32,.72,0,1)" }}
        aria-hidden={!open}
      >
        {f && (
          <>
            <div className="flex h-12 items-center gap-2 border-b border-warm-border px-3 text-sm text-muted">
              <button onClick={onClose} className="rounded-md p-1.5 transition hover:bg-warm-bg" aria-label="Close">✕</button>
              <button onClick={() => onOpenInFinds(f)} className="rounded-md px-2 py-1 transition hover:bg-warm-bg">
                Open in Finds ↗
              </button>
            </div>
            <div className="overflow-y-auto px-11 py-8">
              <div className="grid h-12 w-12 place-items-center rounded-xl text-[15px] font-semibold text-white" style={{ backgroundColor: mo.color }}>
                {mo.initials}
              </div>
              <h2 className="mt-4 text-2xl font-semibold tracking-tight text-ink">{f.opp.name}</h2>

              <div className="mt-2 space-y-1">
                {st && (
                  <div className="grid grid-cols-[132px_1fr] items-center py-1.5 text-sm">
                    <span className="text-muted">Status</span>
                    <span><span className={`inline-flex rounded-md px-2 py-0.5 text-xs font-medium ${st.cls}`}>{st.label}</span></span>
                  </div>
                )}
                {fit != null && (
                  <div className="grid grid-cols-[132px_1fr] items-center py-1.5 text-sm">
                    <span className="text-muted">Fit</span>
                    <span className="tabular-nums text-ink">{fit}%</span>
                  </div>
                )}
                {f.opp.channel && (
                  <div className="grid grid-cols-[132px_1fr] items-center py-1.5 text-sm">
                    <span className="text-muted">Source</span>
                    <span className="text-ink">{f.opp.channel}</span>
                  </div>
                )}
                {f.opp.contactEmail && (
                  <div className="grid grid-cols-[132px_1fr] items-center py-1.5 text-sm">
                    <span className="text-muted">Contact</span>
                    <span className="truncate text-ink">{f.opp.contactEmail}</span>
                  </div>
                )}
              </div>

              <div className="mt-5 flex gap-1 border-b border-warm-border">
                {["Draft", "Why it fits", "Activity"].map((label, i) => (
                  <button
                    key={label}
                    onClick={() => setTab(i)}
                    className={`-mb-px px-3 py-2 text-sm transition ${
                      tab === i ? "border-b-2 border-brown font-medium text-brown-deep" : "text-muted hover:text-ink"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <div className="mt-4">
                {tab === 0 &&
                  (f.draft?.body ? (
                    <div className="whitespace-pre-wrap rounded-xl border border-warm-border bg-cream p-4 text-[14.5px] leading-relaxed text-body">
                      {f.draft.body}
                    </div>
                  ) : (
                    <div className="rounded-xl border border-dashed border-warm-border p-6 text-center text-sm text-muted">
                      No draft yet.
                      <button onClick={() => onOpenInFinds(f)} className="ml-1 font-medium text-brown hover:text-brown-deep">
                        Draft it in Finds →
                      </button>
                    </div>
                  ))}
                {tab === 1 && (
                  <p className="text-sm leading-relaxed text-body">
                    {f.opp.whyItFits?.trim() || "Scout will note why this one fits once you've worked a few more finds."}
                  </p>
                )}
                {tab === 2 && (
                  <p className="text-sm text-faint">
                    {f.sentAt ? "Reached out, waiting on a reply." : "No activity yet. Draft and send to start the thread."}
                  </p>
                )}
              </div>
            </div>
          </>
        )}
      </aside>
    </>
  );
}

/* ---------------- Settings tab ---------------- */
function BillingTab({
  billing,
  busy,
  onSubscribe,
  onManage,
  onRefresh,
  onRedeem,
}: {
  billing: BillingStatus | null;
  busy: boolean;
  onSubscribe: (tier: "starter" | "pro") => void;
  onManage: () => void;
  onRefresh: () => void;
  onRedeem: (code: string) => Promise<string>;
}) {
  // Refresh once when the tab opens (getToken reads the live session each call).
  useEffect(() => {
    onRefresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Access-code redemption (free-forever comp access).
  const [code, setCode] = useState("");
  const [redeeming, setRedeeming] = useState(false);
  const [redeemMsg, setRedeemMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function submitCode() {
    if (!code.trim() || redeeming) return;
    setRedeeming(true);
    setRedeemMsg(null);
    const err = await onRedeem(code.trim());
    setRedeeming(false);
    if (err) {
      setRedeemMsg({ ok: false, text: err });
    } else {
      setRedeemMsg({ ok: true, text: "You're all set, unlimited access unlocked." });
      setCode("");
    }
  }

  const comp = !!billing?.comp;

  const fmt = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" })
      : "";

  const tier = billing?.tier || "free";
  const paid = tier === "starter" || tier === "pro";
  const used = paid ? billing?.searchesUsed ?? 0 : billing?.freeUsed ?? 0;
  const limit = paid ? billing?.searchLimit ?? 0 : billing?.freeLimit ?? 5;
  const resets = paid ? billing?.periodEnd ?? null : billing?.freeResetsAt ?? null;
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;

  const PLANS = [
    { key: "starter" as const, label: "Starter", price: 15, searches: 30, blurb: "For steady, focused outreach." },
    { key: "pro" as const, label: "Pro", price: 30, searches: 60, blurb: "For heavier weeks and multiple projects." },
  ];

  return (
    <main className="mx-auto w-full max-w-5xl px-8 py-10">
      <h1 className="text-2xl font-semibold tracking-tight text-ink">Plan &amp; billing</h1>
      <p className="mt-1 text-sm text-body">
        Each search finds a fresh batch of people and drafts them a note. Pick the monthly
        volume that fits.
      </p>

      {billing && !billing.billingEnabled && (
        <div className="mt-5 rounded-xl border border-attention/30 bg-attention/10 p-4 text-sm text-body">
          Billing isn&rsquo;t connected yet. Once the Stripe keys are set, plans activate here.
        </div>
      )}

      {/* Current plan + usage */}
      <section className="mt-6 rounded-2xl border border-warm-border bg-surface p-6 shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-muted">
              Current plan
            </div>
            <div className="mt-1 flex items-center gap-2">
              <span className="text-xl font-semibold text-ink">
                {comp ? "Unlimited" : paid ? (tier === "pro" ? "Pro" : "Starter") : "Free"}
              </span>
              {comp && (
                <span className="rounded-full bg-brown px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-white">
                  Comp
                </span>
              )}
              {!comp && paid && billing?.status && (
                <span className="rounded-full bg-brown-tint px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-brown-deep">
                  {billing.status}
                </span>
              )}
            </div>
          </div>
          {!comp && paid && (
            <button
              onClick={onManage}
              disabled={busy}
              className="rounded-xl border border-warm-border px-4 py-2 text-sm font-semibold text-body transition hover:bg-warm-bg disabled:opacity-50"
            >
              Manage subscription
            </button>
          )}
        </div>

        {comp ? (
          <div className="mt-5 flex items-center gap-2 text-sm text-body">
            <span className="text-lg">∞</span>
            <span>Unlimited searches, no monthly cap on this account.</span>
          </div>
        ) : (
          <div className="mt-5">
            <div className="flex items-baseline justify-between text-sm">
              <span className="font-medium tabular-nums text-ink">
                {used} / {limit} searches
              </span>
              {resets && <span className="text-xs text-muted">Resets {fmt(resets)}</span>}
            </div>
            <div className="mt-2 h-2.5 w-full overflow-hidden rounded-full bg-warm-bg">
              <div className="h-full rounded-full bg-brown" style={{ width: `${pct}%` }} />
            </div>
            {!paid && (
              <p className="mt-2 text-xs text-muted">
                You&rsquo;re on the free plan, {limit} searches a month.
              </p>
            )}
          </div>
        )}
      </section>

      {/* Access code, redeem for free-forever (comp) access. */}
      {!comp && (
        <section className="mt-4 rounded-2xl border border-warm-border bg-surface p-6 shadow-card">
          <div className="text-xs font-semibold uppercase tracking-wider text-muted">
            Have an access code?
          </div>
          <p className="mt-1 text-sm text-body">
            Redeem a code for unlimited access, no card required.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input
              value={code}
              onChange={(e) => {
                setCode(e.target.value);
                setRedeemMsg(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitCode();
              }}
              placeholder="Enter code"
              autoCapitalize="characters"
              spellCheck={false}
              className="w-56 rounded-xl border border-warm-border bg-surface px-3.5 py-2.5 text-sm text-ink outline-none transition focus:border-brown focus:ring-4 focus:ring-brown/10"
            />
            <button
              onClick={submitCode}
              disabled={!code.trim() || redeeming}
              className="rounded-xl bg-brown px-4 py-2.5 text-sm font-semibold text-white shadow-soft transition hover:bg-brown-deep disabled:opacity-50"
            >
              {redeeming ? "Redeeming…" : "Redeem"}
            </button>
          </div>
          {redeemMsg && (
            <p
              className={`mt-2 text-xs font-medium ${
                redeemMsg.ok ? "text-emerald-700" : "text-attention"
              }`}
            >
              {redeemMsg.text}
            </p>
          )}
        </section>
      )}

      {/* Plans */}
      {!comp && (
      <section className="mt-4 grid gap-4 sm:grid-cols-2">
        {PLANS.map((p) => {
          const current = tier === p.key;
          const isUpgrade = tier === "starter" && p.key === "pro";
          return (
            <div
              key={p.key}
              className={`rounded-2xl border p-6 shadow-card ${
                current ? "border-brown bg-brown-tint/30" : "border-warm-border bg-surface"
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-lg font-semibold text-ink">{p.label}</span>
                {current && (
                  <span className="rounded-full bg-brown px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-white">
                    Current
                  </span>
                )}
              </div>
              <div className="mt-2 flex items-baseline gap-1">
                <span className="text-3xl font-semibold tracking-tight text-ink">${p.price}</span>
                <span className="text-sm text-muted">/month</span>
              </div>
              <p className="mt-1 text-sm text-body">
                {p.searches} searches a month. {p.blurb}
              </p>
              <button
                onClick={() => (current ? onManage() : onSubscribe(p.key))}
                disabled={busy}
                className={`mt-5 w-full rounded-xl px-4 py-2.5 text-sm font-semibold transition disabled:opacity-50 ${
                  current
                    ? "border border-warm-border text-body hover:bg-warm-bg"
                    : "bg-brown text-white shadow-soft hover:bg-brown-deep"
                }`}
              >
                {current
                  ? "Manage"
                  : !paid
                  ? `Choose ${p.label}`
                  : isUpgrade
                  ? "Upgrade to Pro"
                  : `Switch to ${p.label}`}
              </button>
            </div>
          );
        })}
      </section>
      )}

      {!comp && (
        <p className="mt-4 text-center text-xs text-muted">
          Secure checkout by Stripe. Cancel anytime, you keep your searches until the
          period ends.
        </p>
      )}
    </main>
  );
}

function SettingsTab({
  onStartTour,
  onExport,
  onRedeem,
  isComp,
}: {
  onStartTour: () => void;
  onExport: () => void;
  onRedeem: (code: string) => Promise<string>;
  isComp: boolean;
}) {
  // Theme mirrors the .dark class on <html>; persisted to scout_theme and
  // applied pre-paint by the inline script in layout.tsx.
  const [dark, setDark] = useState(false);
  // Access-code redemption (also on the Billing tab; mirrored here so it's easy
  // to find).
  const [code, setCode] = useState("");
  const [redeeming, setRedeeming] = useState(false);
  const [redeemMsg, setRedeemMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function submitCode() {
    if (!code.trim() || redeeming) return;
    setRedeeming(true);
    setRedeemMsg(null);
    const err = await onRedeem(code.trim());
    setRedeeming(false);
    if (err) setRedeemMsg({ ok: false, text: err });
    else {
      setRedeemMsg({ ok: true, text: "You're all set, unlimited access unlocked." });
      setCode("");
    }
  }
  // Change password (signed-in user; no email round-trip needed).
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [pwMsg, setPwMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function changePassword() {
    if (pwBusy || !supabase) return;
    setPwMsg(null);
    if (newPw.length < 6) {
      setPwMsg({ ok: false, text: "Password must be at least 6 characters." });
      return;
    }
    if (newPw !== confirmPw) {
      setPwMsg({ ok: false, text: "Those passwords don't match." });
      return;
    }
    setPwBusy(true);
    const { error } = await supabase.auth.updateUser({ password: newPw });
    setPwBusy(false);
    if (error) {
      setPwMsg({ ok: false, text: error.message || "Couldn't update your password." });
    } else {
      setPwMsg({ ok: true, text: "Password updated." });
      setNewPw("");
      setConfirmPw("");
    }
  }
  // Auto-schedule after-hours sends for the recipient's next business hour.
  const [autoSchedule, setAutoSchedule] = useState(false);
  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
    try {
      setAutoSchedule(localStorage.getItem(AUTOSCHED_KEY) === "1");
    } catch {}
  }, []);
  function setAutoSchedulePref(next: boolean) {
    setAutoSchedule(next);
    try {
      localStorage.setItem(AUTOSCHED_KEY, next ? "1" : "0");
    } catch {}
  }
  function setTheme(next: boolean) {
    setDark(next);
    const root = document.documentElement;
    // Enable the global color cross-fade only for the duration of the switch,
    // then strip it so it never slows down ordinary hovers/interactions.
    root.classList.add("theme-transition");
    root.classList.toggle("dark", next);
    window.clearTimeout((setTheme as any)._t);
    (setTheme as any)._t = window.setTimeout(() => {
      root.classList.remove("theme-transition");
    }, 550);
    try {
      localStorage.setItem("scout_theme", next ? "dark" : "light");
    } catch {}
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight text-ink">
        <span className="text-brown">Settings</span>
      </h1>
      <p className="mt-2 text-[15px] leading-relaxed text-body">
        Small preferences that shape how Scout shows up for you.
      </p>

      {/* Access code */}
      <section className="mt-8 rounded-3xl border border-warm-border bg-surface p-6 shadow-soft sm:p-8">
        <h2 className="text-base font-extrabold tracking-tight text-ink">Access code</h2>
        {isComp ? (
          <p className="mt-1 flex items-center gap-2 text-sm leading-relaxed text-body">
            <span className="text-lg">∞</span>
            You have unlimited access, no code needed.
          </p>
        ) : (
          <>
            <p className="mt-1 text-sm leading-relaxed text-body">
              Have a code? Redeem it for free, unlimited access, no card required.
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <input
                value={code}
                onChange={(e) => {
                  setCode(e.target.value);
                  setRedeemMsg(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitCode();
                }}
                placeholder="Enter code"
                autoCapitalize="characters"
                spellCheck={false}
                className="w-56 rounded-xl border border-warm-border bg-surface px-3.5 py-2.5 text-sm text-ink outline-none transition focus:border-brown focus:ring-4 focus:ring-brown/10"
              />
              <button
                onClick={submitCode}
                disabled={!code.trim() || redeeming}
                className="rounded-xl bg-brown px-4 py-2.5 text-sm font-semibold text-white shadow-soft transition hover:bg-brown-deep disabled:opacity-50"
              >
                {redeeming ? "Redeeming…" : "Redeem"}
              </button>
            </div>
            {redeemMsg && (
              <p
                className={`mt-2 text-xs font-medium ${
                  redeemMsg.ok ? "text-emerald-700" : "text-attention"
                }`}
              >
                {redeemMsg.text}
              </p>
            )}
          </>
        )}
      </section>

      {/* Password */}
      <section className="mt-8 rounded-3xl border border-warm-border bg-surface p-6 shadow-soft sm:p-8">
        <h2 className="text-base font-extrabold tracking-tight text-ink">Password</h2>
        <p className="mt-1 text-sm leading-relaxed text-body">
          Change the password you use to sign in.
        </p>
        <div className="mt-4 grid max-w-sm gap-3">
          <input
            type="password"
            value={newPw}
            onChange={(e) => {
              setNewPw(e.target.value);
              setPwMsg(null);
            }}
            placeholder="New password"
            autoComplete="new-password"
            className="w-full rounded-xl border border-warm-border bg-surface px-3.5 py-2.5 text-sm text-ink outline-none transition focus:border-brown focus:ring-4 focus:ring-brown/10"
          />
          <input
            type="password"
            value={confirmPw}
            onChange={(e) => {
              setConfirmPw(e.target.value);
              setPwMsg(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") changePassword();
            }}
            placeholder="Confirm new password"
            autoComplete="new-password"
            className="w-full rounded-xl border border-warm-border bg-surface px-3.5 py-2.5 text-sm text-ink outline-none transition focus:border-brown focus:ring-4 focus:ring-brown/10"
          />
          <div className="flex items-center gap-3">
            <button
              onClick={changePassword}
              disabled={pwBusy || !newPw || !confirmPw}
              className="rounded-xl bg-brown px-4 py-2.5 text-sm font-semibold text-white shadow-soft transition hover:bg-brown-deep disabled:opacity-50"
            >
              {pwBusy ? "Updating…" : "Update password"}
            </button>
            {pwMsg && (
              <span
                className={`text-xs font-medium ${
                  pwMsg.ok ? "text-emerald-700" : "text-attention"
                }`}
              >
                {pwMsg.text}
              </span>
            )}
          </div>
        </div>
      </section>

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
                    ? "bg-surface text-ink shadow-card"
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

      {/* Sending */}
      <section className="mt-6 rounded-3xl border border-warm-border bg-surface p-6 shadow-soft sm:p-8">
        <h2 className="text-base font-extrabold tracking-tight text-ink">Sending</h2>
        <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-md">
            <div className="text-sm font-bold text-ink">
              Auto-schedule for the next business hour
            </div>
            <p className="mt-1 text-sm leading-relaxed text-body">
              When you send outside a recipient&apos;s business hours, Scout
              quietly queues the message for their next business hour instead of
              asking, so it lands when it&apos;s most likely to be read. You can
              still schedule any send by hand.
            </p>
          </div>
          <button
            role="switch"
            aria-checked={autoSchedule}
            aria-label="Auto-schedule after-hours sends for the next business hour"
            onClick={() => setAutoSchedulePref(!autoSchedule)}
            className={`relative mt-1 inline-flex h-7 w-12 shrink-0 items-center rounded-full transition ${
              autoSchedule ? "bg-brown" : "bg-warm-border"
            }`}
          >
            <span
              className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-soft transition ${
                autoSchedule ? "translate-x-6" : "translate-x-1"
              }`}
            />
          </button>
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
  onUpdate,
  projects,
  categories,
  scopeProjectId,
  scopeCategoryId,
  setScopeProjectId,
  setScopeCategoryId,
  signature,
  onSignature,
  onBuildSignature,
  setProjectSignature,
  activeProjectId,
}: {
  kinds: string[];
  channel: string;
  setChannel: (v: string) => void;
  text: string;
  setText: (v: string) => void;
  add: () => void;
  list: OutreachTemplate[];
  remove: (id: string) => void;
  onUpdate: (
    id: string,
    patch: { channel: string; text: string; projectId?: string; categoryId?: string }
  ) => void;
  projects: Project[];
  categories: Category[];
  scopeProjectId: string;
  scopeCategoryId: string;
  setScopeProjectId: (id: string) => void;
  setScopeCategoryId: (id: string) => void;
  signature: string;
  onSignature: (v: string) => void;
  onBuildSignature: () => Promise<string>;
  setProjectSignature: (projectId: string, sig: string) => void;
  activeProjectId: string;
}) {
  // Email-signature editor state: which project (if any) the per-project
  // signature editor is pointed at, and whether a "build from resume" is running.
  // Defaults to the project you're currently working in so it opens ready to edit.
  const [sigProjectId, setSigProjectId] = useState(
    projects.some((p) => p.id === activeProjectId) ? activeProjectId : ""
  );
  const [buildingSig, setBuildingSig] = useState(false);
  const sigProject = projects.find((p) => p.id === sigProjectId);
  async function buildDefaultSig() {
    if (buildingSig) return;
    setBuildingSig(true);
    try {
      const s = await onBuildSignature();
      if (s) onSignature(s);
    } finally {
      setBuildingSig(false);
    }
  }
  // Which saved template (by id) is loaded into the form above for editing.
  // "" means the form is in add-a-new-template mode.
  const [editingId, setEditingId] = useState("");
  function startEdit(t: OutreachTemplate) {
    setEditingId(t.id);
    setChannel(t.channel);
    setText(t.text);
    setScopeProjectId(t.projectId || "");
    setScopeCategoryId(t.categoryId || "");
  }
  function cancelEdit() {
    setEditingId("");
    setText("");
  }
  function submit() {
    if (!text.trim()) return;
    if (editingId) {
      onUpdate(editingId, {
        channel,
        text: text.trim(),
        projectId: scopeProjectId || undefined,
        categoryId: scopeProjectId && scopeCategoryId ? scopeCategoryId : undefined,
      });
      setEditingId("");
      setText("");
    } else {
      add();
    }
  }
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
        Your <span className="text-brown">templates</span>
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
        <div className="mt-5 flex items-center gap-3">
          <button
            onClick={submit}
            disabled={!text.trim()}
            className="rounded-xl bg-brand-gradient px-6 py-3 text-sm font-bold text-white shadow-soft transition hover:opacity-95 disabled:opacity-50"
          >
            {editingId ? "Update template" : "Save template"}
          </button>
          {editingId && (
            <button
              onClick={cancelEdit}
              className="text-sm font-semibold text-body/60 transition hover:text-accent"
            >
              Cancel edit
            </button>
          )}
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
                className={`rounded-2xl border p-5 shadow-card transition ${
                  editingId === s.id
                    ? "border-coral/50 bg-warm-bg/40"
                    : "border-warm-border bg-surface"
                }`}
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
                  <span className="ml-auto flex items-center gap-3">
                    <button
                      onClick={() => startEdit(s)}
                      className="text-xs font-semibold text-body/60 transition hover:text-accent"
                    >
                      {editingId === s.id ? "Editing…" : "Edit"}
                    </button>
                    <button
                      onClick={() => remove(s.id)}
                      className="text-xs font-semibold text-body/60 transition hover:text-accent"
                    >
                      Remove
                    </button>
                  </span>
                </div>
                <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-body">
                  {s.text}
                </pre>
              </div>
            ))}
          </Reveal>
        )}
      </section>

      {/* -------- Email signatures -------- */}
      <section className="mt-7 rounded-3xl border border-warm-border bg-surface p-6 shadow-soft sm:p-8">
        <h2 className="text-base font-extrabold tracking-tight text-ink">Email signatures</h2>
        <p className="mt-1 text-sm leading-relaxed text-body">
          Signed onto the end of every email Scout drafts (not DMs). Set a default,
          then give any project its own, outreach for that project signs off with the
          project&rsquo;s signature automatically.
        </p>

        {/* Account-wide default */}
        <div className="mt-5">
          <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
            <Label className="mb-0">Default signature</Label>
            <button
              onClick={buildDefaultSig}
              disabled={buildingSig}
              title="Build a signature from your resume / bio (you can edit it after)"
              className="rounded-lg border border-warm-border px-3 py-1.5 text-xs font-semibold text-accent transition hover:bg-warm-bg disabled:opacity-40"
            >
              {buildingSig ? "Building…" : signature.trim() ? "Rebuild from resume" : "Build from my resume"}
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
            Used for any project that doesn&rsquo;t have its own signature. Leave blank to
            let Scout sign off with just your name.
          </p>
        </div>

        {/* Per-project override */}
        {projects.length > 0 && (
          <div className="mt-6 border-t border-warm-border pt-5">
            <Label>Signature for a specific project</Label>
            <select
              value={sigProjectId}
              onChange={(e) => setSigProjectId(e.target.value)}
              className="scout-select mt-1 w-full rounded-xl border border-warm-border bg-surface px-3.5 py-3 text-sm font-semibold text-ink outline-none transition focus:border-coral focus:ring-4 focus:ring-coral/15 sm:max-w-xs"
            >
              <option value="">Choose a project…</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.signature && p.signature.trim() ? " • has its own" : " • uses default"}
                </option>
              ))}
            </select>

            {sigProject && (
              <div className="mt-3">
                <textarea
                  value={sigProject.signature ?? ""}
                  onChange={(e) => setProjectSignature(sigProject.id, e.target.value)}
                  rows={4}
                  placeholder={
                    signature.trim()
                      ? `Leave blank to use your default signature:\n\n${signature}`
                      : "e.g.\nJordan Lee\nA&R, Cedar Records\njordan@cedar.co"
                  }
                  className="w-full resize-y rounded-xl border border-warm-border px-3.5 py-3 text-sm leading-relaxed text-ink outline-none transition focus:border-coral focus:ring-4 focus:ring-coral/15"
                />
                <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs leading-relaxed text-body/70">
                    Every email drafted for <span className="font-semibold text-ink">{sigProject.name}</span>{" "}
                    signs off with this. Blank falls back to your default.
                  </p>
                  {sigProject.signature && sigProject.signature.trim() && (
                    <button
                      onClick={() => setProjectSignature(sigProject.id, "")}
                      className="shrink-0 text-xs font-semibold text-body/60 transition hover:text-accent"
                    >
                      Reset to default
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
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

// Edit the company's onboarding answers (name / what it does / industry /
// website) from Profile. The company owner (admin) can edit them — they're the
// shared company record on the workspace; other members see them read-only. When
// there's no workspace yet, it falls back to editing just the profile's company
// name so the field is never missing.
function CompanyDetailsEditor({
  getToken,
  workspaceId,
  companyName,
  onCompanyName,
}: {
  getToken?: () => Promise<string | null>;
  workspaceId: string;
  companyName: string;
  onCompanyName: (v: string) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [found, setFound] = useState(false); // did we load a real workspace record?
  const [role, setRole] = useState("");
  const [name, setName] = useState(companyName);
  const [about, setAbout] = useState("");
  const [website, setWebsite] = useState("");
  const [industry, setIndustry] = useState("");
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!workspaceId || !getToken) {
        setLoading(false);
        return;
      }
      try {
        const token = await getToken();
        const res = await fetch("/api/team/workspace", {
          headers: token ? { authorization: `Bearer ${token}` } : {},
        });
        const data = await res.json().catch(() => ({}));
        const ws = (data.workspaces || []).find((w: any) => w.id === workspaceId);
        if (alive && ws) {
          setFound(true);
          setRole(ws.role || "member");
          setName(ws.name || companyName || "");
          setAbout(ws.about || "");
          setWebsite(ws.website || "");
          setIndustry(ws.industry || "");
        }
      } catch {
        /* teams may not be set up; fall back to the profile name */
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  const isOwner = role === "owner";
  const inputCls =
    "w-full rounded-xl border border-warm-border px-3.5 py-3 text-sm text-ink outline-none transition focus:border-coral focus:ring-4 focus:ring-coral/15";

  async function save() {
    if (saving || !getToken) return;
    if (!name.trim()) {
      setNote({ ok: false, text: "Your company needs a name." });
      return;
    }
    setSaving(true);
    setNote(null);
    try {
      const token = await getToken();
      const res = await fetch("/api/team/workspace", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ workspaceId, name, about, website, industry }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        onCompanyName(name.trim()); // keep the profile in sync
        setNote({ ok: true, text: "Saved. Your whole team sees these updates." });
      } else {
        setNote({ ok: false, text: data?.error || "Couldn't save." });
      }
    } catch {
      setNote({ ok: false, text: "Couldn't save." });
    } finally {
      setSaving(false);
    }
  }

  // No workspace, or it couldn't be loaded (teams not set up): a simple
  // profile-only company-name field so it's always editable.
  if (!workspaceId || (!loading && !found)) {
    return (
      <FadeIn as="section" className="mt-7 rounded-3xl border border-warm-border bg-surface p-6 shadow-soft sm:p-8">
        <h2 className="text-base font-extrabold tracking-tight text-ink">Your company</h2>
        <div className="mt-4">
          <Label>Company name</Label>
          <input
            value={companyName}
            onChange={(e) => onCompanyName(e.target.value)}
            placeholder="e.g. Cedar & Co. Studio"
            className={inputCls}
          />
        </div>
      </FadeIn>
    );
  }

  return (
    <FadeIn as="section" className="mt-7 rounded-3xl border border-warm-border bg-surface p-6 shadow-soft sm:p-8">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-extrabold tracking-tight text-ink">Your company</h2>
        <span className="text-[11px] font-bold uppercase tracking-wider text-body/50">
          {isOwner ? "You're the admin" : "Shared, admin-managed"}
        </span>
      </div>
      <p className="mt-1 text-sm leading-relaxed text-body">
        {isOwner
          ? "Your answers from setup. Change them anytime, your whole team sees the updates."
          : "Your company's details, managed by the admin."}
      </p>
      {loading ? (
        <div className="mt-4 h-5 w-40 animate-pulse rounded bg-warm-bg" />
      ) : (
        <>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <Label>Company name</Label>
              <input value={name} onChange={(e) => setName(e.target.value)} disabled={!isOwner} placeholder="e.g. Cedar & Co. Studio" className={`${inputCls} disabled:opacity-70`} />
            </div>
            <div>
              <Label>Industry</Label>
              <input value={industry} onChange={(e) => setIndustry(e.target.value)} disabled={!isOwner} placeholder="e.g. Music" className={`${inputCls} disabled:opacity-70`} />
            </div>
          </div>
          <div className="mt-4">
            <Label>What does the company do?</Label>
            <textarea value={about} onChange={(e) => setAbout(e.target.value)} disabled={!isOwner} rows={2} placeholder="What the company does, who it serves." className={`${inputCls} resize-y leading-relaxed disabled:opacity-70`} />
          </div>
          <div className="mt-4">
            <Label>Website</Label>
            <input value={website} onChange={(e) => setWebsite(e.target.value)} disabled={!isOwner} placeholder="e.g. cedarco.com" className={`${inputCls} disabled:opacity-70`} />
          </div>
          {isOwner && (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                onClick={save}
                disabled={saving}
                className="rounded-xl bg-brown px-5 py-2.5 text-sm font-bold text-white shadow-soft transition hover:bg-brown-deep disabled:opacity-50"
              >
                {saving ? "Saving…" : "Save company details"}
              </button>
              {note && (
                <span className={`text-xs font-medium ${note.ok ? "text-emerald-700" : "text-attention"}`}>
                  {note.text}
                </span>
              )}
            </div>
          )}
        </>
      )}
    </FadeIn>
  );
}

/* ---------------- Profile tab ---------------- */
function ProfileTab({
  name,
  bio,
  linkedin,
  useCase,
  accountType,
  companyWorkspaceId,
  getToken,
  companyName,
  companyRole,
  companyContribution,
  onCompanyName,
  onCompanyRole,
  onCompanyContribution,
  age,
  eduStatus,
  college,
  major,
  location,
  companySize,
  competitiveness,
  onName,
  onBio,
  onLinkedin,
  onAge,
  onMajor,
  onEduStatus,
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
  onSetProjectContext,
  onSetProjectUsesProfile,
  resumeFileName,
  onResumeFile,
  onClearResume,
  signature,
  onSignature,
}: {
  name: string;
  bio: string;
  linkedin: string;
  useCase: string;
  accountType: AccountType;
  companyWorkspaceId: string;
  getToken?: () => Promise<string | null>;
  companyName: string;
  companyRole: string;
  companyContribution: string;
  onCompanyName: (v: string) => void;
  onCompanyRole: (v: string) => void;
  onCompanyContribution: (v: string) => void;
  age?: number;
  eduStatus: EducationStatus;
  college: string;
  major: string;
  location: string;
  companySize: CompanySize;
  competitiveness: Competitiveness;
  onName: (v: string) => void;
  onBio: (v: string) => void;
  onLinkedin: (v: string) => void;
  onAge: (v: number | undefined) => void;
  onEduStatus: (v: EducationStatus) => void;
  onCollege: (v: string) => void;
  onMajor: (v: string) => void;
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
  onSetProjectContext: (id: string, context: string) => void;
  onSetProjectUsesProfile: (id: string, usesProfile: boolean) => void;
  resumeFileName: string;
  onResumeFile: (file: File) => void;
  onClearResume: () => void;
  signature: string;
  onSignature: (v: string) => void;
}) {
  const [parsing, setParsing] = useState(false);
  const [autofilled, setAutofilled] = useState(false);
  const [note, setNote] = useState("");
  const [eduOtherOpen, setEduOtherOpen] = useState(false); // education "Other" dropdown
  // Whether to show the job-applicant follow-ups (company size + competitive-
  // ness). Defaults to true when the user's use case looks job-shaped OR when
  // they've already set either field to a non-default value on a previous
  // visit, so we don't hide answers they already picked.
  const [jobApplicant, setJobApplicant] = useState<boolean>(
    isJobUseCaseClient(useCase) ||
      (!!companySize && companySize !== "any") ||
      (!!competitiveness && competitiveness !== "any")
  );
  // Individual vs company is chosen once at signup (accountType), no in-profile
  // toggle. Company profiles fill from a website, individuals from a resume.
  const kind: "individual" | "company" = accountType === "company" ? "company" : "individual";
  const [website, setWebsite] = useState("");

  // Read some source text (a resume, a LinkedIn PDF/About section, a bio) and let
  // Scout fill in name + use case from it. keepBio=false when the text is already
  // in the bio box (the "read this" button), so we don't stomp the user's edits.
  // silent = the background auto-read that runs as the user edits the bio: it
  // stays quiet unless it actually fills a new field, so it never nags.
  async function readAndFill(text: string, keepBio = true, silent = false) {
    const t = (text || "").trim();
    if (!t) return;
    if (keepBio) onBio(t);
    if (!silent) {
      setNote("");
      setAutofilled(false);
    }
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
      } else if (!silent && res.ok) {
        setNote("Saved it below. Add your name and use case to finish.");
      } else if (!silent) {
        setNote(data?.error || "Couldn't read that. Add your details below.");
      }
    } catch {
      if (!silent) setNote("Saved it below. Add your name and use case to finish.");
    } finally {
      setParsing(false);
    }
  }

  // Auto-read the bio as it's edited: whenever the field changes and settles,
  // Scout parses it in the background and fills any new info it finds (empty
  // fields only). No button to press. lastParsed guards against re-parsing the
  // bio loaded on mount and against re-running on an unchanged value.
  const lastParsed = useRef<string>("__init__");
  useEffect(() => {
    if (lastParsed.current === "__init__") {
      lastParsed.current = bio; // don't parse the value already loaded on mount
      return;
    }
    const t = bio.trim();
    if (t.length < 40 || bio === lastParsed.current) return;
    const timer = setTimeout(() => {
      lastParsed.current = bio;
      readAndFill(bio, false, true);
    }, 1200);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bio]);

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
        Your <span className="text-brown">profile</span>
      </h1>
      <p className="mt-2 text-[15px] leading-relaxed text-body">
        Drop in your resume, LinkedIn, or company website and Scout fills the rest
        for you. Everything stays editable, and it shapes who we find and how your
        messages sound.
      </p>

      {/* Mailbox connection moved to the Account tab ("Send from your email"). */}

      {/* Company accounts: role + how you serve the company's work (set at
          signup, editable here). Individuals never see this. */}
      {kind === "company" && (
        <>
          {/* The company's onboarding answers, editable from Profile. Admin edits
              the shared record; members see it read-only. */}
          <CompanyDetailsEditor
            getToken={getToken}
            workspaceId={companyWorkspaceId}
            companyName={companyName}
            onCompanyName={onCompanyName}
          />

          {/* This person's role on the company (personal, drives their drafts). */}
          <FadeIn as="section" className="mt-7 rounded-3xl border border-warm-border bg-surface p-6 shadow-soft sm:p-8">
            <h2 className="text-base font-extrabold tracking-tight text-ink">Your role</h2>
            <p className="mt-1 text-sm leading-relaxed text-body">
              Scout writes on behalf of the company, so this matters more than a personal resume.
            </p>
            <div className="mt-4">
              <Label>Your role at the company</Label>
              <input
                value={companyRole}
                onChange={(e) => onCompanyRole(e.target.value)}
                placeholder="e.g. Head of Partnerships"
                className="w-full rounded-xl border border-warm-border px-3.5 py-3 text-sm text-ink outline-none transition focus:border-coral focus:ring-4 focus:ring-coral/15"
              />
            </div>
            <div className="mt-4">
              <Label>How you serve the company&apos;s work</Label>
              <textarea
                value={companyContribution}
                onChange={(e) => onCompanyContribution(e.target.value)}
                rows={3}
                placeholder="What you own and drive on the company's projects."
                className="w-full resize-y rounded-xl border border-warm-border px-3.5 py-3 text-sm leading-relaxed text-ink outline-none transition focus:border-coral focus:ring-4 focus:ring-coral/15"
              />
            </div>
          </FadeIn>
        </>
      )}

      <FadeIn as="section" className="mt-7 rounded-3xl border border-warm-border bg-surface p-6 shadow-soft sm:p-8">
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

        <div className="mt-6">
          <div className="sm:max-w-md">
            <Label>{kind === "company" ? "Your company name" : "Your name"}</Label>
            <input
              value={name}
              onChange={(e) => onName(e.target.value)}
              placeholder={kind === "company" ? "e.g. Acme Studio" : "e.g. Alex Rivera"}
              className="w-full rounded-xl border border-warm-border px-3.5 py-3 text-sm text-ink outline-none transition focus:border-coral focus:ring-4 focus:ring-coral/15"
            />
          </div>
        </div>

        {/* -------- About you: personalization Scout weaves into search + drafts.
             For company accounts this is the PERSONAL side (the company side is
             the "Your company role" section above), so a company admin has both
             and can run personal projects from the same account. -------- */}
        <div className="mt-7 rounded-2xl border border-warm-border bg-warm-bg/40 p-5">
          <div className="mb-3">
            <h3 className="text-sm font-extrabold tracking-tight text-ink">
              {kind === "company" ? "About you (personal side)" : "About you"}
            </h3>
            <p className="mt-0.5 text-xs leading-relaxed text-body/70">
              {kind === "company"
                ? "Optional. Your personal details, separate from the company above. Scout uses these when you run personal projects from this account."
                : "Optional. Scout uses these to match you with the right opportunities and to sound like you in outreach."}
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
              <ComboInput
                value={college}
                onChange={onCollege}
                options={SCHOOL_SUGGESTIONS}
                placeholder="e.g. USC junior, MFA 2022, self-taught"
              />
            </div>
            <div>
              <Label>Location</Label>
              <ComboInput
                value={location}
                onChange={onLocation}
                options={CITY_SUGGESTIONS}
                placeholder="e.g. Los Angeles, CA"
              />
            </div>
          </div>

          <div className="mt-4">
            <Label>Major / field of study</Label>
            <input
              value={major}
              onChange={(e) => onMajor(e.target.value)}
              placeholder="e.g. Marketing, Computer Science, Film Production"
              className="w-full rounded-xl border border-warm-border px-3.5 py-3 text-sm text-ink outline-none transition focus:border-coral focus:ring-4 focus:ring-coral/15 sm:max-w-md"
            />
          </div>

          <div className="mt-5">
              <Label>Education status</Label>
              <div className="inline-flex flex-wrap gap-1 rounded-xl border border-warm-border bg-warm-bg/40 p-1">
                {(
                  [
                    ["", "Prefer not to say"],
                    ["highschool", "High schooler"],
                    ["college", "In college"],
                    ["graduated", "Graduated"],
                  ] as const
                ).map(([val, label]) => (
                  <button
                    key={val || "unset"}
                    onClick={() => {
                      onEduStatus(val);
                      setEduOtherOpen(false);
                    }}
                    className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                      eduStatus === val
                        ? "bg-surface text-ink shadow-card"
                        : "text-body/70 hover:text-ink"
                    }`}
                  >
                    {label}
                  </button>
                ))}
                <button
                  onClick={() => setEduOtherOpen(true)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                    (EDU_OTHER as string[]).includes(eduStatus)
                      ? "bg-surface text-ink shadow-card"
                      : "text-body/70 hover:text-ink"
                  }`}
                >
                  Other…
                </button>
              </div>
              {(eduOtherOpen || (EDU_OTHER as string[]).includes(eduStatus)) && (
                <select
                  value={(EDU_OTHER as string[]).includes(eduStatus) ? eduStatus : ""}
                  onChange={(e) => onEduStatus(e.target.value as EducationStatus)}
                  className="scout-select mt-2 block w-full rounded-xl border border-warm-border bg-surface px-3.5 py-2.5 text-sm text-ink outline-none transition focus:border-coral focus:ring-4 focus:ring-coral/15 sm:max-w-xs"
                >
                  <option value="">Choose one…</option>
                  {EDU_OTHER.map((val) => (
                    <option key={val} value={val}>
                      {EDU_STATUS_LABEL[val]}
                    </option>
                  ))}
                </select>
              )}
          </div>

          <div className="mt-5">
            <Label>Are you applying to jobs or internships?</Label>
            <div className="inline-flex flex-wrap gap-1 rounded-xl border border-warm-border bg-warm-bg/40 p-1">
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
                      ? "bg-surface text-ink shadow-card"
                      : "text-body/70 hover:text-ink"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {jobApplicant && (
            <div className="mt-5 grid gap-5 sm:grid-cols-2">
              <div>
                <Label>Company size you want</Label>
                <div className="inline-flex flex-wrap gap-1 rounded-xl border border-warm-border bg-warm-bg/40 p-1">
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
                          ? "bg-surface text-ink shadow-card"
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
                <div className="inline-flex flex-wrap gap-1 rounded-xl border border-warm-border bg-warm-bg/40 p-1">
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
                          ? "bg-surface text-ink shadow-card"
                          : "text-body/70 hover:text-ink"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-body/70">
                  First-time applicant? Pick <span className="font-semibold">Beginner</span>, 
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
              {parsing && (
                <span className="flex items-center gap-1.5 text-xs font-semibold text-accent">
                  <span className="h-3 w-3 animate-spin rounded-full border-2 border-warm-border border-t-coral" />
                  Reading…
                </span>
              )}
            </div>
          </div>
          <textarea
            value={bio}
            onChange={(e) => onBio(e.target.value)}
            rows={11}
            placeholder="Paste anything that tells us who you are: your LinkedIn About section, a short bio, your company's about page, your experience. Scout reads it as you type and fills in your name, use case, and details automatically. The more you give, the more personal your outreach becomes."
            className="w-full resize-y rounded-xl border border-warm-border px-3.5 py-3 text-sm leading-relaxed text-ink outline-none transition focus:border-coral focus:ring-4 focus:ring-coral/15"
          />
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
          onSetProjectContext={onSetProjectContext}
          onSetProjectUsesProfile={onSetProjectUsesProfile}
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
        First, tell <span className="text-brown">Scout</span> who you are
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
  onSetProjectContext,
  onSetProjectUsesProfile,
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
  onSetProjectContext: (id: string, context: string) => void;
  onSetProjectUsesProfile: (id: string, usesProfile: boolean) => void;
}) {
  const [newProject, setNewProject] = useState("");

  return (
    <div>
      <Label>Your projects and categories</Label>
      <p className="mt-1 mb-3 text-xs leading-relaxed text-body/70">
        A project is usually one client, brand, or goal you're working on. Describe
        what it's for, choose whether it uses your Profile, and manage its
        categories, the kinds of people you search for. Drag to reorder, click to
        select and delete, or add your own. Synced with the Outreach tab.
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
                <div className="mb-1 flex items-center justify-between gap-2">
                  <Label className="mb-0">What is this project for?</Label>
                  <MicButton
                    onAppend={(t) =>
                      onSetProjectContext(p.id, joinSpoken(p.context || "", t))
                    }
                  />
                </div>
                <textarea
                  defaultValue={p.context || ""}
                  key={p.context || ""}
                  onBlur={(e) => {
                    if (e.target.value !== (p.context || ""))
                      onSetProjectContext(p.id, e.target.value);
                  }}
                  rows={2}
                  placeholder="e.g. a sustainable-fashion DTC brand launching a new collection, targeting Gen Z shoppers who care about ethical sourcing."
                  className="w-full resize-y rounded-xl border border-warm-border px-3.5 py-2.5 text-sm leading-relaxed text-ink outline-none transition focus:border-coral focus:ring-4 focus:ring-coral/15"
                />
                <label className="mt-2.5 flex cursor-pointer items-start gap-2.5">
                  <input
                    type="checkbox"
                    checked={p.usesProfile !== false}
                    onChange={(e) => onSetProjectUsesProfile(p.id, e.target.checked)}
                    className="mt-0.5 h-4 w-4 shrink-0 rounded border-warm-border text-brown accent-brown focus:ring-brown/30"
                  />
                  <span className="text-xs leading-relaxed text-body/80">
                    <span className="font-semibold text-ink">Use my Profile for this project</span>
                    <br />
                    On, searches match your industry and learn from your other projects. Turn
                    it off when this project represents someone outside your field so results
                    don&apos;t bias toward you.
                  </span>
                </label>
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
