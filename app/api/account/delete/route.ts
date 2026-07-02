import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, userIdFromReq } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";

// Permanently delete the signed-in user's account and all their data. The user
// triggers this themselves from the Account section; the client signs out after.
export async function POST(req: NextRequest) {
  const uid = await userIdFromReq(req);
  if (!uid || !supabaseAdmin) {
    return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  }
  try {
    // Remove their data first, then the auth record.
    await supabaseAdmin.from("gmail_connections").delete().eq("user_id", uid);
    await supabaseAdmin.from("user_state").delete().eq("user_id", uid);
    await supabaseAdmin.from("profiles").delete().eq("id", uid);
    const { error } = await supabaseAdmin.auth.admin.deleteUser(uid);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || "Couldn't delete the account." },
      { status: 500 }
    );
  }
}
