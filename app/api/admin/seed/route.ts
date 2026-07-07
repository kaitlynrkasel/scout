import { NextResponse } from "next/server";
import { supabaseAdmin, userFromReq } from "@/lib/supabaseAdmin";
import { isOwnerEmail } from "@/lib/owner";
import type { Opportunity } from "@/lib/types";

export const maxDuration = 30;
export const dynamic = "force-dynamic";

// Fill a partial opportunity (from manual entry or a run-search result) into a
// complete Opportunity so the client can merge it exactly like a real find.
function normalizeOpp(raw: any): Opportunity | null {
  const name = String(raw?.name || raw?.contactName || "").trim();
  const url = String(raw?.url || "").trim();
  if (!name && !url) return null; // need at least a name or a link to be a find
  return {
    id: String(raw?.id || ""),
    name: name || url,
    outlet: String(raw?.outlet || ""),
    url,
    channel: String(raw?.channel || (raw?.contactEmail ? "Email" : "")),
    contactEmail: String(raw?.contactEmail || ""),
    contactName: String(raw?.contactName || ""),
    contactRole: String(raw?.contactRole || ""),
    contactHandle: String(raw?.contactHandle || ""),
    contactPhone: String(raw?.contactPhone || ""),
    location: String(raw?.location || ""),
    fitScore: typeof raw?.fitScore === "number" ? raw.fitScore : 0.75,
    scores: raw?.scores,
    signals: Array.isArray(raw?.signals) ? raw.signals : undefined,
    targetType: raw?.targetType,
    whyItFits: String(raw?.whyItFits || ""),
    sourceTitle: String(raw?.sourceTitle || raw?.outlet || ""),
    sourceSnippet: String(raw?.sourceSnippet || ""),
    sources: Array.isArray(raw?.sources) ? raw.sources : undefined,
  };
}

// POST /api/admin/seed — owner-only. Queues one or more opportunities for a
// target email. They wait in admin_seeded_finds until that user's client pulls
// them (next load / next search) via /api/seeded-finds. Works whether or not
// the email has an account yet — that's how we prep before signup.
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

  const body = await req.json().catch(() => ({}));
  const email = String(body?.email || "").trim().toLowerCase();
  const note = body?.note ? String(body.note).slice(0, 500) : null;
  const rawOpps: any[] = Array.isArray(body?.opportunities) ? body.opportunities : [];
  if (!email || !/.+@.+\..+/.test(email)) {
    return NextResponse.json({ error: "A valid target email is required." }, { status: 400 });
  }
  const opps = rawOpps.map(normalizeOpp).filter(Boolean) as Opportunity[];
  if (!opps.length) {
    return NextResponse.json({ error: "No valid opportunities to seed." }, { status: 400 });
  }

  const rows = opps.map((opp) => ({
    email,
    opp,
    note,
    created_by: me.email,
  }));
  const { data, error } = await supabaseAdmin
    .from("admin_seeded_finds")
    .insert(rows)
    .select("id");
  if (error) {
    return NextResponse.json(
      { error: `Failed to seed: ${error.message}` },
      { status: 500 }
    );
  }
  return NextResponse.json({ ok: true, seeded: data?.length || 0 });
}
