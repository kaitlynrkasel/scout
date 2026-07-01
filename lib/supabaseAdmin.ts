// Server-only Supabase client using the service-role key. NEVER import this from
// a client component — it bypasses row-level security. Used by the Gmail routes
// to store tokens and to validate the caller's access token.

import { createClient, SupabaseClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

export const supabaseAdmin: SupabaseClient | null =
  url && serviceKey
    ? createClient(url, serviceKey, { auth: { persistSession: false } })
    : null;

// Validate a Supabase access token and return the user id (or null).
export async function userIdFromToken(
  token: string | null
): Promise<string | null> {
  if (!supabaseAdmin || !token) return null;
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user.id;
}

export function bearerToken(req: Request): string | null {
  const h = req.headers.get("authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

export async function userIdFromReq(req: Request): Promise<string | null> {
  return userIdFromToken(bearerToken(req));
}
