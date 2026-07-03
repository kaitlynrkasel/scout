"use client";

import { useEffect, useRef, useState } from "react";
import { ucInfo, ucKey, USE_CASE_SUGGESTIONS } from "@/lib/templates";
import type { Draft, Opportunity, OutreachTemplate } from "@/lib/types";
import type { Session } from "@supabase/supabase-js";
import AuthScreen from "./AuthScreen";
import { fileToText } from "@/lib/fileText";
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

// Suggested categories for a use case: tailored set for a preset, generic otherwise.
function suggestionsFor(useCase: string): { name: string; goal: string }[] {
  return SUGGESTED[ucKey(useCase)] || GENERIC_SUGGESTIONS;
}

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

interface Activity {
  searches: number;
  found: number;
  drafts: number;
  copies: number;
}
const ZERO_ACTIVITY: Activity = { searches: 0, found: 0, drafts: 0, copies: 0 };

interface Profile {
  name: string;
  bio: string;
  useCase: string; // free text; matched to a preset when it can be, else read as-is
  linkedin?: string;
}
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
  denyReason?: string; // why the user passed on this find
  requirements?: string; // what this target asks for (pasted or found by deep-scan)
  sentAt?: number; // when the outreach actually went out (drives follow-up timing)
  lastFollowUpAt?: number; // when the most recent follow-up nudge was drafted/sent
  scanned?: boolean; // deep-scan has already run on this find's site
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

function normNameKey(s: string): string {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}
function urlHostKey(u: string): string {
  const m = String(u || "").match(/^https?:\/\/([^/?#]+)/i);
  return m ? m[1].replace(/^www\./, "").toLowerCase() : "";
}
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
      setInitial(
        p
          ? { name: p.name, bio: p.bio, useCase: p.useCase || "Networking", linkedin: p.linkedin || "" }
          : { name: "", bio: "", useCase: "Networking", linkedin: "" }
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
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
          dbSaveProfile(session.user.id, {
            name: n.name,
            bio: n.bio,
            useCase: n.useCase,
            linkedin: n.linkedin || "",
          });
        }, 700);
      }}
      onLogout={() => supabase?.auth.signOut()}
      showLogout
      getToken={async () => {
        const { data } = await supabase!.auth.getSession();
        return data.session?.access_token ?? null;
      }}
      initialState={initialState}
      onSaveState={(s) => {
        if (stateTimer.current) clearTimeout(stateTimer.current);
        stateTimer.current = setTimeout(() => {
          dbSaveState(session.user.id, s);
        }, 800);
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
    "outreach" | "finds" | "dashboard" | "team" | "templates" | "profile" | "account"
  >("dashboard");

  // ---- Outreach state ----
  const [catId, setCatId] = useState<string>(""); // selected category, "" = custom
  const [editingCats, setEditingCats] = useState(false); // category manager open?
  const [editingProjects, setEditingProjects] = useState(false); // project manager open?
  const [goal, setGoal] = useState("");
  const [discovering, setDiscovering] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState("");
  const [apiReason, setApiReason] = useState<string | null>(null); // 'credits'|'auth'|'rate'
  const [opps, setOpps] = useState<Opportunity[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [drafts, setDrafts] = useState<Draft[]>([]);
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
  const [scanningId, setScanningId] = useState(""); // find being deep-scanned
  const [followUpId, setFollowUpId] = useState(""); // find getting a follow-up draft

  // ---- Gmail connection ----
  const [gmail, setGmail] = useState<{
    connected: boolean;
    email?: string;
    sendMode?: "draft" | "send";
  }>({ connected: false });
  const [gmailBusyId, setGmailBusyId] = useState(""); // draft being sent/drafted
  const [gmailSent, setGmailSent] = useState<Record<string, "draft" | "send">>({});
  const [gmailNote, setGmailNote] = useState(""); // message after the OAuth return

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
    const prof: Profile = initialProfile;
    let cats: Category[] = [];
    let projs: Project[] = [];
    let active = "";
    let tpls: OutreachTemplate[] = [];
    let act: Partial<Activity> | null = null;
    let savedFinds: Find[] = [];
    let coach: string[] = [];
    let edits: { before: string; after: string }[] = [];

    if (initialState && (initialState.projects?.length || initialState.templates?.length)) {
      cats = initialState.categories || [];
      projs = initialState.projects || [];
      active = initialState.activeId || "";
      tpls = initialState.templates || [];
      act = initialState.activity || null;
      savedFinds = initialState.finds || [];
      coach = initialState.coaching || [];
      edits = initialState.editPairs || [];
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
    }
    setMyTemplates(tpls);
    if (act) setActivity({ ...ZERO_ACTIVITY, ...act });
    setFinds(Array.isArray(savedFinds) ? savedFinds : []);
    setCoaching(Array.isArray(coach) ? coach : []);
    setEditPairs(Array.isArray(edits) ? edits : []);

    if (!projs.length) {
      // First run under the projects model. Create one default project and adopt
      // any existing categories (which used a `useCase` field) into it.
      const def: Project = {
        id: `proj-${Date.now()}`,
        name: prof.name ? `${prof.name}` : "My outreach",
        useCase: prof.useCase,
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
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myTemplates, projects, categories, activeId, activity, finds, coaching, editPairs]);

  // Flip the hydrated flag AFTER the sync effect's first (skipped) run, so the
  // sync only fires on genuine post-load changes, never on the initial values.
  useEffect(() => {
    hydratedRef.current = true;
  }, []);

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
  // Record how the user rewrote a draft. Only keep it if the change is real
  // (not a trivial tweak) so we teach voice, not noise. Newest 6 retained.
  const recordEdit = (before: string, after: string) => {
    const a = String(after || "").trim();
    const b = String(before || "").trim();
    if (!a || a === b) return;
    // Skip near-identical edits (a couple of chars) to avoid teaching noise.
    if (Math.abs(a.length - b.length) < 8 && a.slice(0, 40) === b.slice(0, 40)) return;
    saveEditPairs([{ before: b, after: a }, ...editPairs].slice(0, 6));
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
  // Load aggregate community benchmarks (averages only, no individual data).
  const refreshCommunity = async () => {
    if (!getToken) return;
    const token = await getToken();
    if (!token) return;
    try {
      const r = await fetch("/api/community-stats", {
        headers: { authorization: `Bearer ${token}` },
      });
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
    refreshCommunity();
    // Handle the return from Google's consent screen.
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
        const u = new URL(window.location.href);
        u.searchParams.delete("gmail");
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
    try {
      const r = await fetch("/api/gmail/send", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          to: d.to,
          subject: d.subject,
          body: d.body,
          threadId: threadId || undefined,
        }),
      });
      const j = await r.json();
      if (r.ok) {
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
  function autofillIdentity(name?: string, useCase?: string) {
    if (name && name.trim()) {
      setProfile((prev) => {
        if (prev.name && prev.name.trim()) return prev; // don't overwrite theirs
        const next = { ...prev, name: name.trim() };
        onSaveProfile(next);
        return next;
      });
    }
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
  // may be editing a project that isn't the active one).
  function addCategoryToProject(projectId: string, name: string) {
    const nm = name.trim();
    if (!nm) return;
    const c: Category = {
      id: `cat-${Date.now()}`,
      name: nm,
      goal: "",
      projectId,
    };
    saveCats([...categories, c]);
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
    const existing = new Set(finds.map((f) => f.id));
    const fresh: Find[] = [];
    for (const o of newOpps) {
      const id = findKey(activeId, o);
      if (existing.has(id)) continue;
      existing.add(id);
      fresh.push({
        id,
        projectId: activeId,
        categoryId: catId || undefined,
        status: "new",
        opp: o,
        addedAt: Date.now(),
      });
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
  }
  // Save a hand-edited draft AND learn the before→after delta for future drafts.
  function editFindDraft(find: Find, subject: string, body: string) {
    const prevBody = find.draft?.body || "";
    recordEdit(prevBody, body);
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

  // Deep-scan a find's site for a specific contact + submission requirements.
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
      const j = await res.json();
      if (!res.ok) {
        setRepliesNote(j.error || "Couldn't scan that site.");
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
      const j = await res.json();
      if (!res.ok) {
        setRepliesNote(j.error || "Couldn't draft a follow-up.");
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
        }),
      });
      const data = await res.json();
      if (!res.ok) {
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
    // If this find already has a Gmail thread (e.g. a follow-up on an earlier
    // send), thread the new message into it instead of starting a new one.
    await sendViaGmail(find.draft, find.gmailThreadId);
  }

  // ---- Reply tracking: check tracked Gmail threads for responses ----
  const [repliesBusy, setRepliesBusy] = useState(false);
  const [repliesNote, setRepliesNote] = useState("");
  async function checkReplies() {
    if (!getToken) return;
    const token = await getToken();
    if (!token) return;
    const candidates = finds
      .filter(
        (f) => f.gmailThreadId && f.status !== "replied" && f.status !== "denied"
      )
      .slice(0, 20)
      .map((f) => ({ id: f.id, threadId: f.gmailThreadId }));
    if (!candidates.length) {
      setRepliesNote(
        "Nothing to check yet. Send a message through Gmail first and replies get tracked automatically."
      );
      return;
    }
    setRepliesBusy(true);
    setRepliesNote("");
    try {
      const r = await fetch("/api/gmail/replies", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ threads: candidates }),
      });
      const j = await r.json();
      if (r.ok) {
        const replied: string[] = j.replied || [];
        if (replied.length) {
          saveFinds(
            finds.map((f) =>
              replied.includes(f.id) ? { ...f, status: "replied" as FindStatus } : f
            )
          );
          setRepliesNote(
            `${replied.length} ${replied.length === 1 ? "reply" : "replies"} found and marked.`
          );
        } else {
          setRepliesNote(`No new replies yet (checked ${j.checked || candidates.length}).`);
        }
      } else {
        setRepliesNote(j.error || "Couldn't check for replies.");
      }
    } catch (e: any) {
      setRepliesNote(e?.message || "Couldn't check for replies.");
    } finally {
      setRepliesBusy(false);
    }
  }

  async function runDiscover() {
    if (!profileComplete) {
      setTab("profile");
      return;
    }
    resetResults();
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
      const res = await fetch("/api/discover", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ goal, about: aboutText, useCase: activeUseCase, feedback }),
      });
      const data = await res.json();
      if (!res.ok) {
        reportError(data);
        return;
      }
      setOpps(data.opportunities || []);
      setSelected({}); // nothing pre-approved — you approve who you want to reach
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
        }),
      });
      const data = await res.json();
      if (!res.ok) {
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
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setDrafting(false);
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
      <div className="flex min-w-0 flex-1 flex-col">

      {tab === "outreach" && (
          <main className="mx-auto w-full max-w-6xl px-6 pb-16 pt-8">
          <div className="mb-6">
            <h1 className="text-2xl font-extrabold tracking-tight text-ink">Outreach</h1>
            <p className="mt-1 text-sm text-body">
              Find the right people and draft messages in your voice.
            </p>
          </div>
            {/* ---------------- Request card (gated behind a completed profile) ---------------- */}
            {profileComplete ? (
            <section className="mt-6 rounded-3xl border border-warm-border bg-white p-6 shadow-soft sm:p-8">
              {/* -------- Project switcher: one workspace per artist / client / goal -------- */}
              <div className="mb-6 grid gap-6 border-b border-warm-border pb-6 sm:grid-cols-[230px_1fr]">
                <div>
                  <Label>Project</Label>
                  <div className="relative">
                    <div className="flex items-center gap-2">
                      <select
                        value={activeId}
                        onChange={(e) => selectProject(e.target.value)}
                        className="scout-select w-full flex-1 rounded-xl border border-warm-border bg-white px-3.5 py-3 text-sm font-semibold text-ink outline-none transition focus:border-coral focus:ring-4 focus:ring-coral/15"
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
                        addPlaceholder="New project (e.g. an artist)"
                        emptyText="No projects yet."
                      />
                    )}
                  </div>
                  <p className="mt-2.5 text-xs leading-relaxed text-body/70">
                    One workspace per artist, client, or goal, each with its own
                    categories and searches. Tap the pencil to add or remove projects.
                  </p>
                </div>

                <div>
                  <Label>Who this outreach is for (optional)</Label>
                  <textarea
                    value={activeProject?.context || ""}
                    onChange={(e) => setProjectContext(activeId, e.target.value)}
                    rows={2}
                    placeholder="e.g. Anna Belt — Nashville folk-rock singer-songwriter, new single out now, for fans of Stevie Nicks and Maggie Rogers."
                    className="w-full resize-y rounded-xl border border-warm-border px-3.5 py-3 text-sm leading-relaxed text-ink outline-none transition focus:border-coral focus:ring-4 focus:ring-coral/15"
                  />
                  <p className="mt-1.5 text-xs text-body/70">
                    Scout weaves this into every message for this project, so pitches
                    sound like they're really about {activeProject?.name || "them"}.
                  </p>
                </div>
              </div>

              <div className="grid gap-6 sm:grid-cols-[230px_1fr]">
                <div>
                  <Label>Category of search</Label>
                  <div className="relative">
                    <div className="flex items-center gap-2">
                      <select
                        value={catId}
                        onChange={(e) => selectCategory(e.target.value)}
                        className="scout-select w-full flex-1 rounded-xl border border-warm-border bg-white px-3.5 py-3 text-sm font-semibold text-ink outline-none transition focus:border-coral focus:ring-4 focus:ring-coral/15"
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
                  <Label>Who are you looking for?</Label>
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
              </div>
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
                <div className="relative max-w-md rounded-2xl rounded-tl-sm border border-warm-border bg-white px-4 py-3 shadow-card">
                  <Tail side="left" />
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-semibold text-ink">
                      Scout is searching
                    </span>
                    <span className="ml-1 flex gap-1">
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-coral" />
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-blush [animation-delay:150ms]" />
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-coral [animation-delay:300ms]" />
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-body">
                    Reading the web and finding real contacts. About 30 to 60 seconds.
                  </p>
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
                    body="Warm, personal drafts for each channel, matched to your templates. Review, tweak, send."
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
                  <div className="relative w-full rounded-3xl rounded-tl-md border border-warm-border bg-white shadow-soft">
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
                        className="relative ml-auto max-w-3xl rounded-3xl rounded-tr-md border border-warm-border bg-white p-5 shadow-card"
                      >
                        <Tail side="right" />
                        <div className="mb-3 flex flex-wrap items-center gap-2">
                          <span className="font-semibold text-ink">
                            {opp?.name || "Draft"}
                          </span>
                          <span className="rounded-full bg-brand-gradient px-2.5 py-0.5 text-xs font-semibold text-white">
                            {d.channelType}
                          </span>
                          {d.to && (
                            <span className="text-xs text-body/70">
                              → <ContactValue value={d.to} className="text-body/70" />
                            </span>
                          )}
                          <div className="ml-auto flex items-center gap-2">
                            {gmail.connected &&
                            d.channelType === "email" &&
                            mailHref(d.to) ? (
                              gmailSent[d.opportunityId] ? (
                                <span className="rounded-lg bg-warm-bg px-3 py-1 text-xs font-bold text-accent">
                                  {gmailSent[d.opportunityId] === "send"
                                    ? "Sent ✓"
                                    : "In your Gmail drafts ✓"}
                                </span>
                              ) : (
                                <button
                                  onClick={() => sendViaGmail(d)}
                                  disabled={gmailBusyId === d.opportunityId}
                                  className="rounded-lg bg-brand-gradient px-3 py-1 text-xs font-bold text-white shadow-card transition hover:opacity-95 disabled:opacity-50"
                                >
                                  {gmailBusyId === d.opportunityId
                                    ? "Working…"
                                    : gmail.sendMode === "send"
                                    ? "Send from Gmail"
                                    : "Create Gmail draft"}
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
          filter={findFilter}
          setFilter={setFindFilter}
          gmail={gmail}
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
          onCopy={() => bumpActivity({ copies: 1 })}
          onEditDraft={editFindDraft}
          onDeepScan={deepScanFind}
          scanningId={scanningId}
          onFollowUp={followUpFind}
          followUpId={followUpId}
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
          onApplyTip={addCoaching}
          onRemoveTip={removeCoaching}
          goOutreach={() => setTab("outreach")}
          goTemplates={() => setTab("templates")}
          goProfile={() => setTab("profile")}
          goFinds={() => setTab("finds")}
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
          onName={(v) => patchProfile({ name: v })}
          onBio={(v) => patchProfile({ bio: v })}
          onLinkedin={(v) => patchProfile({ linkedin: v })}
          onUseCase={changeUseCase}
          onAutofill={autofillIdentity}
          canConfirm={profileComplete}
          onConfirm={() => setTab("outreach")}
          gmailAvailable={!!getToken}
          gmail={gmail}
          gmailNote={gmailNote}
          onConnectGmail={connectGmail}
          onDisconnectGmail={disconnectGmail}
          onGmailMode={setGmailMode}
          projects={projects}
          categories={categories}
          onAddProject={addProject}
          onRenameProject={renameProject}
          onRemoveProject={removeProject}
          onAddCategory={addCategoryToProject}
          onRenameCategory={renameCategory}
          onRemoveCategory={removeCategory}
        />
      )}

      {tab === "account" && accountEmail && (
        <main className="mx-auto max-w-3xl px-6 py-12">
          <h1 className="text-3xl font-extrabold tracking-tight text-ink">
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
        </main>
      )}

      {/* ---------------- Footer ---------------- */}
      <footer className="border-t border-warm-border bg-white/70">
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
            className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-3xl border border-warm-border bg-white shadow-soft"
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
            key: "account",
            label: "Account",
            icon: (
              <>
                <circle cx="12" cy="8" r="3.5" />
                <path d="M5 20a7 7 0 0 1 14 0" />
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
                    active ? "bg-white" : "bg-brown"
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
            className="scout-select w-full rounded-xl border border-warm-border bg-white px-3 py-2.5 text-xs font-bold text-ink outline-none transition focus:border-brown"
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        {showLogout && (
          <button
            onClick={onLogout}
            className="mt-3 w-full rounded-xl border border-warm-border px-3 py-2 text-xs font-semibold text-body transition hover:bg-brown-tint"
          >
            Log out
          </button>
        )}
      </div>
    </aside>
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
    <div className={`grid gap-3 ${roomy ? "lg:grid-cols-2" : "grid-cols-1"}`}>
      {opps.map((o) => {
        const on = !!selected[o.id];
        return (
          <div
            key={o.id}
            className={`flex flex-col gap-3 rounded-2xl border p-3.5 transition ${
              on
                ? "border-coral/40 bg-warm-bg/60"
                : "border-warm-border bg-white"
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
                {on ? "Approved ✓" : "Approve"}
              </button>
              {denyingId === o.id ? (
                <div className="flex flex-wrap items-center gap-1.5">
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
              : "border-warm-border bg-white text-body hover:bg-warm-bg"
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
          className="rounded-full border border-warm-border bg-white px-2.5 py-1 text-[11px] font-semibold text-body/70 transition hover:bg-warm-bg"
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
  onCopy,
  onEditDraft,
  onDeepScan,
  scanningId,
  onFollowUp,
  followUpId,
  onCheckReplies,
  repliesBusy,
  repliesNote,
  goOutreach,
}: {
  finds: Find[];
  projectName: string;
  filter: FindStatus | "all";
  setFilter: (f: FindStatus | "all") => void;
  gmail: { connected: boolean; email?: string; sendMode?: "draft" | "send" };
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
  onCopy: () => void;
  onEditDraft: (f: Find, subject: string, body: string) => void;
  onDeepScan: (f: Find) => void;
  scanningId: string;
  onFollowUp: (f: Find) => void;
  followUpId: string;
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
    (f) => f.gmailThreadId && f.status !== "replied" && f.status !== "denied"
  );
  const shown = (filter === "all" ? finds : finds.filter((f) => f.status === filter))
    .slice()
    .sort((a, b) => (b.opp.fitScore || 0) - (a.opp.fitScore || 0));

  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight text-ink">
            Your <span className="brand-text">finds</span>
          </h1>
          <p className="mt-2 text-[15px] leading-relaxed text-body">
            Everyone Scout has found for{" "}
            <span className="font-semibold text-ink">{projectName}</span>. Draft a
            message, mark who you&apos;ve contacted, or set aside the ones that
            aren&apos;t a fit.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {gmail.connected && trackable && (
            <button
              onClick={onCheckReplies}
              disabled={repliesBusy}
              className="rounded-xl border border-warm-border bg-white px-4 py-2.5 text-sm font-semibold text-body transition hover:bg-warm-bg disabled:opacity-50"
            >
              {repliesBusy ? "Checking…" : "Check for replies"}
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
                  : "border-warm-border bg-white text-body hover:bg-warm-bg"
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
        <div className="mt-6 rounded-2xl border border-dashed border-warm-border bg-white/60 p-12 text-center text-sm text-body/70">
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
              onCopy={onCopy}
              onEditDraft={(subject, body) => onEditDraft(f, subject, body)}
              onDeepScan={() => onDeepScan(f)}
              scanning={scanningId === f.id}
              onFollowUp={() => onFollowUp(f)}
              followUpBusy={followUpId === f.id}
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
    denied: "border-warm-border bg-white text-body/50",
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
  onCopy,
  onEditDraft,
  onDeepScan,
  scanning,
  onFollowUp,
  followUpBusy,
}: {
  find: Find;
  gmail: { connected: boolean; email?: string; sendMode?: "draft" | "send" };
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
  onCopy: () => void;
  onEditDraft: (subject: string, body: string) => void;
  onDeepScan: () => void;
  scanning: boolean;
  onFollowUp: () => void;
  followUpBusy: boolean;
}) {
  const o = find.opp;
  const d = find.draft;
  const denied = find.status === "denied";
  // Contacted (or beyond): hide the send/mark actions.
  const done = find.status === "sent" || find.status === "replied";
  const emailDraft = d && d.channelType === "email" && !!mailHref(d.to);
  const [denying, setDenying] = useState(false); // reason picker shown pre-deny
  const [editing, setEditing] = useState(false); // draft edit mode
  const [editSubject, setEditSubject] = useState("");
  const [editBody, setEditBody] = useState("");
  // How long since the outreach went out, for the follow-up nudge.
  const sentAgoDays = find.sentAt ? (Date.now() - find.sentAt) / 86400000 : 0;
  const followUpReady =
    find.status === "sent" && sentAgoDays >= 7 && !find.lastFollowUpAt;

  return (
    <div
      className={`rounded-2xl border p-4 shadow-card transition ${
        denied ? "border-warm-border bg-white/60 opacity-70" : "border-warm-border bg-white"
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

      {/* What this target asks for (pasted or found by deep-scan) */}
      {find.requirements && (
        <div className="mt-2 rounded-xl border border-sage/40 bg-sage/10 p-2.5 text-xs leading-relaxed text-brown-deep">
          <span className="font-bold">What they ask for: </span>
          {find.requirements}
        </div>
      )}

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
        <div className="mt-3 rounded-xl border border-coral/40 bg-white p-3">
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
              <button
                onClick={onSendGmail}
                disabled={gmailBusy}
                className="rounded-lg bg-brand-gradient px-3 py-1.5 text-xs font-bold text-white shadow-card transition hover:opacity-95 disabled:opacity-50"
              >
                {gmailBusy
                  ? "Working…"
                  : gmail.sendMode === "send"
                  ? "Send from Gmail"
                  : "Create Gmail draft"}
              </button>
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

        {!done && (
          <button
            onClick={onMarkSent}
            className="rounded-lg border border-warm-border px-3 py-1.5 text-xs font-semibold text-body transition hover:bg-warm-bg"
          >
            Mark contacted
          </button>
        )}

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

      {/* Deny reason on passed finds — editable */}
      {denied && (
        <div className="mt-2.5 border-t border-warm-border pt-2.5">
          <div className="mb-1.5 text-[11px] font-semibold text-body/60">
            {find.denyReason ? "Reason you passed" : "Add a reason (optional)"}
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

/* ---------------- Dashboard tab ---------------- */
function DashboardTab({
  activity,
  profile,
  templates,
  projects,
  categoriesCount,
  finds,
  community,
  coaching,
  onApplyTip,
  onRemoveTip,
  goOutreach,
  goTemplates,
  goProfile,
  goFinds,
}: {
  activity: Activity;
  profile: Profile;
  templates: OutreachTemplate[];
  projects: Project[];
  categoriesCount: number;
  finds: Find[];
  community: CommunityStats | null;
  coaching: string[];
  onApplyTip: (tip: string) => void;
  onRemoveTip: (tip: string) => void;
  goOutreach: () => void;
  goTemplates: () => void;
  goProfile: () => void;
  goFinds: () => void;
}) {
  const learned = learnedFromFinds(finds);
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
  const pipeMax = Math.max(
    1,
    pipe.new,
    pipe.drafted,
    pipe.sent,
    pipe.replied,
    pipe.denied
  );
  const channels = new Set(templates.map((t) => t.channel)).size;
  const projectsWithContext = projects.filter((p) => (p.context || "").trim()).length;
  // Honest, clearly-labeled estimate: ~6 min to find + write one personal message.
  const minutesSaved = activity.drafts * 6;
  const timeSaved =
    minutesSaved >= 60
      ? `${(minutesSaved / 60).toFixed(1)} hrs`
      : `${minutesSaved} min`;

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
      <h1 className="text-2xl font-extrabold tracking-tight text-ink">Dashboard</h1>
      <p className="mt-1 text-sm text-body">
        How your outreach is going, and how Scout is getting sharper for you.
      </p>

      {/* -------- Follow-up reminder -------- */}
      {dueFollowUps > 0 && (
        <button
          onClick={goFinds}
          className="mt-5 flex w-full items-center gap-3 rounded-2xl border border-sage/50 bg-sage/10 p-4 text-left transition hover:bg-sage/15"
        >
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-sage/20 text-base">
            🔔
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

      {/* -------- Activity (real counts) -------- */}
      <section className="mt-7 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatTile
          n={activity.searches}
          label="Searches run"
          icon={<><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></>}
        />
        <StatTile
          n={activity.found}
          label="People found"
          icon={<><circle cx="9" cy="8" r="3.5" /><path d="M3 20a6 6 0 0 1 12 0M16 6a3.5 3.5 0 0 1 0 7M21 20a6 6 0 0 0-4-5.6" /></>}
        />
        <StatTile
          n={activity.drafts}
          label="Drafts written"
          icon={<><path d="M4 4h16v12H8l-4 4z" /><path d="M8 9h8M8 12h5" /></>}
        />
        <StatTile
          n={activity.copies}
          label="Taken to send"
          icon={<path d="M22 3 11 14M22 3l-7 18-4-8-8-4 19-6z" />}
        />
      </section>

      {/* -------- Taste learning + pipeline -------- */}
      <section className="mt-4 grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <div className="rounded-3xl border border-warm-border bg-surface p-6 shadow-card">
          <h2 className="text-sm font-extrabold text-ink">
            What Scout is learning about your taste
          </h2>
          <p className="mt-0.5 text-xs text-muted">
            Built from the finds you keep and pass on, all your own data.
          </p>
          {learned.decided === 0 ? (
            <p className="mt-6 text-sm leading-relaxed text-body/70">
              Nothing learned yet. As you draft messages and set aside finds that
              aren&apos;t a fit, your deny rate and preferences show up here.
            </p>
          ) : (
            <>
              <div className="mt-4 flex items-end gap-3">
                <span className="text-4xl font-extrabold tracking-tight text-ink">
                  {Math.round(learned.denyRate * 100)}%
                </span>
                <div className="pb-1">
                  <div className="text-xs font-bold uppercase tracking-wider text-muted">
                    Deny rate
                  </div>
                  {learned.trend && Math.abs(learned.trend.delta) >= 0.01 && (
                    <div
                      className={`text-xs font-bold ${
                        learned.trend.delta < 0 ? "text-sage" : "text-muted"
                      }`}
                    >
                      {learned.trend.delta < 0 ? "▼ down" : "▲ up"} from{" "}
                      {Math.round(learned.trend.early * 100)}%
                    </div>
                  )}
                </div>
              </div>
              <p className="mt-3 text-xs leading-relaxed text-body/70">
                {learned.trend
                  ? learned.trend.delta < -0.01
                    ? "Fewer of Scout's finds are misses now than when you started, it's getting your taste."
                    : learned.trend.delta > 0.01
                    ? "Recent finds are landing less often. Adjusting your goal wording or project context can sharpen them."
                    : "Holding steady as Scout learns what fits."
                  : `You've set aside ${learned.denied} of ${learned.decided} you reviewed. A trend appears once you've reviewed a few more.`}
              </p>
            </>
          )}
          <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-warm-border pt-4">
            <div className="text-xs text-body/70">
              ~{timeSaved} <span className="text-muted">saved (est.)</span>, about 6 min
              per message.
            </div>
            <button
              onClick={goOutreach}
              className="ml-auto rounded-xl bg-brand-gradient px-4 py-2 text-xs font-bold text-white shadow-soft transition hover:opacity-95"
            >
              Find more opportunities
            </button>
          </div>
        </div>

        <div className="rounded-3xl border border-warm-border bg-surface p-6 shadow-card">
          <h2 className="text-sm font-extrabold text-ink">Your pipeline</h2>
          <p className="mt-0.5 text-xs text-muted">Finds across every project</p>
          <div className="mt-4 grid gap-3">
            {(
              [
                { label: "New", n: pipe.new, color: "bg-brown-tint" },
                { label: "Drafted", n: pipe.drafted, color: "bg-brown" },
                { label: "Sent", n: pipe.sent, color: "bg-brown-deep" },
                { label: "Replied", n: pipe.replied, color: "bg-sage" },
                { label: "Denied", n: pipe.denied, color: "bg-danger" },
              ] as const
            ).map((r) => (
              <div key={r.label} className="flex items-center gap-3 text-sm">
                <span className="w-16 text-xs font-semibold text-body">{r.label}</span>
                <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-brown-tint">
                  <span
                    className={`block h-full rounded-full ${r.color}`}
                    style={{ width: `${Math.round((r.n / pipeMax) * 100)}%` }}
                  />
                </span>
                <span className="w-6 text-right text-xs font-extrabold text-ink">
                  {r.n}
                </span>
              </div>
            ))}
          </div>
          <div className="mt-4 border-t border-warm-border pt-3 text-xs text-body/70">
            <b className="text-ink">
              {pipe.new} {pipe.new === 1 ? "person" : "people"}
            </b>{" "}
            waiting for you in Finds.
          </div>
        </div>
      </section>

      {activity.searches === 0 && (
        <p className="mt-3 text-xs text-muted">
          Numbers fill in as you use Scout. Run a search on the Outreach tab to get
          started.
        </p>
      )}

      {/* -------- Fit + preferences (only once there's data to show) -------- */}
      {learned.decided > 0 && (
        <section className="mt-10">
          <h2 className="text-lg font-bold text-ink">Your fit and preferences</h2>
          <p className="mt-1 text-sm text-body/80">
            The fit level and channels you gravitate toward, learned from the finds
            you keep and pass on.
          </p>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {/* Fit sweet spot */}
            <div className="rounded-2xl border border-warm-border bg-white p-5 shadow-card">
              <div className="text-xs font-bold uppercase tracking-wider text-body/60">
                Your fit sweet spot
              </div>
              {learned.keptFit != null ? (
                <>
                  <div className="mt-1 text-3xl font-extrabold tracking-tight text-ink">
                    {Math.round(learned.keptFit * 100)}%
                  </div>
                  <p className="mt-1.5 text-xs leading-relaxed text-body/70">
                    Average fit of the people you reach out to
                    {learned.deniedFit != null && (
                      <>
                        {" "}
                        vs {Math.round(learned.deniedFit * 100)}% for the ones you pass.
                        Scout leans toward your range.
                      </>
                    )}
                  </p>
                </>
              ) : (
                <p className="mt-2 text-xs text-body/70">
                  Draft a few finds and this shows the fit level you gravitate toward.
                </p>
              )}
            </div>

            {/* Reply rate (from tracked Gmail threads + manually logged replies) */}
            {learned.replyRate != null && (
              <div className="rounded-2xl border border-warm-border bg-white p-5 shadow-card sm:col-span-2">
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
            <div className="rounded-2xl border border-warm-border bg-white p-5 shadow-card sm:col-span-2">
              <div className="text-xs font-bold uppercase tracking-wider text-body/60">
                Your preferences so far
              </div>
              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                <div>
                  <div className="text-xs font-semibold text-sage">You reach out to</div>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {learned.keptChannels.length ? (
                      learned.keptChannels.slice(0, 4).map(([c, n]) => (
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
                    {learned.deniedChannels.length ? (
                      learned.deniedChannels.slice(0, 4).map(([c, n]) => (
                        <span
                          key={c}
                          className="rounded-full border border-warm-border bg-white px-2.5 py-1 text-xs font-medium text-body/70"
                        >
                          {c} · {n}
                        </span>
                      ))
                    ) : (
                      <span className="text-xs text-body/50">nothing yet</span>
                    )}
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
                        className="rounded-full border border-warm-border bg-white px-2.5 py-1 text-xs font-medium text-body/70"
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
          <h2 className="text-lg font-bold text-ink">Your projects</h2>
          <button
            onClick={goOutreach}
            className="text-xs font-bold text-accent transition hover:underline"
          >
            Go to Outreach →
          </button>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {projects.length === 0 ? (
            <p className="text-sm text-muted">No projects yet.</p>
          ) : (
            projects.slice(0, 6).map((p) => {
              const mine = finds.filter((f) => f.projectId === p.id);
              const nw = mine.filter((f) => f.status === "new").length;
              const sent = mine.filter((f) => f.status === "sent").length;
              return (
                <div
                  key={p.id}
                  className="flex items-center gap-3 rounded-2xl border border-warm-border bg-white p-4 shadow-card"
                >
                  <span className="h-10 w-10 shrink-0 rounded-xl bg-brand-gradient" />
                  <div className="min-w-0">
                    <div className="truncate text-sm font-bold text-ink">{p.name}</div>
                    <div className="truncate text-xs text-muted">
                      {p.useCase} · {nw} new · {sent} sent
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </section>

      {/* -------- You vs the community (real aggregate averages) -------- */}
      <section className="mt-10">
        <h2 className="text-lg font-bold text-ink">You vs the community</h2>
        <p className="mt-1 text-sm text-body/80">
          How you compare to everyone else using Scout. Aggregate averages only,
          never anyone&apos;s private data.
        </p>
        {!community || community.users < 1 ? (
          <div className="mt-4 rounded-2xl border border-dashed border-warm-border bg-white/60 p-8 text-center text-sm text-body/70">
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
                label="Fit sweet spot"
                you={learned.keptFit}
                them={community.avgFitKept}
                fmt="pct"
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
              {community.users === 1 ? "person" : "people"} using Scout. Small samples
              are noisy, this sharpens as the community grows.
            </p>
          </>
        )}
      </section>

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
        coaching={coaching}
        onApplyTip={onApplyTip}
        goOutreach={goOutreach}
        goTemplates={goTemplates}
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
              className="flex items-start gap-3 rounded-2xl border border-warm-border bg-white p-4 shadow-card"
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

      {/* -------- How Scout learns from EVERYONE -------- */}
      <section className="mt-10">
        <h2 className="text-lg font-bold text-ink">How Scout gets better for everyone</h2>
        <div className="mt-4 rounded-3xl border border-warm-border bg-white p-6 shadow-card">
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

      {/* -------- Honesty note about reply tracking -------- */}
      <section className="mt-8 rounded-2xl border border-dashed border-warm-border bg-white/60 px-5 py-4">
        <div className="text-xs font-bold uppercase tracking-wider text-body/60">
          Coming soon
        </div>
        <p className="mt-1.5 text-sm leading-relaxed text-body">
          Right now Scout drafts messages and you send them from your own email or DMs,
          so opens and replies aren&apos;t tracked automatically yet. When you connect
          sending, this dashboard will show real response and reply rates, not
          estimates.
        </p>
      </section>

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
          className="ml-auto rounded-xl bg-white px-5 py-2.5 text-sm font-extrabold text-brown-deep transition hover:opacity-95"
        >
          Start scouting →
        </button>
      </section>
    </main>
  );
}

/* ---------------- Outreach advice: community patterns + proven playbook ---------------- */
function OutreachAdvice({
  community,
  finds,
  coaching,
  onApplyTip,
  goOutreach,
  goTemplates,
}: {
  community: CommunityStats | null;
  finds: Find[];
  coaching: string[];
  onApplyTip: (tip: string) => void;
  goOutreach: () => void;
  goTemplates: () => void;
}) {
  const p = community?.patterns;
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const isApplied = (s: string) =>
    coaching.some((c) => c.trim().toLowerCase() === s.trim().toLowerCase());
  // A small "turn this into a standing rule" control shown on each coachable tip.
  const ApplyTip = ({ tip }: { tip: string }) =>
    isApplied(tip) ? (
      <span className="shrink-0 rounded-lg bg-sage/15 px-2.5 py-1 text-[11px] font-semibold text-sage">
        Applied ✓
      </span>
    ) : (
      <button
        onClick={() => onApplyTip(tip)}
        className="shrink-0 rounded-lg border border-sage/50 px-2.5 py-1 text-[11px] font-semibold text-sage transition hover:bg-sage/10"
        title="Scout will follow this in every draft it writes for you"
      >
        Apply to my drafts
      </button>
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
          <p className="mt-2 rounded-2xl border border-dashed border-warm-border bg-white/60 px-4 py-3 text-xs leading-relaxed text-body/70">
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
                Scout reads your recent messages and coaches you on them. Uses a small
                amount of API credit.
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
                      className="rounded-2xl border border-coral/30 bg-white p-4 shadow-card"
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
        {insights.length ? (
          <div className="mt-2.5 grid gap-3 sm:grid-cols-2">
            {insights.map((tip) => (
              <div
                key={tip.title}
                className="rounded-2xl border border-coral/30 bg-warm-bg/40 p-4 shadow-card"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="text-sm font-bold text-ink">{tip.title}</div>
                  <ApplyTip tip={tip.body} />
                </div>
                <p className="mt-1 text-xs leading-relaxed text-body">{tip.body}</p>
                <div className="mt-2 text-[10px] font-semibold uppercase tracking-wide text-body/50">
                  Based on {tip.basis}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-2 rounded-2xl border border-dashed border-warm-border bg-white/60 px-4 py-3 text-xs leading-relaxed text-body/70">
            Live patterns show up here once the community has made enough decisions —
            real numbers only, so nothing appears until the data can back it up.
          </p>
        )}
      </div>

      {/* Proven playbook */}
      <div className="mt-5">
        <div className="text-xs font-bold uppercase tracking-wider text-body/60">
          The proven playbook
        </div>
        <div className="mt-2.5 grid gap-3 sm:grid-cols-2">
          {playbook.map((tip) => (
            <div
              key={tip.title}
              className="rounded-2xl border border-warm-border bg-white p-4 shadow-card"
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
    <div className="rounded-2xl border border-warm-border bg-white p-4 shadow-card">
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
      <div className="text-3xl font-extrabold tracking-tight text-ink">{n}</div>
      <div className="mt-1 text-xs font-semibold text-body">{label}</div>
    </div>
  );
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
      setNote(`Shared "${p.name}" with your team${seed.length ? ` (${seed.length} finds)` : ""}.`);
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
      <h1 className="text-3xl font-extrabold tracking-tight text-ink">
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
        <section className="mt-6 space-y-2">
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
        </section>
      )}

      {loading ? (
        <p className="mt-8 text-sm text-body/60">Loading your team…</p>
      ) : !workspace ? (
        /* -------- No workspace yet: create one -------- */
        <section className="mt-7 rounded-3xl border border-warm-border bg-white p-6 shadow-soft">
          <h2 className="text-lg font-bold text-ink">Create your workspace</h2>
          <p className="mt-1 text-sm text-body/80">
            A workspace is your company or crew. Invite teammates into it, then share
            projects with them.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <input
              value={wsName}
              onChange={(e) => setWsName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && wsName.trim()) createWorkspace();
              }}
              placeholder="e.g. Cue Creative"
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
        </section>
      ) : (
        <>
          {/* -------- Workspace: members + invite -------- */}
          <section className="mt-7 rounded-3xl border border-warm-border bg-white p-6 shadow-soft">
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
              <p className="mt-2 rounded-2xl border border-dashed border-warm-border bg-white/60 px-4 py-3 text-sm text-body/70">
                Nothing shared yet. Share one of your projects below and its finds become
                a shared pipeline your team works from together.
              </p>
            ) : (
              <div className="mt-3 space-y-2">
                {sharedProjects.map((p) => (
                  <div
                    key={p.id}
                    className="rounded-2xl border border-warm-border bg-white p-4 shadow-card"
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
                  className="scout-select min-w-[180px] rounded-xl border border-warm-border bg-white px-3 py-2 text-sm font-semibold text-ink outline-none focus:border-coral"
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
    <div className="rounded-xl border border-warm-border bg-white p-3">
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
      <h1 className="text-3xl font-extrabold tracking-tight text-ink">
        Your <span className="brand-text">templates</span>
      </h1>
      <p className="mt-2 text-[15px] leading-relaxed text-body">
        Set up how each kind of message should sound, an email, a LinkedIn note, an
        Instagram DM. When Scout drafts outreach, it uses the right format and
        your voice for each channel. Keep a template global, or assign it to a
        specific project or category so each artist gets their own voice.
      </p>

      <section className="mt-7 rounded-3xl border border-warm-border bg-white p-6 shadow-soft sm:p-8">
        <div className="grid gap-5 sm:grid-cols-[210px_1fr]">
          <div>
            <Label>Kind of outreach</Label>
            <select
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
              className="scout-select w-full rounded-xl border border-warm-border bg-white px-3.5 py-3 text-sm font-semibold text-ink outline-none transition focus:border-coral focus:ring-4 focus:ring-coral/15"
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
            <Label>Show us how you write it</Label>
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
              className="scout-select w-full rounded-xl border border-warm-border bg-white px-3.5 py-3 text-sm font-semibold text-ink outline-none transition focus:border-coral focus:ring-4 focus:ring-coral/15"
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
              className="scout-select w-full rounded-xl border border-warm-border bg-white px-3.5 py-3 text-sm font-semibold text-ink outline-none transition focus:border-coral focus:ring-4 focus:ring-coral/15 disabled:opacity-50"
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
          <p className="mt-2 text-xs leading-relaxed text-body/80">
            Scope this voice to one project (say, a specific artist) or a single
            category within it. Leave it on <span className="font-semibold">All projects</span> to
            use it everywhere.
          </p>
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
          Your templates ({list.length})
        </h2>
        {list.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-warm-border bg-white/60 p-10 text-center text-sm text-body/70">
            No templates yet. Add one for email, a LinkedIn message, or an Instagram
            DM, and every draft will match that style.
          </div>
        ) : (
          <div className="space-y-3">
            {list.map((s) => (
              <div
                key={s.id}
                className="rounded-2xl border border-warm-border bg-white p-5 shadow-card"
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
        className="w-full rounded-xl border border-warm-border bg-white px-3.5 py-3 text-sm font-semibold text-ink outline-none transition focus:border-coral focus:ring-4 focus:ring-coral/15"
      />
      {open && matches.length > 0 && (
        <div className="absolute z-30 mt-1.5 max-h-64 w-full overflow-auto rounded-xl border border-warm-border bg-white py-1 shadow-soft">
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
function GmailCard({
  gmail,
  note,
  onConnect,
  onDisconnect,
  onMode,
}: {
  gmail: { connected: boolean; email?: string; sendMode?: "draft" | "send" };
  note: string;
  onConnect: () => void;
  onDisconnect: () => void;
  onMode: (mode: "draft" | "send") => void;
}) {
  const mode = gmail.sendMode || "draft";
  return (
    <section className="mt-7 rounded-3xl border border-warm-border bg-white p-6 shadow-soft sm:p-8">
      <div className="flex flex-wrap items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-warm-bg">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="text-accent">
            <rect x="3" y="5" width="18" height="14" rx="2" />
            <path d="m3 7 9 6 9-6" />
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-bold text-ink">Send from your email</div>
          {gmail.connected ? (
            <p className="mt-0.5 text-sm text-body">
              Connected as{" "}
              <span className="font-semibold text-ink">{gmail.email || "your Gmail"}</span>
              . Your messages go out from your own address.
            </p>
          ) : (
            <p className="mt-0.5 text-sm leading-relaxed text-body">
              Connect Gmail so Scout can put a ready-to-go draft in your inbox, or send
              it for you, straight from your own address.
            </p>
          )}
        </div>
        {gmail.connected ? (
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
            Connect Gmail
          </button>
        )}
      </div>

      {gmail.connected && (
        <div className="mt-5 border-t border-warm-border pt-5">
          <Label>When you use a draft</Label>
          <div className="mt-1 grid gap-2.5 sm:grid-cols-2">
            {(
              [
                {
                  key: "draft",
                  title: "Create a draft I review",
                  body: "Scout puts the message in your Gmail drafts. You open it and hit send.",
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
                      : "border-warm-border bg-white hover:bg-warm-bg/30"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`flex h-4 w-4 items-center justify-center rounded-full border ${
                        on ? "border-coral bg-coral" : "border-warm-border"
                      }`}
                    >
                      {on && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
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
  onName,
  onBio,
  onLinkedin,
  onUseCase,
  onAutofill,
  canConfirm,
  onConfirm,
  gmailAvailable,
  gmail,
  gmailNote,
  onConnectGmail,
  onDisconnectGmail,
  onGmailMode,
  projects,
  categories,
  onAddProject,
  onRenameProject,
  onRemoveProject,
  onAddCategory,
  onRenameCategory,
  onRemoveCategory,
}: {
  name: string;
  bio: string;
  linkedin: string;
  useCase: string;
  onName: (v: string) => void;
  onBio: (v: string) => void;
  onLinkedin: (v: string) => void;
  onUseCase: (v: string) => void;
  onAutofill: (name?: string, useCase?: string) => void;
  canConfirm: boolean;
  onConfirm: () => void;
  gmailAvailable: boolean;
  gmail: { connected: boolean; email?: string; sendMode?: "draft" | "send" };
  gmailNote: string;
  onConnectGmail: () => void;
  onDisconnectGmail: () => void;
  onGmailMode: (mode: "draft" | "send") => void;
  projects: Project[];
  categories: Category[];
  onAddProject: (name: string) => void;
  onRenameProject: (id: string, name: string) => void;
  onRemoveProject: (id: string) => void;
  onAddCategory: (projectId: string, name: string) => void;
  onRenameCategory: (id: string, name: string) => void;
  onRemoveCategory: (id: string) => void;
}) {
  const [parsing, setParsing] = useState(false);
  const [autofilled, setAutofilled] = useState(false);
  const [note, setNote] = useState("");
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
      if (res.ok && (data.name || data.useCase)) {
        onAutofill(data.name, data.useCase);
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
      <h1 className="text-3xl font-extrabold tracking-tight text-ink">
        Your <span className="brand-text">profile</span>
      </h1>
      <p className="mt-2 text-[15px] leading-relaxed text-body">
        Drop in your resume, LinkedIn, or company website and Scout fills the rest
        for you. Everything stays editable, and it shapes who we find and how your
        messages sound.
      </p>

      {gmailAvailable && (
        <GmailCard
          gmail={gmail}
          note={gmailNote}
          onConnect={onConnectGmail}
          onDisconnect={onDisconnectGmail}
          onMode={onGmailMode}
        />
      )}

      <section className="mt-7 rounded-3xl border border-warm-border bg-white p-6 shadow-soft sm:p-8">
        {/* -------- Individual vs company: resume drop or website -------- */}
        <div className="mb-4 inline-flex rounded-xl border border-warm-border bg-warm-bg/40 p-1">
          {(["individual", "company"] as const).map((k) => (
            <button
              key={k}
              onClick={() => chooseKind(k)}
              className={`rounded-lg px-3.5 py-1.5 text-xs font-semibold transition ${
                kind === k
                  ? "bg-white text-ink shadow-card"
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
                ? "Reading and filling in your profile…"
                : "Drop your resume or LinkedIn PDF here, or click to upload"
            }
            onText={(t) => readAndFill(t)}
          />
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
            Reading your resume and filling in your profile…
          </div>
        )}
        {note && !parsing && (
          <div
            className={`mt-3 rounded-xl px-4 py-2.5 text-xs font-medium ${
              autofilled
                ? "border border-warm-border bg-warm-bg/70 text-ink"
                : "border border-warm-border bg-white text-body"
            }`}
          >
            {note}
          </div>
        )}

        <hr className="my-7 border-warm-border" />

        <Label>What are you using Scout for?</Label>
        <UseCaseCombo value={useCase} onChange={onUseCase} />
        <p className="mt-2 text-xs leading-relaxed text-body/70">
          Type anything, a job hunt, finding a band member, press for a product, investors.
          Pick a suggestion if one fits, or just describe it in your own words and Scout
          will figure out who to look for.
        </p>
        <div className="mt-3 rounded-xl bg-warm-bg/70 px-4 py-3">
          <div className="text-[11px] font-bold uppercase tracking-wider text-body/60">
            Suggested categories
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {suggestionsFor(useCase).map((s) => (
              <span
                key={s.name}
                className="rounded-full border border-warm-border bg-white px-3 py-1 text-xs font-medium text-ink"
              >
                {s.name}
              </span>
            ))}
          </div>
          <p className="mt-2.5 text-xs text-body/70">
            These appear on the Outreach tab. You can add or remove any of them there.
          </p>
        </div>

        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <div>
            <Label>Your name or company</Label>
            <input
              value={name}
              onChange={(e) => onName(e.target.value)}
              placeholder="e.g. Kaitlyn Kasel, or Belt Creative"
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
              Saved to your profile and used to personalize outreach. To fill your
              profile <span className="font-semibold">from</span> LinkedIn, upload your
              LinkedIn PDF above or paste your About section below.
            </p>
          </div>
        </div>

        <div className="mt-5">
          <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
            <Label className="mb-0">Resume, LinkedIn, or bio</Label>
            <button
              onClick={() => readAndFill(bio, false)}
              disabled={!bio.trim() || parsing}
              className="rounded-lg border border-warm-border px-3 py-1.5 text-xs font-semibold text-accent transition hover:bg-warm-bg disabled:opacity-40"
            >
              {parsing ? "Reading…" : "Read this & fill in my profile"}
            </button>
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
      </section>
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
    <section className="mt-7 rounded-3xl border border-warm-border bg-white p-6 shadow-soft sm:p-8">
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
function FileDrop({
  onText,
  label = "Drop a file here, or click to upload",
  accept = ".pdf,.docx,.html,.htm,.txt,.md",
}: {
  onText: (text: string) => void;
  label?: string;
  accept?: string;
}) {
  const [reading, setReading] = useState(false);
  const [err, setErr] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  async function handle(file?: File | null) {
    if (!file) return;
    setErr("");
    setReading(true);
    try {
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
      <div className="mt-0.5 text-xs text-body/70">PDF, Word (.docx), HTML, or text file</div>
      {err && <div className="mt-1.5 text-xs font-semibold text-accent">{err}</div>}
    </div>
  );
}

/* ---------------- Profile gate (shown until a profile exists) ---------------- */
function ProfileGate({ onSetup }: { onSetup: () => void }) {
  return (
    <section className="mt-6 rounded-3xl border border-warm-border bg-white p-8 text-center shadow-soft sm:p-12">
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
        Set up your profile
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
    <div className="rounded-2xl border border-warm-border bg-white p-5 shadow-card">
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
      className={`absolute top-4 h-3.5 w-3.5 rotate-45 bg-white ${
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
}: {
  projects: Project[];
  categories: Category[];
  onAddProject: (name: string) => void;
  onRenameProject: (id: string, name: string) => void;
  onRemoveProject: (id: string) => void;
  onAddCategory: (projectId: string, name: string) => void;
  onRenameCategory: (id: string, name: string) => void;
  onRemoveCategory: (id: string) => void;
}) {
  const [newProject, setNewProject] = useState("");
  // One "new category" input value per project, keyed by project id.
  const [newCat, setNewCat] = useState<Record<string, string>>({});

  return (
    <div>
      <Label>Your projects and categories</Label>
      <p className="mt-1 mb-3 text-xs leading-relaxed text-body/70">
        A project is usually one goal or one person you manage (say, an artist);
        its categories are the kinds of people you search for. Edit them here or on
        the Outreach tab, they stay in sync.
      </p>

      <div className="space-y-3">
        {projects.map((p) => {
          const cats = categories.filter((c) => c.projectId === p.id);
          return (
            <div
              key={p.id}
              className="rounded-2xl border border-warm-border bg-white p-4 shadow-card"
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

              <div className="mt-2.5 space-y-1.5 border-t border-warm-border pt-2.5">
                {cats.length === 0 && (
                  <p className="px-1 text-xs text-body/50">
                    No categories yet. Add one below.
                  </p>
                )}
                {cats.map((c) => (
                  <div key={c.id} className="flex items-center gap-1.5">
                    <span className="text-body/30" aria-hidden>
                      ·
                    </span>
                    <input
                      defaultValue={c.name}
                      key={c.name}
                      onBlur={(e) => {
                        const v = e.target.value.trim();
                        if (v && v !== c.name) onRenameCategory(c.id, v);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") e.currentTarget.blur();
                      }}
                      aria-label={`Category name for ${c.name}`}
                      className="min-w-0 flex-1 rounded-lg border border-transparent px-2 py-1 text-sm text-ink outline-none transition hover:border-warm-border focus:border-coral"
                    />
                    {cats.length > 1 && (
                      <button
                        onClick={() => onRemoveCategory(c.id)}
                        title={`Remove ${c.name}`}
                        aria-label={`Remove category ${c.name}`}
                        className="shrink-0 rounded-lg border border-warm-border p-1 text-body/60 transition hover:border-coral/40 hover:bg-warm-bg hover:text-accent"
                      >
                        <TrashIcon />
                      </button>
                    )}
                  </div>
                ))}
                <div className="flex items-center gap-1.5 pt-1">
                  <input
                    value={newCat[p.id] || ""}
                    onChange={(e) =>
                      setNewCat((s) => ({ ...s, [p.id]: e.target.value }))
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (newCat[p.id] || "").trim()) {
                        onAddCategory(p.id, newCat[p.id]);
                        setNewCat((s) => ({ ...s, [p.id]: "" }));
                      }
                    }}
                    placeholder="Add a category"
                    className="min-w-0 flex-1 rounded-lg border border-warm-border px-2.5 py-1.5 text-sm text-ink outline-none transition focus:border-coral"
                  />
                  <button
                    onClick={() => {
                      if ((newCat[p.id] || "").trim()) {
                        onAddCategory(p.id, newCat[p.id]);
                        setNewCat((s) => ({ ...s, [p.id]: "" }));
                      }
                    }}
                    disabled={!(newCat[p.id] || "").trim()}
                    className="shrink-0 rounded-lg border border-warm-border px-3 py-1.5 text-xs font-bold text-accent transition hover:bg-warm-bg disabled:opacity-40"
                  >
                    Add
                  </button>
                </div>
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
          placeholder="New project (e.g. another artist you manage)"
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
      className="absolute left-0 top-full z-30 mt-2 w-[300px] rounded-2xl border border-warm-border bg-white p-3 shadow-soft"
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
      <div className="absolute right-6 top-2 w-60 rounded-2xl rounded-tr-sm border border-warm-border bg-white p-3.5 shadow-soft">
        <span
          aria-hidden
          className="absolute -right-[6px] top-5 h-3 w-3 rotate-45 border-r border-t border-warm-border bg-white"
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
      <div className="absolute bottom-1 right-10 flex items-center gap-1.5 rounded-full border border-warm-border bg-white px-3 py-2 shadow-card">
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
