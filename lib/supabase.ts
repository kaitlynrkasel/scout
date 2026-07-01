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
}

// Load the signed-in user's profile row (or null if they have none yet).
export async function loadProfile(userId: string): Promise<DbProfile | null> {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("profiles")
    .select("name, bio, use_case")
    .eq("id", userId)
    .maybeSingle();
  if (error || !data) return null;
  return {
    name: data.name || "",
    bio: data.bio || "",
    useCase: data.use_case || "networking",
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
    updated_at: new Date().toISOString(),
  });
}
