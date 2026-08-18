import { NextRequest, NextResponse } from "next/server";
import { userFromReq } from "@/lib/supabaseAdmin";
import { signPreviewToken, PREVIEW_TOKEN_TTL_MS } from "@/lib/previewToken";

export const runtime = "nodejs";

// Mint a short-lived token that lets THIS signed-in user's iframes load
// /api/site-preview (iframes can't send Authorization headers). Without one,
// the preview proxy refuses to fetch, which is what keeps it from being an
// open proxy anyone on the internet can launder requests through.
export async function GET(req: NextRequest) {
  const u = await userFromReq(req);
  if (!u) return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  return NextResponse.json({ t: signPreviewToken(u.id), ttlMs: PREVIEW_TOKEN_TTL_MS });
}
