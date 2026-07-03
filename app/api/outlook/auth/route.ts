import { NextRequest, NextResponse } from "next/server";
import { userIdFromReq } from "@/lib/supabaseAdmin";
import { authUrl, signState, reqOrigin } from "@/lib/outlook";

export const runtime = "nodejs";

// Start the Outlook connect flow: returns the Microsoft consent URL to redirect to.
export async function POST(req: NextRequest) {
  const uid = await userIdFromReq(req);
  if (!uid) {
    return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  }
  if (!process.env.MICROSOFT_CLIENT_ID) {
    return NextResponse.json(
      { error: "Outlook isn't configured on the server yet." },
      { status: 500 }
    );
  }
  const url = authUrl(reqOrigin(req), signState(uid));
  return NextResponse.json({ url });
}
