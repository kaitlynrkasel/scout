import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, userIdFromReq } from "@/lib/supabaseAdmin";
import { gmailThreadsWithReplies } from "@/lib/gmail";

export const runtime = "nodejs";
export const maxDuration = 30;

// Check which of the user's tracked Gmail threads have a reply. Metadata-only
// reads (From headers), never message bodies. Returns the find ids that replied.
export async function POST(req: NextRequest) {
  const uid = await userIdFromReq(req);
  if (!uid || !supabaseAdmin) {
    return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  }
  const { threads } = await req.json();
  const list = (Array.isArray(threads) ? threads : [])
    .filter((t: any) => t?.id && t?.threadId)
    .slice(0, 20);
  if (!list.length) return NextResponse.json({ replied: [] });

  const { data } = await supabaseAdmin
    .from("gmail_connections")
    .select("email, refresh_token")
    .eq("user_id", uid)
    .maybeSingle();
  if (!data?.refresh_token) {
    return NextResponse.json({ error: "Connect Gmail first." }, { status: 400 });
  }

  try {
    const repliedThreads = await gmailThreadsWithReplies(
      data.refresh_token,
      data.email || "",
      list.map((t: any) => String(t.threadId))
    );
    const replied = list
      .filter((t: any) => repliedThreads.has(String(t.threadId)))
      .map((t: any) => String(t.id));
    return NextResponse.json({ replied, checked: list.length });
  } catch (e: any) {
    if (e?.needsReconnect) {
      return NextResponse.json(
        {
          error:
            "Reply tracking needs one extra permission. Disconnect and reconnect Gmail in your Profile to enable it.",
          needsReconnect: true,
        },
        { status: 403 }
      );
    }
    return NextResponse.json(
      { error: e?.message || "Couldn't check for replies." },
      { status: 502 }
    );
  }
}
