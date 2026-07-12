import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, userIdFromReq } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";

// Is Google Sheets connected for this user? (Returns the connected email.)
export async function GET(req: NextRequest) {
  const uid = await userIdFromReq(req);
  if (!uid || !supabaseAdmin) return NextResponse.json({ connected: false });
  const { data } = await supabaseAdmin
    .from("sheets_connections")
    .select("email")
    .eq("user_id", uid)
    .maybeSingle();
  return NextResponse.json({ connected: !!data, email: data?.email || "" });
}
