import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, userIdFromReq } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";

// Is Outlook connected for this user, and in which send mode? Never returns tokens.
export async function GET(req: NextRequest) {
  const uid = await userIdFromReq(req);
  if (!uid || !supabaseAdmin) return NextResponse.json({ connected: false });
  const { data } = await supabaseAdmin
    .from("outlook_connections")
    .select("email, send_mode")
    .eq("user_id", uid)
    .maybeSingle();
  if (!data) return NextResponse.json({ connected: false });
  return NextResponse.json({
    connected: true,
    email: data.email || "",
    sendMode: data.send_mode || "draft",
  });
}
