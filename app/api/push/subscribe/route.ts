import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, userIdFromReq } from "@/lib/supabaseAdmin";
import { pushConfigured } from "@/lib/push";

export const runtime = "nodejs";

// Whether this account has notifications turned on anywhere, and whether the
// server can send them at all — the toggle needs both to render honestly.
export async function GET(req: NextRequest) {
  const uid = await userIdFromReq(req);
  if (!uid || !supabaseAdmin) {
    return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  }
  const { data } = await supabaseAdmin
    .from("push_subscriptions")
    .select("id, label, created_at")
    .eq("user_id", uid)
    .is("expired_at", null);
  return NextResponse.json({
    configured: pushConfigured(),
    devices: data?.length || 0,
  });
}

// Store a browser's subscription. Upserts on the endpoint, so re-enabling on a
// device that already subscribed updates that row instead of adding another.
export async function POST(req: NextRequest) {
  const uid = await userIdFromReq(req);
  if (!uid || !supabaseAdmin) {
    return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  const sub = body?.subscription;
  const endpoint = String(sub?.endpoint || "");
  const p256dh = String(sub?.keys?.p256dh || "");
  const auth = String(sub?.keys?.auth || "");
  if (!endpoint || !p256dh || !auth) {
    return NextResponse.json({ error: "That subscription is incomplete." }, { status: 400 });
  }

  const { error } = await supabaseAdmin.from("push_subscriptions").upsert(
    {
      user_id: uid,
      endpoint,
      p256dh,
      auth,
      label: String(body?.label || "").slice(0, 80) || null,
      // Re-subscribing revives a row a push service had previously rejected.
      expired_at: null,
    },
    { onConflict: "endpoint" }
  );
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

// Turn notifications off for this device. The browser drops its own
// subscription separately; this clears our side so nothing is sent to an
// endpoint the user has opted out of.
export async function DELETE(req: NextRequest) {
  const uid = await userIdFromReq(req);
  if (!uid || !supabaseAdmin) {
    return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  const endpoint = String(body?.endpoint || "");
  let q = supabaseAdmin.from("push_subscriptions").delete().eq("user_id", uid);
  // No endpoint means "all my devices" — what Settings sends when the toggle
  // goes off without a live subscription to name.
  if (endpoint) q = q.eq("endpoint", endpoint);
  const { error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
