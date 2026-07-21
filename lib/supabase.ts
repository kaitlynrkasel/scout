// Supabase client for auth + the profiles table. If the env vars are not set,
// authEnabled is false and the app falls back to per-browser storage (so the
// site keeps working before Supabase is configured).

import { createClient, SupabaseClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const authEnabled = !!(url && anon);

// "Remember me" is implemented with a hybrid storage adapter. When the user
// checks it (the default), the session lives in localStorage and survives a
// browser restart. When they uncheck it, the session lives in sessionStorage and
// is dropped when the tab/window closes. Reads check both stores, so this is
// backward-compatible with existing localStorage sessions.
const REMEMBER_KEY = "scout_remember";

export function setRememberMe(remember: boolean) {
  try {
    localStorage.setItem(REMEMBER_KEY, remember ? "1" : "0");
  } catch {
    /* storage unavailable, default (remember) applies */
  }
}

function primaryStore(): Storage {
  try {
    return localStorage.getItem(REMEMBER_KEY) === "0" ? sessionStorage : localStorage;
  } catch {
    return localStorage;
  }
}

const hybridStorage = {
  getItem(key: string): string | null {
    try {
      return localStorage.getItem(key) ?? sessionStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem(key: string, value: string): void {
    try {
      const store = primaryStore();
      store.setItem(key, value);
      // Keep the token in only one place so the remember choice is authoritative.
      (store === localStorage ? sessionStorage : localStorage).removeItem(key);
    } catch {
      /* ignore */
    }
  },
  removeItem(key: string): void {
    try {
      localStorage.removeItem(key);
      sessionStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

export const supabase: SupabaseClient | null = authEnabled
  ? createClient(url as string, anon as string, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storage: typeof window !== "undefined" ? hybridStorage : undefined,
      },
    })
  : null;

export interface DbProfile {
  name: string;
  bio: string;
  useCase: string;
  linkedin?: string;
}

// Load the signed-in user's profile row (or null if they have none yet).
export async function loadProfile(userId: string): Promise<DbProfile | null> {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("profiles")
    .select("name, bio, use_case, linkedin")
    .eq("id", userId)
    .maybeSingle();
  if (error) console.warn("loadProfile failed:", error.message);
  if (error || !data) return null;
  return {
    name: data.name || "",
    bio: data.bio || "",
    useCase: data.use_case || "networking",
    linkedin: data.linkedin || "",
  };
}

// Upsert the signed-in user's profile row. Returns an error message on failure
// (e.g. missing grants/RLS) instead of silently swallowing it, so a broken save
// is visible rather than looking like it worked.
export async function saveProfile(
  userId: string,
  p: DbProfile
): Promise<string | null> {
  if (!supabase) return null;
  const { error } = await supabase.from("profiles").upsert({
    id: userId,
    name: p.name,
    bio: p.bio,
    use_case: p.useCase,
    linkedin: p.linkedin || "",
    updated_at: new Date().toISOString(),
  });
  if (error) {
    console.error("saveProfile failed:", error.message);
    return error.message;
  }
  return null;
}

// The rest of the user's app state (templates, projects, categories, activity)
// stored as one JSON blob per user, so it syncs across their devices like the
// profile does. Read/written with the user's own session (RLS = own row only).
export interface AppState {
  templates?: any[];
  projects?: any[];
  categories?: any[];
  activeId?: string;
  activity?: any;
  finds?: any[];
  coaching?: string[]; // approved dashboard tips, applied to every draft
  editPairs?: { before: string; after: string }[]; // learn-from-edits voice deltas
  resumeFile?: { name: string; dataUrl: string } | null; // resume to attach to emails
  signature?: string; // email signature appended to drafted emails
  syncedSheets?: any[]; // linked spreadsheets Scout re-reads automatically
  // Extra profile fields that aren't columns on the profiles table (age,
  // education, location, company-size preference, competitiveness). Ride along
  // in the JSON blob so a redeploy or new device doesn't wipe them out.
  profileExtras?: {
    accountType?: string;
    companyName?: string;
    companyRole?: string;
    companyContribution?: string;
    companyExpertise?: string;
    useExpertise?: boolean;
    companyAbout?: string;
    companyIndustry?: string;
    companyStage?: string;
    companyWorkspaceId?: string;
    age?: number;
    eduStatus?: string;
    college?: string;
    major?: string;
    location?: string;
    companySize?: string;
    competitiveness?: string;
  };
}

export async function loadState(userId: string): Promise<AppState | null> {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("user_state")
    .select("data")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) console.warn("loadState failed:", error.message);
  if (error || !data) return null;
  return (data.data || {}) as AppState;
}

export async function saveState(
  userId: string,
  state: AppState
): Promise<string | null> {
  if (!supabase) return null;
  const { error } = await supabase.from("user_state").upsert({
    user_id: userId,
    data: state,
    updated_at: new Date().toISOString(),
  });
  if (error) {
    console.error("saveState failed:", error.message);
    return error.message;
  }
  return null;
}

// ---- Multi-account switcher ------------------------------------------------
// The signed-in accounts this browser knows, so switching is one click instead
// of log-out-and-retype. Each entry stores the account's latest session tokens;
// same storage risk class as Supabase's own persisted session (already in
// localStorage). The active account's tokens are refreshed on every
// TOKEN_REFRESHED event; an inactive account's refresh token stays valid until
// used (Supabase rotates on use, not on time).
const ACCOUNTS_KEY = "scout_accounts";
export interface SavedAccount {
  email: string;
  at: string; // access token (may be expired; setSession refreshes)
  rt: string; // refresh token
  name?: string;
}
export function listSavedAccounts(): SavedAccount[] {
  try {
    const a = JSON.parse(localStorage.getItem(ACCOUNTS_KEY) || "[]");
    return Array.isArray(a) ? a.filter((x) => x && x.email && x.rt) : [];
  } catch {
    return [];
  }
}
export function rememberAccount(email: string, at: string, rt: string, name?: string) {
  if (!email || !rt) return;
  try {
    const list = listSavedAccounts().filter((a) => a.email !== email);
    list.unshift({ email, at, rt, name });
    localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(list.slice(0, 6)));
  } catch {}
}
export function forgetAccount(email: string) {
  try {
    localStorage.setItem(
      ACCOUNTS_KEY,
      JSON.stringify(listSavedAccounts().filter((a) => a.email !== email))
    );
  } catch {}
}
// Swap the live session to a saved account. Returns an error message, or null
// on success (caller should reload so all state reinitializes cleanly).
export async function switchAccount(email: string): Promise<string | null> {
  const acc = listSavedAccounts().find((a) => a.email === email);
  if (!acc || !supabase) return "No saved session for that account.";
  const { error } = await supabase.auth.setSession({
    access_token: acc.at,
    refresh_token: acc.rt,
  });
  if (error) {
    forgetAccount(email); // stale — make them sign in once to re-link
    return "That saved session expired. Sign in once and it'll be one click from then on.";
  }
  return null;
}
