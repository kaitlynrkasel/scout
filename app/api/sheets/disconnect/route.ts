import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, userIdFromReq } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const uid = await userIdFromReq(req);
  if (!uid || !supabaseAdmin) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  await supabaseAdmin.from("sheets_connections").delete().eq("user_id", uid);
  return NextResponse.json({ ok: true });
}
