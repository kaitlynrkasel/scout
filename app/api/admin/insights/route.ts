import { NextResponse } from "next/server";
import { supabaseAdmin, userFromReq } from "@/lib/supabaseAdmin";
import { isOwnerEmail } from "@/lib/owner";

export const maxDuration = 30;
export const dynamic = "force-dynamic";

// GET /api/admin/insights — owner-only aggregate across every user's AppState.
// Walks the user_state table, parses each row's `finds` array, and tallies
// denials, approvals, deny reasons, top denied hosts, per-use-case rates, and
// the raw denial list (capped) so we can tune the extract + filter logic
// against real signal instead of guessing.
export async function GET(req: Request) {
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

  // Two queries, in parallel: state blobs + profile use_case per user.
  const [statesRes, profilesRes] = await Promise.all([
    supabaseAdmin.from("user_state").select("user_id, data, updated_at"),
    supabaseAdmin.from("profiles").select("id, use_case"),
  ]);

  if (statesRes.error) {
    return NextResponse.json(
      { error: `Failed to load user_state: ${statesRes.error.message}` },
      { status: 500 }
    );
  }
  const useCaseByUser = new Map<string, string>();
  for (const p of profilesRes.data || []) {
    useCaseByUser.set((p as any).id, String((p as any).use_case || ""));
  }

  const totals = {
    users: 0,
    finds: 0,
    new: 0,
    denied: 0,
    approved: 0,
    drafted: 0,
    sent: 0,
    replied: 0,
  };
  const reasonCounts = new Map<string, number>();
  const reasonExamples = new Map<string, string[]>();
  const hostCounts = new Map<string, number>();
  const byUseCase = new Map<string, { total: number; denied: number }>();
  const denials: Array<{
    name: string;
    host: string;
    url: string;
    reason: string;
    useCase: string;
    addedAt: number;
  }> = [];

  for (const row of statesRes.data || []) {
    const uid = (row as any).user_id as string;
    const data = ((row as any).data || {}) as any;
    const finds: any[] = Array.isArray(data?.finds) ? data.finds : [];
    if (!finds.length) continue;
    totals.users++;
    const uc = useCaseByUser.get(uid) || "";
    for (const f of finds) {
      totals.finds++;
      const status = String(f?.status || "").toLowerCase();
      if (status === "denied") totals.denied++;
      else if (status === "sent") {
        totals.sent++;
        totals.approved++;
      } else if (status === "drafted") {
        totals.drafted++;
        totals.approved++;
      } else if (status === "replied") {
        totals.replied++;
        totals.approved++;
      } else totals.new++;

      const bucket = byUseCase.get(uc) || { total: 0, denied: 0 };
      bucket.total++;
      if (status === "denied") bucket.denied++;
      byUseCase.set(uc, bucket);

      if (status === "denied") {
        const reason = String(f?.denyReason || "").trim() || "(no reason given)";
        reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
        const ex = reasonExamples.get(reason) || [];
        if (ex.length < 3) {
          const name = String(f?.opp?.name || "").trim();
          if (name && !ex.includes(name)) ex.push(name);
          reasonExamples.set(reason, ex);
        }
        const url = String(f?.opp?.url || "");
        const m = url.match(/^https?:\/\/([^/?#]+)/i);
        const host = m ? m[1].replace(/^www\./, "").toLowerCase() : "";
        if (host) hostCounts.set(host, (hostCounts.get(host) || 0) + 1);
        denials.push({
          name: String(f?.opp?.name || ""),
          host,
          url,
          reason,
          useCase: uc,
          addedAt: Number(f?.addedAt || 0),
        });
      }
    }
  }

  const denyReasons = Array.from(reasonCounts.entries())
    .map(([reason, count]) => ({
      reason,
      count,
      examples: reasonExamples.get(reason) || [],
    }))
    .sort((a, b) => b.count - a.count);

  const denyByHost = Array.from(hostCounts.entries())
    .map(([host, count]) => ({ host, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  const denyRateByUseCase = Array.from(byUseCase.entries())
    .map(([useCase, { total, denied }]) => ({
      useCase: useCase || "(unset)",
      total,
      denied,
      rate: total ? denied / total : 0,
    }))
    .sort((a, b) => b.rate - a.rate);

  // Newest denials first, capped so the response stays small.
  denials.sort((a, b) => b.addedAt - a.addedAt);
  const denialsCapped = denials.slice(0, 200);

  return NextResponse.json({
    totals,
    denyReasons,
    denyByHost,
    denyRateByUseCase,
    funnel: {
      finds: totals.finds,
      drafted: totals.approved,
      sent: totals.sent,
      replied: totals.replied,
    },
    denials: denialsCapped,
    generatedAt: new Date().toISOString(),
  });
}
