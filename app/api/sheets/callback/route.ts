import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { reqOrigin, verifyState } from "@/lib/gmail";
import { sheetsExchangeCode, emailFromIdToken } from "@/lib/googleSheets";

export const runtime = "nodejs";

// Google redirects here after the user grants Sheets access. Exchange the code
// for a refresh token and store it, then bounce back to the app.
export async function GET(req: NextRequest) {
  const origin = reqOrigin(req);
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state") || "";
  const back = (path: string) => NextResponse.redirect(`${origin}/app?${path}`);

  if (url.searchParams.get("error")) return back("sheets=denied");
  const uid = verifyState(state);
  if (!code || !uid) return back("sheets=error");
  if (!supabaseAdmin) return back("sheets=error");

  try {
    const tok = await sheetsExchangeCode(origin, code);
    const email = tok.id_token ? emailFromIdToken(tok.id_token) : "";
    if (!tok.refresh_token) {
      // Google only returns a refresh token on first consent; prompt=consent
      // forces it, so this is rare — surface it rather than store a blank.
      return back("sheets=noRefresh");
    }
    await supabaseAdmin.from("sheets_connections").upsert(
      {
        user_id: uid,
        email,
        refresh_token: tok.refresh_token,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    );
    return back("sheets=connected");
  } catch {
    return back("sheets=error");
  }
}
