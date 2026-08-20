import { NextRequest, NextResponse } from "next/server";
import { userFromReq } from "@/lib/supabaseAdmin";
import { upsertImportedBusinessContacts } from "@/lib/peopleIndex";
import { withinRateLimit } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Imported contacts headed for the SHARED index. Only published business
// routes survive the filter in upsertImportedBusinessContacts; everything else
// stays private to the importing account.
export async function POST(req: NextRequest) {
  const u = await userFromReq(req);
  if (!u) return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  if (!withinRateLimit(`idximp:${u.id}`, 40, 60 * 60 * 1000)) {
    return NextResponse.json({ error: "Too many imports this hour." }, { status: 429 });
  }
  try {
    const body = await req.json();
    const opps = Array.isArray(body?.opps) ? body.opps.slice(0, 200) : [];
    const shared = await upsertImportedBusinessContacts(opps);
    return NextResponse.json({ shared });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Failed." }, { status: 500 });
  }
}
