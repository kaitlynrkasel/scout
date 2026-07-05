import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, userIdFromReq } from "@/lib/supabaseAdmin";
import { ucKey } from "@/lib/templates";

export const runtime = "nodejs";

// A cohort needs at least this many OTHER users before we show its patterns, so
// a "people like you" pattern can never be traced back to one person.
const MIN_COHORT = 5;

// Real, aggregate-only community benchmarks computed from everyone else's saved
// state. Returns averages only, never any individual's data. "Everyone else"
// excludes the requesting user, so the comparison is honest.
function userMetrics(data: any) {
  const finds = Array.isArray(data?.finds) ? data.finds : [];
  const decided = finds.filter((f: any) => f.status !== "new");
  const denied = decided.filter((f: any) => f.status === "denied").length;
  const kept = decided.filter(
    (f: any) => f.status === "drafted" || f.status === "sent" || f.status === "replied"
  );
  const keptFit = kept
    .map((f: any) => f.opp?.fitScore)
    .filter((v: any) => typeof v === "number");
  const activity = data?.activity || {};
  return {
    finds: finds.length,
    decided: decided.length,
    denyRate: decided.length ? denied / decided.length : null,
    drafts: activity.drafts || 0,
    keptFit: keptFit.length
      ? keptFit.reduce((a: number, b: number) => a + b, 0) / keptFit.length
      : null,
  };
}

// What's actually working across everyone else's pipelines: which channels get
// acted on, the fit level people keep vs pass, and whether project context
// lowers deny rates. Aggregates only; thin cohorts return null so the client
// never shows a claim built on almost no data.
function communityPatterns(rows: any[]) {
  const allDecided: any[] = [];
  const withCtx: number[] = [];
  const withoutCtx: number[] = [];

  for (const r of rows) {
    const d = r.data || {};
    const finds = Array.isArray(d.finds) ? d.finds : [];
    const decided = finds.filter((f: any) => f.status !== "new");
    allDecided.push(...decided);
    if (decided.length) {
      const denyRate =
        decided.filter((f: any) => f.status === "denied").length / decided.length;
      const hasCtx = (d.projects || []).some((p: any) => (p.context || "").trim());
      (hasCtx ? withCtx : withoutCtx).push(denyRate);
    }
  }

  // Channel kept-rates, only for channels with enough decisions to mean something.
  const byChannel: Record<string, { kept: number; total: number }> = {};
  for (const f of allDecided) {
    const c = f.opp?.channel || "Unknown";
    byChannel[c] = byChannel[c] || { kept: 0, total: 0 };
    byChannel[c].total++;
    if (f.status === "drafted" || f.status === "sent" || f.status === "replied") byChannel[c].kept++;
  }
  const channels = Object.entries(byChannel)
    .filter(([, v]) => v.total >= 5)
    .map(([channel, v]) => ({ channel, total: v.total, keptRate: v.kept / v.total }))
    .sort((a, b) => b.keptRate - a.keptRate);

  const fits = (want: (f: any) => boolean) => {
    const vals = allDecided
      .filter(want)
      .map((f: any) => f.opp?.fitScore)
      .filter((v: any) => typeof v === "number");
    return vals.length >= 5
      ? vals.reduce((a: number, b: number) => a + b, 0) / vals.length
      : null;
  };
  const mean = (a: number[]) =>
    a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;

  return {
    decidedFinds: allDecided.length,
    channels,
    fitKept: fits((f) => f.status === "drafted" || f.status === "sent" || f.status === "replied"),
    fitDenied: fits((f) => f.status === "denied"),
    contextEffect:
      withCtx.length >= 2 && withoutCtx.length >= 2
        ? { withContext: mean(withCtx), withoutContext: mean(withoutCtx) }
        : null,
  };
}

// "People like you": the same aggregate patterns, but computed only over users
// who share the requester's use case (a loose cohort). Null unless the cohort is
// big enough to stay anonymous.
function cohortInfo(others: any[], useCaseRaw: string) {
  const key = ucKey(useCaseRaw || "");
  if (!key) return null;
  const cohort = others.filter((r: any) =>
    (r.data?.projects || []).some((p: any) => ucKey(p?.useCase || "") === key)
  );
  if (cohort.length < MIN_COHORT) return null;
  return { users: cohort.length, useCase: useCaseRaw, patterns: communityPatterns(cohort) };
}

export async function GET(req: NextRequest) {
  const uid = await userIdFromReq(req);
  if (!uid || !supabaseAdmin) return NextResponse.json({ users: 0 });

  const { data } = await supabaseAdmin.from("user_state").select("user_id, data");
  const others = (data || []).filter((r: any) => r.user_id !== uid);
  const useCaseParam = req.nextUrl.searchParams.get("useCase") || "";
  const metrics = others
    .map((r: any) => userMetrics(r.data || {}))
    .filter((m) => m.finds > 0 || m.drafts > 0);

  const avg = (pick: (m: any) => number | null) => {
    const vals = metrics.map(pick).filter((v): v is number => v != null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };

  return NextResponse.json({
    users: metrics.length,
    avgDenyRate: avg((m) => m.denyRate),
    avgFinds: avg((m) => m.finds),
    avgDrafts: avg((m) => m.drafts),
    avgFitKept: avg((m) => m.keptFit),
    patterns: communityPatterns(others),
    cohort: useCaseParam ? cohortInfo(others, useCaseParam) : null,
  });
}
