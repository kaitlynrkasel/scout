import { NextRequest, NextResponse } from "next/server";
import { userFromReq } from "@/lib/supabaseAdmin";
import { redeemCompanyCode, TeamError } from "@/lib/teams";

export const runtime = "nodejs";

// Owner: redeem a company promo code to comp the whole team. POST { workspaceId, code }.
export async function POST(req: NextRequest) {
  const u = await userFromReq(req);
  if (!u) return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  try {
    const { workspaceId, code } = await req.json();
    const r = await redeemCompanyCode(u.id, String(workspaceId || ""), String(code || ""));
    return NextResponse.json(r);
  } catch (e: any) {
    const status = e instanceof TeamError ? e.status : 500;
    return NextResponse.json({ error: e?.message || "Failed." }, { status });
  }
}
