import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, userFromReq } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";
export const maxDuration = 30;
export const dynamic = "force-dynamic";

// Manage a user's recurring auto-searches. All access is server-side with the
// service role after verifying the caller's token (the table has no anon RLS).
//
// GET    -> the caller's auto-searches
// POST   -> create one { goal, useCase, about, label, cadence, maxFinds }
// DELETE -> remove one { id }

export async function GET(req: NextRequest) {
  const me = await userFromReq(req);
  if (!me || !supabaseAdmin) {
    return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  }
  const { data, error } = await supabaseAdmin
    .from("auto_searches")
    .select("id, goal, label, cadence, email_digest, max_finds, active, next_run_at, last_run_at, created_at")
    .eq("user_id", me.id)
    .order("created_at", { ascending: false });
  if (error) return NextResponse.json({ items: [], error: error.message });
  return NextResponse.json({ items: data || [] });
}

export async function POST(req: NextRequest) {
  const me = await userFromReq(req);
  if (!me || !supabaseAdmin) {
    return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  const goal = String(body?.goal || "").trim();
  if (!goal) {
    return NextResponse.json({ error: "A goal is required." }, { status: 400 });
  }
  const cadence = body?.cadence === "weekly" ? "weekly" : "daily";
  const emailDigest = body?.emailDigest !== false; // default on ("auto emails")
  const maxFinds = Math.min(Math.max(Number(body?.maxFinds) || 5, 1), 10);

  // Require a connected mailbox — that's how the digest reaches them.
  const [gmail, outlook] = await Promise.all([
    supabaseAdmin.from("gmail_connections").select("email").eq("user_id", me.id).maybeSingle(),
    supabaseAdmin.from("outlook_connections").select("email").eq("user_id", me.id).maybeSingle(),
  ]);
  const mailbox = gmail.data?.email || outlook.data?.email || me.email;
  if (!gmail.data && !outlook.data) {
    return NextResponse.json(
      { error: "Connect Gmail or Outlook first — that's how Scout emails you the finds." },
      { status: 400 }
    );
  }

  const { data, error } = await supabaseAdmin
    .from("auto_searches")
    .insert({
      user_id: me.id,
      email: String(mailbox || me.email || "").toLowerCase(),
      goal,
      use_case: String(body?.useCase || "").slice(0, 120),
      about: String(body?.about || "").slice(0, 2000),
      label: String(body?.label || "").slice(0, 120),
      max_finds: maxFinds,
      cadence,
      email_digest: emailDigest,
      // First run in ~2 minutes, so the user sees it work without waiting a day.
      next_run_at: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
    })
    .select("id")
    .single();
  if (error) {
    return NextResponse.json({ error: `Couldn't save: ${error.message}` }, { status: 500 });
  }
  return NextResponse.json({ ok: true, id: data.id });
}

export async function DELETE(req: NextRequest) {
  const me = await userFromReq(req);
  if (!me || !supabaseAdmin) {
    return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  const id = String(body?.id || "");
  if (!id) return NextResponse.json({ error: "Missing id." }, { status: 400 });
  const { error } = await supabaseAdmin
    .from("auto_searches")
    .delete()
    .eq("id", id)
    .eq("user_id", me.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
