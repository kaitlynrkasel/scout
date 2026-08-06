import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { verifyAction } from "@/lib/autoSearch";
import { draftFor } from "@/lib/draft";
import type { Opportunity } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Tap "Approve" in a digest email -> this drafts the outreach for that contact
// (in the user's voice, with their templates + signature) and returns it for
// editing on the /auto/draft page. Also records the approval. No login: the
// signed token from the email is the authorization.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const parsed = verifyAction(String(body?.t || ""));
  if (!parsed) return NextResponse.json({ error: "This link couldn't be verified." }, { status: 401 });
  if (!supabaseAdmin) return NextResponse.json({ error: "Not configured." }, { status: 500 });

  const { findId } = parsed;
  const { data: row } = await supabaseAdmin
    .from("auto_finds")
    .select("id, user_id, status, opp")
    .eq("id", findId)
    .maybeSingle();
  if (!row) return NextResponse.json({ error: "That find is no longer available." }, { status: 404 });

  const opp = ((row as any).opp || {}) as Opportunity;
  const uid = (row as any).user_id as string;

  // Record the approval (idempotent).
  if ((row as any).status === "new") {
    await supabaseAdmin
      .from("auto_finds")
      .update({ status: "approved", decided_at: new Date().toISOString() })
      .eq("id", findId);
  }

  // Sender identity + voice, from the user's saved profile + app state.
  const prof = await supabaseAdmin
    .from("profiles")
    .select("name, bio, use_case")
    .eq("id", uid)
    .maybeSingle();
  const st = await supabaseAdmin
    .from("user_state")
    .select("data")
    .eq("user_id", uid)
    .maybeSingle();
  const data = (st.data?.data || {}) as any;
  const about = String(prof.data?.bio || "");
  const useCase = String(prof.data?.use_case || "networking");
  const senderName = String(prof.data?.name || "");
  const templates = Array.isArray(data.templates) ? data.templates : [];
  const signature = typeof data.signature === "string" ? data.signature : "";

  const canEmail = !!(opp.contactEmail && /.+@.+\..+/.test(opp.contactEmail));

  let draft: any = null;
  try {
    draft = await draftFor(opp, about, useCase, {
      templates,
      signature,
      senderName,
      editPairs: Array.isArray(data.editPairs) ? data.editPairs : [],
      coaching: Array.isArray(data.coaching) ? data.coaching : [],
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Couldn't draft that." }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    name: opp.name || "this contact",
    role: opp.contactRole || "",
    outlet: opp.outlet || "",
    to: opp.contactEmail || "",
    handle: opp.contactHandle || "",
    url: opp.url || "",
    channelType: draft?.channelType || (canEmail ? "email" : "message"),
    canEmail,
    subject: draft?.subject || "",
    draftBody: draft?.body || "",
  });
}
