import { NextResponse } from "next/server";
import { discover } from "@/lib/discover";
import { supabaseAdmin, userFromReq } from "@/lib/supabaseAdmin";
import { isOwnerEmail } from "@/lib/owner";

export const maxDuration = 300; // discover chains several Tavily + Claude passes
export const dynamic = "force-dynamic";

// Compose a short "about the user" grounding string from their profile + state,
// so a concierge search runs with the same context their own searches would.
function aboutFor(prof: any, data: any): string {
  const bits: string[] = [];
  const name = String(prof?.name || data?.profileExtras?.companyName || "").trim();
  if (name) bits.push(name);
  const bio = String(prof?.bio || "").trim();
  if (bio) bits.push(bio);
  const ex = (data?.profileExtras || {}) as any;
  if (ex.companyAbout) bits.push(String(ex.companyAbout));
  if (ex.companyIndustry) bits.push(`Industry: ${ex.companyIndustry}.`);
  if (ex.companyStage) bits.push(`Stage: ${ex.companyStage}.`);
  if (ex.location) bits.push(`Based in ${ex.location}.`);
  // The active project's context often holds the sharpest "who this is for" line.
  const projects: any[] = Array.isArray(data?.projects) ? data.projects : [];
  const active = projects.find((p) => p.id === data?.activeId) || projects[0];
  if (active?.context) bits.push(String(active.context));
  return bits.join(" ").slice(0, 1200);
}

// POST /api/admin/run-search — owner-only. Runs the discovery engine for a
// target account (grounding the search in that user's own profile/context when
// they have one) and returns the opportunities for the operator to review and
// selectively seed. Does NOT consume anyone's search credits and does NOT save
// anything — seeding is a separate, explicit step (/api/admin/seed).
export async function POST(req: Request) {
  const me = await userFromReq(req);
  if (!me || !isOwnerEmail(me.email)) {
    return NextResponse.json({ error: "Not authorized." }, { status: 403 });
  }
  if (!supabaseAdmin) {
    return NextResponse.json(
      { error: "Supabase service role key not configured." },
      { status: 500 }
    );
  }
  if (!process.env.TAVILY_API_KEY || !process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "Search keys (TAVILY_API_KEY / ANTHROPIC_API_KEY) not configured." },
      { status: 500 }
    );
  }

  const body = await req.json().catch(() => ({}));
  const email = String(body?.email || "").trim().toLowerCase();
  const goal = String(body?.goal || "").trim();
  const maxItems = Math.min(Math.max(Number(body?.maxItems) || 8, 1), 12);
  if (!goal) {
    return NextResponse.json({ error: "Enter a goal to search for." }, { status: 400 });
  }

  // Ground the search in the target account's context when we can find one.
  let about = "";
  let useCase = String(body?.useCase || "").trim();
  if (email) {
    const authRes = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 });
    const user = (authRes?.data?.users || []).find(
      (u) => String(u.email || "").toLowerCase() === email
    );
    if (user) {
      const [profRes, stateRes] = await Promise.all([
        supabaseAdmin.from("profiles").select("name, bio, use_case").eq("id", user.id).maybeSingle(),
        supabaseAdmin.from("user_state").select("data").eq("user_id", user.id).maybeSingle(),
      ]);
      const prof = profRes.data || {};
      const data = (stateRes.data?.data || {}) as any;
      about = aboutFor(prof, data);
      if (!useCase) useCase = String((prof as any).use_case || "");
    }
  }
  if (!useCase) useCase = "networking";

  try {
    const result = await discover(goal, about, useCase, maxItems);
    return NextResponse.json({
      opportunities: result.opportunities,
      searched: result.searched,
      candidates: result.candidates,
      notice: result.notice || null,
      about,
      useCase,
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || "Search failed." },
      { status: 502 }
    );
  }
}
