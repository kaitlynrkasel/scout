import { NextResponse } from "next/server";
import { userFromReq } from "@/lib/supabaseAdmin";
import { isOwnerEmail } from "@/lib/owner";

// Lightweight probe used by the client to decide whether to render the
// Insights nav item. Never leaks the allowlist, just says "you, in
// particular, either are or aren't an owner."
export async function GET(req: Request) {
  const me = await userFromReq(req);
  return NextResponse.json({ owner: !!(me && isOwnerEmail(me.email)) });
}
