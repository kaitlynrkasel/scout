import { NextResponse } from "next/server";
import { supabaseAdmin, userFromReq } from "@/lib/supabaseAdmin";

export const maxDuration = 30;
export const dynamic = "force-dynamic";

// The signed-in user's own view of concierge-seeded finds an owner queued for
// their email. Identity comes from the verified access token (not a client-sent
// email), and everything runs through the service role, so the table itself
// needs no anon RLS policy.
//
// GET  -> pending (un-consumed) seeds for the caller's email.
// POST -> mark the given seed ids consumed (after the client merges them in).
export async function GET(req: Request) {
  const me = await userFromReq(req);
  if (!me || !me.email) {
    return NextResponse.json({ items: [] });
  }
  if (!supabaseAdmin) return NextResponse.json({ items: [] });

  const { data, error } = await supabaseAdmin
    .from("admin_seeded_finds")
    .select("id, opp, note, created_at")
    .eq("email", me.email.toLowerCase())
    .is("consumed_at", null)
    .order("created_at", { ascending: true })
    .limit(100);
  if (error) {
    return NextResponse.json({ items: [], error: error.message });
  }
  return NextResponse.json({
    items: (data || []).map((r) => ({
      id: (r as any).id,
      opp: (r as any).opp,
      note: (r as any).note || "",
    })),
  });
}

export async function POST(req: Request) {
  const me = await userFromReq(req);
  if (!me || !me.email) {
    return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  }
  if (!supabaseAdmin) {
    return NextResponse.json({ error: "Not configured." }, { status: 500 });
  }
  const body = await req.json().catch(() => ({}));
  const ids: string[] = Array.isArray(body?.ids)
    ? body.ids.map((x: any) => String(x)).slice(0, 100)
    : [];
  if (!ids.length) return NextResponse.json({ ok: true, consumed: 0 });

  // Scope the update to the caller's own email so a stray/forged id can't
  // consume someone else's queued seeds.
  const { data, error } = await supabaseAdmin
    .from("admin_seeded_finds")
    .update({ consumed_at: new Date().toISOString() })
    .eq("email", me.email.toLowerCase())
    .is("consumed_at", null)
    .in("id", ids)
    .select("id");
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, consumed: data?.length || 0 });
}
