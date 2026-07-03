import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { exchangeCode, verifyState, emailFromIdToken, reqOrigin } from "@/lib/outlook";

export const runtime = "nodejs";

// Microsoft redirects here after the user consents. We exchange the code for a
// refresh token, store it against the user, and bounce back into the app.
export async function GET(req: NextRequest) {
  const origin = reqOrigin(req);
  const back = (s: string) => NextResponse.redirect(`${origin}/app?outlook=${s}`);

  if (req.nextUrl.searchParams.get("error")) return back("error");
  const code = req.nextUrl.searchParams.get("code") || "";
  const state = req.nextUrl.searchParams.get("state") || "";
  const uid = verifyState(state);
  if (!uid || !code || !supabaseAdmin) return back("error");

  try {
    const tok = await exchangeCode(origin, code);
    if (!tok.refresh_token) return back("norefresh");
    const email = emailFromIdToken(tok.id_token || "");
    const { error } = await supabaseAdmin.from("outlook_connections").upsert(
      {
        user_id: uid,
        email,
        refresh_token: tok.refresh_token,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    );
    if (error) return back("error");
    return back("connected");
  } catch {
    return back("error");
  }
}
