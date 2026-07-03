// Supabase client for auth + the profiles table. If the env vars are not set,
// authEnabled is false and the app falls back to per-browser storage (so the
// site keeps working before Supabase is configured).

import { createClient, SupabaseClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const authEnabled = !!(url && anon);

export const supabase: SupabaseClient | null = authEnabled
  ? createClient(url as string, anon as string)
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
  if (error || !data) return null;
  return {
    name: data.name || "",
    bio: data.bio || "",
    useCase: data.use_case || "networking",
    linkedin: data.linkedin || "",
  };
}

// Upsert the signed-in user's profile row.
export async function saveProfile(userId: string, p: DbProfile): Promise<void> {
  if (!supabase) return;
  await supabase.from("profiles").upsert({
    id: userId,
    name: p.name,
    bio: p.bio,
    use_case: p.useCase,
    linkedin: p.linkedin || "",
    updated_at: new Date().toISOString(),
  });
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
}

export async function loadState(userId: string): Promise<AppState | null> {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("user_state")
    .select("data")
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data) return null;
  return (data.data || {}) as AppState;
}

export async function saveState(userId: string, state: AppState): Promise<void> {
  if (!supabase) return;
  await supabase.from("user_state").upsert({
    user_id: userId,
    data: state,
    updated_at: new Date().toISOString(),
  });
}
