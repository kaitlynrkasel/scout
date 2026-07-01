import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, userIdFromReq } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";

// Real, aggregate-only community benchmarks computed from everyone else's saved
// state. Returns averages only — never any individual's data. "Everyone else"
// excludes the requesting user, so the comparison is honest.
function userMetrics(data: any) {
  const finds = Array.isArray(data?.finds) ? data.finds : [];
  const decided = finds.filter((f: any) => f.status !== "new");
  const denied = decided.filter((f: any) => f.status === "denied").length;
  const kept = decided.filter(
    (f: any) => f.status === "drafted" || f.status === "sent"
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

export async function GET(req: NextRequest) {
  const uid = await userIdFromReq(req);
  if (!uid || !supabaseAdmin) return NextResponse.json({ users: 0 });

  const { data } = await supabaseAdmin.from("user_state").select("user_id, data");
  const others = (data || []).filter((r: any) => r.user_id !== uid);
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
  });
}
