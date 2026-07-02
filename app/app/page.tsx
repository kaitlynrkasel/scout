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

const TPL_KEY = "cue_templates";
const PROFILE_KEY = "cue_profile";
const CAT_KEY = "cue_categories";
const PROJECTS_KEY = "cue_projects";
const ACTIVE_KEY = "cue_active_project";
const ACT_KEY = "cue_activity";
const FINDS_KEY = "cue_finds";

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

// A find is a saved person/opportunity you can work through: draft, deny, or mark
// contacted. Finds accumulate across searches and persist per project.
type FindStatus = "new" | "drafted" | "sent" | "denied";
interface Find {
  id: string; // stable dedup key: project + normalized name + host
  projectId: string;
  status: FindStatus;
  opp: Opportunity;
  draft?: Draft;
  addedAt: number;
}

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
  { key: "denied", label: "Denied" },
  { key: "all", label: "All" },
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
    "outreach" | "finds" | "dashboard" | "templates" | "profile" | "account"
  >("outreach");

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
  const [profile, setProfile] = useState<Profile>(initialProfile);
  const [categories, setCategories] = useState<Category[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [activity, setActivity] = useState<Activity>(ZERO_ACTIVITY);
  const [finds, setFinds] = useState<Find[]>([]);
  const [findFilter, setFindFilter] = useState<FindStatus | "all">("new");
  const [findDraftingId, setFindDraftingId] = useState(""); // find being drafted

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
    const prof: Profile = initialProfile;
    let cats: Category[] = [];
    let projs: Project[] = [];
    let active = "";
    let tpls: OutreachTemplate[] = [];
    let act: Partial<Activity> | null = null;
    let savedFinds: Find[] = [];

    if (initialState && (initialState.projects?.length || initialState.templates?.length)) {
      cats = initialState.categories || [];
      projs = initialState.projects || [];
      active = initialState.activeId || "";
      tpls = initialState.templates || [];
      act = initialState.activity || null;
      savedFinds = initialState.finds || [];
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
    }
    setMyTemplates(tpls);
    if (act) setActivity({ ...ZERO_ACTIVITY, ...act });
    setFinds(Array.isArray(savedFinds) ? savedFinds : []);

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
    onSaveState({ templates: myTemplates, projects, categories, activeId, activity, finds });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myTemplates, projects, categories, activeId, activity, finds]);

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
  // mode ("draft"/"send") on success, or null on failure.
  const sendViaGmail = async (d: Draft): Promise<"draft" | "send" | null> => {
    if (!getToken) return null;
    const token = await getToken();
    if (!token) return null;
    setError("");
    setGmailBusyId(d.opportunityId);
    try {
      const r = await fetch("/api/gmail/send", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ to: d.to, subject: d.subject, body: d.body }),
      });
      const j = await r.json();
      if (r.ok) {
        setGmailSent((s) => ({ ...s, [d.opportunityId]: j.mode }));
        bumpActivity({ copies: 1 });
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
      { id: `${Date.now()}`, channel: mtChannel, text: mtText.trim() },
      ...myTemplates,
    ]);
    setMtText("");
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
      fresh.push({ id, projectId: activeId, status: "new", opp: o, addedAt: Date.now() });
    }
    if (fresh.length) saveFinds([...fresh, ...finds]);
    return fresh.length;
  }

  function setFindStatus(id: string, status: FindStatus) {
    saveFinds(finds.map((f) => (f.id === id ? { ...f, status } : f)));
  }
  function removeFind(id: string) {
    saveFinds(finds.filter((f) => f.id !== id));
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
          opportunities: [find.opp],
          about: aboutText,
          useCase: activeUseCase,
          templates: myTemplates,
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

  // Send/draft a find's message via Gmail, then mark it contacted on success.
  async function sendFindViaGmail(find: Find) {
    if (!find.draft) return;
    const mode = await sendViaGmail(find.draft);
    if (mode === "send") setFindStatus(find.id, "sent");
  }

  async function runDiscover() {
    if (!profileComplete) {
      setTab("profile");
      return;
    }
    resetResults();
    setDiscovering(true);
    try {
      const res = await fetch("/api/discover", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ goal, about: aboutText, useCase: activeUseCase }),
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
          templates: myTemplates,
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
  // Deny a result: mark it "Not a fit" in the pipeline and drop it from the batch.
  const denyOpp = (o: Opportunity) => {
    setFindStatus(findKey(activeId, o), "denied");
    setSelected((s) => ({ ...s, [o.id]: false }));
  };

  return (
    <div className="min-h-screen">
      {/* ---------------- App bar ---------------- */}
      <header className="sticky top-0 z-20 border-b border-warm-border bg-white/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-6 py-3">
          <Logo />
          <span className="text-[16px] font-extrabold tracking-tight text-ink">
            <span className="brand-text">Scout</span>
          </span>
          <div className="ml-auto flex items-center gap-4">
            <span className="hidden text-xs font-medium text-body/70 sm:block">
              Reach the right people, in your own voice
            </span>
            {accountEmail && (
              <button
                onClick={() => setTab("account")}
                className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition ${
                  tab === "account"
                    ? "border-coral/40 bg-warm-bg text-accent"
                    : "border-warm-border text-body hover:bg-warm-bg"
                }`}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <circle cx="12" cy="8" r="3.5" />
                  <path d="M5 20a7 7 0 0 1 14 0" />
                </svg>
                Account
              </button>
            )}
          </div>
        </div>
        <div className="mx-auto flex max-w-6xl gap-7 px-6">
          <TabButton active={tab === "outreach"} onClick={() => setTab("outreach")}>
            Outreach
          </TabButton>
          <TabButton active={tab === "finds"} onClick={() => setTab("finds")}>
            Finds
            {newFindCount > 0 && <Count n={newFindCount} />}
          </TabButton>
          <TabButton active={tab === "dashboard"} onClick={() => setTab("dashboard")}>
            Dashboard
          </TabButton>
          <TabButton active={tab === "templates"} onClick={() => setTab("templates")}>
            Templates
            {myTemplates.length > 0 && <Count n={myTemplates.length} />}
          </TabButton>
          <TabButton active={tab === "profile"} onClick={() => setTab("profile")}>
            Profile
            {profile.bio.trim() && <Dot />}
          </TabButton>
          {accountEmail && (
            <TabButton active={tab === "account"} onClick={() => setTab("account")}>
              Account
            </TabButton>
          )}
        </div>
      </header>

      {tab === "outreach" && (
        <>
          {/* ---------------- Hero ---------------- */}
          <section className="relative overflow-hidden bg-warm-fade">
            <div className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-brand-gradient opacity-[0.12] blur-3xl" />
            <div className="mx-auto grid max-w-6xl items-center gap-8 px-6 pb-3 pt-12 lg:grid-cols-[1.3fr_1fr]">
              <div>
                <span className="inline-block rounded-full border border-warm-border bg-white px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-accent shadow-card">
                  One place for every conversation
                </span>
                <h1 className="mt-4 max-w-2xl text-4xl font-extrabold leading-[1.1] tracking-tight text-ink sm:text-5xl">
                  Find your people.{" "}
                  <span className="brand-text">Start the conversation.</span>
                </h1>
                <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-body">
                  Scout helps you reach the right people across email, LinkedIn,
                  Instagram and more. It finds their contact info and drafts warm,
                  personal messages that sound like you, so saying hello feels easy.
                </p>
              </div>
              <div className="hidden lg:block">
                <HeroArt />
              </div>
            </div>
          </section>

          <main className="mx-auto max-w-6xl px-6 pb-20">
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
        </>
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
          onDeny={(f) => setFindStatus(f.id, "denied")}
          onReopen={(f) => setFindStatus(f.id, "new")}
          onMarkSent={(f) => setFindStatus(f.id, "sent")}
          onRemove={(f) => removeFind(f.id)}
          onSendGmail={sendFindViaGmail}
          onCopy={() => bumpActivity({ copies: 1 })}
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
          goOutreach={() => setTab("outreach")}
          goTemplates={() => setTab("templates")}
          goProfile={() => setTab("profile")}
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
  onDeny: (o: Opportunity) => void;
  roomy?: boolean;
}) {
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
              <button
                onClick={() => onDeny(o)}
                className="rounded-lg border border-warm-border px-3.5 py-1.5 text-xs font-semibold text-body/70 transition hover:border-coral/40 hover:bg-warm-bg hover:text-accent"
              >
                Deny
              </button>
              {on && (
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
  onReopen,
  onMarkSent,
  onRemove,
  onSendGmail,
  onCopy,
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
  onDeny: (f: Find) => void;
  onReopen: (f: Find) => void;
  onMarkSent: (f: Find) => void;
  onRemove: (f: Find) => void;
  onSendGmail: (f: Find) => void;
  onCopy: () => void;
  goOutreach: () => void;
}) {
  const counts: Record<string, number> = { all: finds.length };
  for (const s of ["new", "drafted", "sent", "denied"] as FindStatus[]) {
    counts[s] = finds.filter((f) => f.status === s).length;
  }
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
        <button
          onClick={goOutreach}
          className="rounded-xl bg-brand-gradient px-5 py-2.5 text-sm font-bold text-white shadow-soft transition hover:opacity-95"
        >
          Find more
        </button>
      </div>

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
              onDeny={() => onDeny(f)}
              onReopen={() => onReopen(f)}
              onMarkSent={() => onMarkSent(f)}
              onRemove={() => onRemove(f)}
              onSendGmail={() => onSendGmail(f)}
              onCopy={onCopy}
            />
          ))}
        </div>
      )}
    </main>
  );
}

function FindStatusBadge({ status }: { status: FindStatus }) {
  const map: Record<FindStatus, { label: string; cls: string }> = {
    new: { label: "New", cls: "border-warm-border bg-warm-bg text-body" },
    drafted: { label: "Drafted", cls: "border-coral/30 bg-warm-bg text-accent" },
    sent: { label: "Sent", cls: "border-emerald-200 bg-emerald-50 text-emerald-700" },
    denied: { label: "Not a fit", cls: "border-warm-border bg-white text-body/50" },
  };
  const s = map[status];
  return (
    <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${s.cls}`}>
      {s.label}
    </span>
  );
}

function FindCard({
  find,
  gmail,
  drafting,
  gmailBusy,
  onDraft,
  onDeny,
  onReopen,
  onMarkSent,
  onRemove,
  onSendGmail,
  onCopy,
}: {
  find: Find;
  gmail: { connected: boolean; email?: string; sendMode?: "draft" | "send" };
  drafting: boolean;
  gmailBusy: boolean;
  onDraft: () => void;
  onDeny: () => void;
  onReopen: () => void;
  onMarkSent: () => void;
  onRemove: () => void;
  onSendGmail: () => void;
  onCopy: () => void;
}) {
  const o = find.opp;
  const d = find.draft;
  const denied = find.status === "denied";
  const emailDraft = d && d.channelType === "email" && !!mailHref(d.to);

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
        <FindStatusBadge status={find.status} />
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

      {/* Stored draft */}
      {d && (
        <div className="mt-3 rounded-xl border border-warm-border bg-warm-bg/40 p-3">
          {d.subject && (
            <div className="mb-1.5 text-sm font-semibold text-ink">{d.subject}</div>
          )}
          <pre className="whitespace-pre-wrap font-sans text-xs leading-relaxed text-body">
            {d.body}
          </pre>
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

        {d && (
          <>
            {gmail.connected && emailDraft && find.status !== "sent" ? (
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
              find.status !== "sent" && (
                <SendAction draft={d} onUse={onCopy} />
              )
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

        {find.status !== "sent" && (
          <button
            onClick={onMarkSent}
            className="rounded-lg border border-warm-border px-3 py-1.5 text-xs font-semibold text-body transition hover:bg-warm-bg"
          >
            Mark contacted
          </button>
        )}

        {denied ? (
          <button
            onClick={onReopen}
            className="rounded-lg border border-warm-border px-3 py-1.5 text-xs font-semibold text-accent transition hover:bg-warm-bg"
          >
            Reopen
          </button>
        ) : find.status === "sent" ? (
          <button
            onClick={onReopen}
            className="ml-auto text-xs font-semibold text-body/50 transition hover:text-accent"
          >
            Reopen
          </button>
        ) : (
          <button
            onClick={onDeny}
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
    </div>
  );
}

/* ---------------- Preference / deny-rate analytics from real finds ---------------- */
function learnedFromFinds(finds: Find[]) {
  const decided = finds.filter((f) => f.status !== "new");
  const denied = decided.filter((f) => f.status === "denied");
  const kept = decided.filter((f) => f.status === "drafted" || f.status === "sent");
  const denyRate = decided.length ? denied.length / decided.length : 0;

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
  goOutreach,
  goTemplates,
  goProfile,
}: {
  activity: Activity;
  profile: Profile;
  templates: OutreachTemplate[];
  projects: Project[];
  categoriesCount: number;
  finds: Find[];
  community: CommunityStats | null;
  goOutreach: () => void;
  goTemplates: () => void;
  goProfile: () => void;
}) {
  const learned = learnedFromFinds(finds);
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
    <main className="mx-auto max-w-4xl px-6 py-12">
      <h1 className="text-3xl font-extrabold tracking-tight text-ink">
        Your <span className="brand-text">dashboard</span>
      </h1>
      <p className="mt-2 text-[15px] leading-relaxed text-body">
        How your outreach is going, and how Scout is getting sharper for you.
      </p>

      {/* -------- Activity (real counts) -------- */}
      <section className="mt-7 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard n={activity.found} label="People found" />
        <StatCard n={activity.drafts} label="Messages drafted" />
        <StatCard n={activity.copies} label="Taken to send" />
        <StatCard n={activity.searches} label="Searches run" />
      </section>

      <div className="mt-3 flex flex-wrap items-center gap-3 rounded-2xl border border-warm-border bg-warm-bg/50 px-5 py-4">
        <div>
          <div className="text-lg font-extrabold text-ink">
            ~{timeSaved}{" "}
            <span className="text-xs font-semibold text-body/70">saved (est.)</span>
          </div>
          <p className="mt-0.5 text-xs text-body/70">
            Rough estimate at about 6 minutes to find and personally write each of
            your {activity.drafts} {activity.drafts === 1 ? "message" : "messages"}.
          </p>
        </div>
        <button
          onClick={goOutreach}
          className="ml-auto rounded-xl bg-brand-gradient px-5 py-2.5 text-sm font-bold text-white shadow-soft transition hover:opacity-95"
        >
          Scout more people
        </button>
      </div>

      {activity.searches === 0 && (
        <p className="mt-3 text-xs text-body/60">
          Numbers fill in as you use Scout. Run a search on the Outreach tab to get
          started.
        </p>
      )}

      {/* -------- What Scout has learned about your taste (real, from finds) -------- */}
      <section className="mt-10">
        <h2 className="text-lg font-bold text-ink">What Scout knows about your taste</h2>
        <p className="mt-1 text-sm text-body/80">
          Built from the finds you keep and pass on, all your own data. The more you
          review, the sharper Scout&apos;s picture of who you actually want.
        </p>

        {learned.decided === 0 ? (
          <div className="mt-4 rounded-2xl border border-dashed border-warm-border bg-white/60 p-8 text-center text-sm text-body/70">
            Nothing learned yet. As you draft messages and set aside finds that
            aren&apos;t a fit on the{" "}
            <button onClick={goOutreach} className="font-semibold text-accent hover:underline">
              Finds
            </button>{" "}
            tab, your deny rate and preferences show up here.
          </div>
        ) : (
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {/* Deny rate + trend */}
            <div className="rounded-2xl border border-warm-border bg-white p-5 shadow-card">
              <div className="text-xs font-bold uppercase tracking-wider text-body/60">
                Your deny rate
              </div>
              <div className="mt-1 flex items-end gap-2">
                <span className="text-3xl font-extrabold tracking-tight text-ink">
                  {Math.round(learned.denyRate * 100)}%
                </span>
                {learned.trend && Math.abs(learned.trend.delta) >= 0.01 && (
                  <span
                    className={`mb-1 text-xs font-bold ${
                      learned.trend.delta < 0 ? "text-emerald-600" : "text-body/60"
                    }`}
                  >
                    {learned.trend.delta < 0 ? "▼ down" : "▲ up"} from{" "}
                    {Math.round(learned.trend.early * 100)}%
                  </span>
                )}
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-body/70">
                {learned.trend
                  ? learned.trend.delta < -0.01
                    ? "Fewer of Scout's finds are misses now than when you started, it's getting your taste."
                    : learned.trend.delta > 0.01
                    ? "Recent finds are landing less often. Adjusting your goal wording or project context can sharpen them."
                    : "Holding steady as Scout learns what fits."
                  : `You've set aside ${learned.denied} of ${learned.decided} you reviewed. A trend appears once you've reviewed a few more.`}
              </p>
            </div>

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

            {/* Preferences */}
            <div className="rounded-2xl border border-warm-border bg-white p-5 shadow-card sm:col-span-2">
              <div className="text-xs font-bold uppercase tracking-wider text-body/60">
                Your preferences so far
              </div>
              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                <div>
                  <div className="text-xs font-semibold text-emerald-700">You reach out to</div>
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
              <p className="mt-3 text-xs text-body/60">
                Scout uses these patterns to rank future finds toward the kind you
                actually act on.
              </p>
            </div>
          </div>
        )}
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

      {/* -------- Outreach advice: what's working for others + proven playbook -------- */}
      <OutreachAdvice
        community={community}
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
    </main>
  );
}

/* ---------------- Outreach advice: community patterns + proven playbook ---------------- */
function OutreachAdvice({
  community,
  goOutreach,
  goTemplates,
}: {
  community: CommunityStats | null;
  goOutreach: () => void;
  goTemplates: () => void;
}) {
  const p = community?.patterns;
  const pct = (v: number) => `${Math.round(v * 100)}%`;

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
        What&apos;s working for other people on Scout, plus the fundamentals that
        always hold.
      </p>

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
                <div className="text-sm font-bold text-ink">{tip.title}</div>
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
                {tip.cta && (
                  <button
                    onClick={tip.cta.go}
                    className="shrink-0 rounded-lg border border-warm-border px-2.5 py-1 text-[11px] font-semibold text-accent transition hover:bg-warm-bg"
                  >
                    {tip.cta.label}
                  </button>
                )}
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

function StatCard({ n, label }: { n: number; label: string }) {
  return (
    <div className="rounded-2xl border border-warm-border bg-white p-4 shadow-card">
      <div className="text-3xl font-extrabold tracking-tight text-ink">{n}</div>
      <div className="mt-1 text-xs font-medium text-body/70">{label}</div>
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
}: {
  kinds: string[];
  channel: string;
  setChannel: (v: string) => void;
  text: string;
  setText: (v: string) => void;
  add: () => void;
  list: OutreachTemplate[];
  remove: (id: string) => void;
}) {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-3xl font-extrabold tracking-tight text-ink">
        Your <span className="brand-text">templates</span>
      </h1>
      <p className="mt-2 text-[15px] leading-relaxed text-body">
        Set up how each kind of message should sound, an email, a LinkedIn note, an
        Instagram DM. When Scout drafts outreach, it uses the right format and
        your voice for each channel.
        <span className="text-body/60"> (Saved on this device.)</span>
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
                <div className="mb-2.5 flex items-center gap-2">
                  <span className="rounded-full bg-brand-gradient px-2.5 py-0.5 text-xs font-semibold text-white">
                    {s.channel}
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
}) {
  const [parsing, setParsing] = useState(false);
  const [autofilled, setAutofilled] = useState(false);
  const [note, setNote] = useState("");
  // Individual vs company changes how you fill your profile (resume vs website).
  const [kind, setKind] = useState<"individual" | "company">("individual");
  const [website, setWebsite] = useState("");
  useEffect(() => {
    try {
      const k = localStorage.getItem("cue_kind");
      if (k === "company" || k === "individual") setKind(k);
    } catch {}
  }, []);
  function chooseKind(k: "individual" | "company") {
    setKind(k);
    try {
      localStorage.setItem("cue_kind", k);
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
              placeholder="e.g. Kaitlyn Kasel, or Cue Creative"
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
            rows={11}
            placeholder="Your resume text appears here after you upload it, or paste anything that tells us who you are: your LinkedIn About section, a short bio, your company's about page, your experience. Then tap 'Read this & fill in my profile'. The more you give, the more personal your outreach becomes."
            className="w-full resize-y rounded-xl border border-warm-border px-3.5 py-3 text-sm leading-relaxed text-ink outline-none transition focus:border-coral focus:ring-4 focus:ring-coral/15"
          />
        </div>

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
  accept = ".pdf,.docx,.txt,.md",
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
      <div className="mt-0.5 text-xs text-body/70">PDF, Word (.docx), or text file</div>
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
  const s = small ? 18 : 24;
  if (white) {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path
          d="M6 7.5h12a1 1 0 0 1 1 1V14a1 1 0 0 1-1 1h-6.5L8 17.6A.45.45 0 0 1 7.3 17.2V15H6a1 1 0 0 1-1-1V8.5a1 1 0 0 1 1-1Z"
          stroke="white"
          strokeWidth="1.6"
          fill="none"
          strokeLinejoin="round"
        />
        <path d="M8 10.2h8 M8 12.4h5" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" aria-hidden>
      <defs>
        <linearGradient id="cc-grad" x1="0" y1="0" x2="24" y2="24">
          <stop stopColor="#ff8a5b" />
          <stop offset="1" stopColor="#ff6f91" />
        </linearGradient>
      </defs>
      <rect width="24" height="24" rx="7" fill="url(#cc-grad)" />
      <path
        d="M6 7.5h12a1 1 0 0 1 1 1V14a1 1 0 0 1-1 1h-6.5L8 17.6A.45.45 0 0 1 7.3 17.2V15H6a1 1 0 0 1-1-1V8.5a1 1 0 0 1 1-1Z"
        stroke="white"
        strokeWidth="1.5"
        fill="none"
        strokeLinejoin="round"
      />
      <path d="M8 10.2h8 M8 12.4h5" stroke="white" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
