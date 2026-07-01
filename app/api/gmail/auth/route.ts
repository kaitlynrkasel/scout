import { NextRequest, NextResponse } from "next/server";
import { userIdFromReq } from "@/lib/supabaseAdmin";
import { authUrl, signState, reqOrigin } from "@/lib/gmail";

export const runtime = "nodejs";

// Start the Gmail connect flow: returns the Google consent URL to redirect to.
export async function POST(req: NextRequest) {
  const uid = await userIdFromReq(req);
  if (!uid) {
    return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  }
  if (!process.env.GOOGLE_CLIENT_ID) {
    return NextResponse.json(
      { error: "Gmail isn't configured on the server yet." },
      { status: 500 }
    );
  }
  const url = authUrl(reqOrigin(req), signState(uid));
  return NextResponse.json({ url });
}
