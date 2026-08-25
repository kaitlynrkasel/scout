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
  const [statesRes, profilesRes, authRes, histRes] = await Promise.all([
    supabaseAdmin.from("user_state").select("user_id, data, updated_at"),
    supabaseAdmin.from("profiles").select("id, use_case, name"),
    supabaseAdmin.auth.admin.listUsers({ perPage: 1000 }),
    supabaseAdmin
      .from("search_history")
      .select("user_id, goal, created_at")
      .order("created_at", { ascending: false })
      .limit(5000),
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

  // Timestamps for the weekly trend: when finds landed and when messages went
  // out, straight off the finds arrays.
  const findStamps: number[] = [];
  const sentStamps: number[] = [];

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

  // Algorithm health, in plain numbers a non-engineer can read. Collected
  // during the same walk over every find.
  const algo = {
    searchFinds: 0, // finds Scout discovered itself (not manual/import)
    withContact: 0, // of those, arrived with a real way to reach them
    fitSum: 0,
    fitCount: 0,
    fitHigh: 0, // fit >= 80%
    bounced: 0,
    runs: 0, // search runs, reconstructed from add-time clusters
    runsAtFloor: 0, // runs that met the 5-find floor
    runFindSum: 0,
  };
  const runBuckets = new Map<string, number>();

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
      {
        const added = Number(f?.addedAt || 0);
        if (added > 0) findStamps.push(added);
        const sentAt = Number(f?.sentAt || 0);
        if (sentAt > 0) sentStamps.push(sentAt);
      }
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

      {
        const via = String(f?.foundVia || "search");
        if (via === "search" || via === "auto-search") {
          algo.searchFinds++;
          const o = f?.opp || {};
          if (String(o.contactEmail || "").includes("@") || String(o.contactHandle || "").trim())
            algo.withContact++;
          const fit = Number(o.fitScore);
          if (Number.isFinite(fit) && fit > 0) {
            algo.fitSum += fit;
            algo.fitCount++;
            if (fit >= 0.8) algo.fitHigh++;
          }
          const added = Number(f?.addedAt || 0);
          if (added > 0) {
            // Finds added by one user within the same 10 minutes = one run.
            const key = `${uid}:${Math.floor(added / 600000)}`;
            runBuckets.set(key, (runBuckets.get(key) || 0) + 1);
          }
        }
        if (f?.bounced) algo.bounced++;
      }

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

  // ---- Growth health: the numbers a founder dashboard actually runs on ----
  // (activation funnel by USERS, weekly trend, signups, WAU/MAU). Modeled on
  // the standard early-stage playbook: activation and retention signals first,
  // revenue-era metrics later.
  const now = Date.now();
  const WEEK = 7 * 86400000;
  const weekKey = (t: number) => {
    const d = new Date(t);
    // ISO-ish week label: the Monday of that week, shown as M/D.
    const day = (d.getDay() + 6) % 7;
    const mon = new Date(d.getTime() - day * 86400000);
    return `${mon.getMonth() + 1}/${mon.getDate()}`;
  };
  const weeks: string[] = [];
  for (let i = 7; i >= 0; i--) weeks.push(weekKey(now - i * WEEK));
  const inWeek = (t: number, label: string) => weekKey(t) === label;
  const trend = weeks.map((label) => ({
    week: label,
    finds: findStamps.filter((t) => inWeek(t, label)).length,
    sent: sentStamps.filter((t) => inWeek(t, label)).length,
  }));

  const authUsers = authRes?.data?.users || [];
  const signupsByWeek = weeks.map((label) => ({
    week: label,
    signups: authUsers.filter((u) => inWeek(new Date(u.created_at).getTime(), label)).length,
  }));
  const lastSeen = (u: (typeof authUsers)[number]) =>
    new Date(u.last_sign_in_at || u.created_at).getTime();
  const wau = authUsers.filter((u) => now - lastSeen(u) < WEEK).length;
  const mau = authUsers.filter((u) => now - lastSeen(u) < 30 * 86400000).length;
  const newThisWeek = authUsers.filter(
    (u) => now - new Date(u.created_at).getTime() < WEEK
  ).length;
  const dormant = authUsers.filter((u) => now - lastSeen(u) > 14 * 86400000).length;

  // Activation funnel by USERS, not events: of everyone who signed up, how many
  // ever reached each stage. The drop between stages is where onboarding work
  // should go.
  const funnelUsers = {
    signedUp: authUsers.length,
    searched: perUser.filter((u) => u.searches > 0).length,
    found: perUser.filter((u) => u.finds > 0).length,
    drafted: perUser.filter((u) => u.drafts > 0).length,
    sent: perUser.filter((u) => u.sent > 0).length,
    replied: perUser.filter((u) => u.replied > 0).length,
  };

  const health = {
    wau,
    mau,
    newThisWeek,
    dormant,
    trend,
    signupsByWeek,
    funnelUsers,
  };

  // What people actually use Scout for, read off their REAL searches instead
  // of the old profile question. Deterministic keyword buckets over the goal
  // text; each bucket keeps a couple of example goals so the label can be
  // sanity-checked against reality.
  const classifyGoal = (g: string): string => {
    const t = g.toLowerCase();
    if (/\bintern(ship)?s?\b/.test(t)) return "Internships";
    if (/\b(job|jobs|hiring|position|opening|full[- ]time|part[- ]time|career|employer)\b/.test(t)) return "Job hunt";
    if (/playlist|curator|spotify|\bdj\b|radio|sync|a&r|\blabel\b|music blog|submithub/.test(t)) return "Music promotion";
    if (/\b(press|journalist|blog(ger)?|magazine|media outlet|review(er)?|coverage|publicist)\b/.test(t)) return "Press & media";
    if (/invest(or|ment)|\bvc\b|venture|angel|fund(ing)?/.test(t)) return "Investors";
    if (/school|college|university|masters?|degree|scholarship|admission|program director/.test(t)) return "Schools & programs";
    if (/brand deal|sponsor|partnership|collab/.test(t)) return "Partnerships";
    if (/client|lead(s| gen)|customer|sales|sell\b/.test(t)) return "Sales & clients";
    if (/mentor|coffee chat|network|connect with|advice/.test(t)) return "Networking";
    return "Other";
  };
  const catAgg = new Map<string, { count: number; users: Set<string>; examples: string[] }>();
  for (const h of histRes?.data || []) {
    const goal = String((h as any).goal || "").trim();
    if (!goal) continue;
    const cat = classifyGoal(goal);
    const b = catAgg.get(cat) || { count: 0, users: new Set<string>(), examples: [] };
    b.count += 1;
    b.users.add(String((h as any).user_id || ""));
    if (b.examples.length < 2 && goal.length > 12) b.examples.push(goal.slice(0, 110));
    catAgg.set(cat, b);
  }
  const searchCategories = Array.from(catAgg.entries())
    .map(([name, b]) => ({ name, count: b.count, users: b.users.size, examples: b.examples }))
    .sort((a, b) => b.count - a.count);

  for (const n of runBuckets.values()) {
    algo.runs++;
    algo.runFindSum += n;
    if (n >= 5) algo.runsAtFloor++;
  }

  return NextResponse.json({
    // Raw counters the editable Metrics tab builds formulas from. "decided"
    // and "outbound" are the two common denominators, precomputed.
    algoCatalog: {
      searchFinds: algo.searchFinds,
      withContact: algo.withContact,
      fitCount: algo.fitCount,
      fitHigh: algo.fitHigh,
      bounced: algo.bounced,
      runs: algo.runs,
      runsAtFloor: algo.runsAtFloor,
      runFindSum: algo.runFindSum,
      finds: totals.finds,
      denied: totals.denied,
      approved: totals.approved,
      drafted: totals.drafted,
      sent: totals.sent,
      replied: totals.replied,
      users: totals.users,
      searches: (histRes?.data || []).length,
      decided: totals.denied + totals.approved,
      outbound: totals.sent + totals.replied,
    },
    algo: {
      searchFinds: algo.searchFinds,
      contactRate: algo.searchFinds ? algo.withContact / algo.searchFinds : 0,
      avgFit: algo.fitCount ? algo.fitSum / algo.fitCount : 0,
      highFitShare: algo.fitCount ? algo.fitHigh / algo.fitCount : 0,
      keepRate: totals.denied + totals.approved
        ? totals.approved / (totals.denied + totals.approved)
        : 0,
      replyRate: totals.sent + totals.replied ? totals.replied / (totals.sent + totals.replied) : 0,
      bounceRate: totals.sent + totals.replied ? algo.bounced / (totals.sent + totals.replied) : 0,
      runs: algo.runs,
      avgFindsPerRun: algo.runs ? algo.runFindSum / algo.runs : 0,
      floorRate: algo.runs ? algo.runsAtFloor / algo.runs : 0,
    },
    searchCategories,
    health,
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
