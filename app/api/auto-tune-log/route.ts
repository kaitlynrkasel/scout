import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, userIdFromReq } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";

// Read-only: the caller's own algorithm auto-tune history (see
// /api/cron/auto-tune and supabase/auto_tune_log.sql). Table RLS already
// restricts a row to its own user, but we use the service-role client + an
// explicit .eq(user_id) since this route authenticates via bearer token, not
// a browser session cookie.
export async function GET(req: NextRequest) {
  if (!supabaseAdmin) {
    return NextResponse.json({ entries: [] });
  }
  const uid = await userIdFromReq(req);
  if (!uid) {
    return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  }
  const { data, error } = await supabaseAdmin
    .from("auto_tune_log")
    .select("id, created_at, slot, label, old_clause, new_clause, commit_url, signal")
    .eq("user_id", uid)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ entries: data || [] });
}
