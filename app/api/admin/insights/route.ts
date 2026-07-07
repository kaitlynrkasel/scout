import { NextResponse } from "next/server";
import { supabaseAdmin, userFromReq } from "@/lib/supabaseAdmin";
import { isOwnerEmail } from "@/lib/owner";
import { bucketDenyReason } from "@/lib/denyBuckets";

export const maxDuration = 60; // walks every user_state row; scales with user count
export const dynamic = "force-dynamic";

// GET /api/admin/insights, owner-only aggregate across every user's AppState.
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

  // Three sources, in parallel: state blobs, profile use_case/name per user,
  // and the auth directory (for email + who to actually recognize a top user by).
  const [statesRes, profilesRes, authRes] = await Promise.all([
    supabaseAdmin.from("user_state").select("user_id, data, updated_at"),
    supabaseAdmin.from("profiles").select("id, use_case, name"),
    supabaseAdmin.auth.admin.listUsers({ perPage: 1000 }),
  ]);

  if (statesRes.error) {
    return NextResponse.json(
      { error: `Failed to load user_state: ${statesRes.error.message}` },
      { status: 500 }
    );
  }
  const useCaseByUser = new Map<string, string>();
  const nameByUser = new Map<string, string>();
  for (const p of profilesRes.data || []) {
    useCaseByUser.set((p as any).id, String((p as any).use_case || ""));
    if ((p as any).name) nameByUser.set((p as any).id, String((p as any).name));
  }
  const emailByUser = new Map<string, string>();
  for (const u of authRes?.data?.users || []) {
    if (u.email) emailByUser.set(u.id, u.email);
  }

  const totals = {
    users: 0,
    users_with_state_rows: 0, // every row in user_state, even ones with no finds
    finds: 0,
    new: 0,
    denied: 0,
    approved: 0,
    drafted: 0,
    sent: 0,
    replied: 0,
  };
  // Per-user drill-down so we can spot whose data isn't landing in the
  // aggregate AND rank the most active users. Includes rows even if their
  // finds array is missing/empty. `searches`/`drafts`/`copies` come from the
  // activity blob (the real engagement signal); finds/sent/replied are counted
  // off the finds array below.
  const perUser: Array<{
    userId: string;
    label: string; // email or name if known, else truncated id
    searches: number;
    drafts: number;
    copies: number;
    finds: number;
    denied: number;
    approved: number;
    sent: number;
    replied: number;
    updatedAt: string;
    hasFindsField: boolean;
    useCase: string;
  }> = [];
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
    const updatedAt = String((row as any).updated_at || "");
    const uc = useCaseByUser.get(uid) || "";
    totals.users_with_state_rows++;
    const hasFindsField = Array.isArray(data?.finds);
    const finds: any[] = hasFindsField ? data.finds : [];
    const activity = (data?.activity || {}) as any;
    let userDenied = 0;
    let userApproved = 0;
    let userSent = 0;
    let userReplied = 0;
    for (const f of finds) {
      const status = String(f?.status || "").toLowerCase();
      if (status === "denied") userDenied++;
      else if (status === "drafted" || status === "sent" || status === "replied") userApproved++;
      if (status === "sent") userSent++;
      else if (status === "replied") userReplied++;
    }
    perUser.push({
      userId: uid.slice(0, 8) + "…",
      label: emailByUser.get(uid) || nameByUser.get(uid) || uid.slice(0, 8) + "…",
      searches: Number(activity?.searches || 0),
      drafts: Number(activity?.drafts || 0),
      copies: Number(activity?.copies || 0),
      finds: finds.length,
      denied: userDenied,
      approved: userApproved,
      sent: userSent,
      replied: userReplied,
      updatedAt,
      hasFindsField,
      useCase: uc,
    });
    if (!finds.length) continue;
    totals.users++;
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
        // Group by concept so "Wrong industry" + its elaborated/typo'd variants
        // count as one row instead of scattering (matches the user dashboard).
        const reason = bucketDenyReason(String(f?.denyReason || ""));
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

  // "How much the average user uses the platform." Averaged over ACTIVE users
  // (at least one search or one find) so people who signed up but never ran
  // anything don't drag the mean to zero. Mean and median both, since a few
  // power users skew the mean.
  const active = perUser.filter((u) => u.searches > 0 || u.finds > 0);
  const mean = (get: (u: (typeof perUser)[number]) => number) =>
    active.length ? active.reduce((s, u) => s + get(u), 0) / active.length : 0;
  const median = (get: (u: (typeof perUser)[number]) => number) => {
    if (!active.length) return 0;
    const arr = active.map(get).sort((a, b) => a - b);
    const mid = Math.floor(arr.length / 2);
    return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
  };
  const round1 = (n: number) => Math.round(n * 10) / 10;
  const averages = {
    activeUsers: active.length,
    totalUsers: totals.users_with_state_rows,
    meanSearches: round1(mean((u) => u.searches)),
    medianSearches: round1(median((u) => u.searches)),
    meanFinds: round1(mean((u) => u.finds)),
    medianFinds: round1(median((u) => u.finds)),
    meanDrafts: round1(mean((u) => u.drafts)),
    meanSent: round1(mean((u) => u.sent)),
    meanReplied: round1(mean((u) => u.replied)),
  };

  // Top users by engagement: searches run is the truest intent signal, with
  // finds as the tiebreak. Capped so the response stays lean.
  const topUsers = perUser
    .slice()
    .sort((a, b) => b.searches - a.searches || b.finds - a.finds)
    .slice(0, 25);

  return NextResponse.json({
    totals,
    averages,
    topUsers,
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
    perUser: perUser.sort((a, b) => b.finds - a.finds),
    generatedAt: new Date().toISOString(),
  });
}
