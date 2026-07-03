import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, userIdFromReq } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";

// Set whether Scout should create a draft the user reviews, or send directly.
export async function POST(req: NextRequest) {
  const uid = await userIdFromReq(req);
  if (!uid || !supabaseAdmin) {
    return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  }
  const { mode } = await req.json();
  if (mode !== "draft" && mode !== "send") {
    return NextResponse.json({ error: "Invalid mode." }, { status: 400 });
  }
  const { error } = await supabaseAdmin
    .from("outlook_connections")
    .update({ send_mode: mode, updated_at: new Date().toISOString() })
    .eq("user_id", uid);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, mode });
}
