import { NextRequest, NextResponse } from "next/server";
import { userIdFromReq } from "@/lib/supabaseAdmin";
import { reqOrigin, signState } from "@/lib/gmail";
import { sheetsAuthUrl } from "@/lib/googleSheets";

export const runtime = "nodejs";

// Start the Google Sheets connect flow: returns the consent URL to redirect to.
export async function POST(req: NextRequest) {
  const uid = await userIdFromReq(req);
  if (!uid) return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  if (!process.env.GOOGLE_CLIENT_ID) {
    return NextResponse.json({ error: "Google isn't configured on the server yet." }, { status: 500 });
  }
  const url = sheetsAuthUrl(reqOrigin(req), signState(uid));
  return NextResponse.json({ url });
}
