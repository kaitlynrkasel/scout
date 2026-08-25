import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, userFromReq } from "@/lib/supabaseAdmin";
import { isOwnerEmail } from "@/lib/owner";

export const dynamic = "force-dynamic";

// Owner-editable algorithm metrics: each is a name plus a formula over the
// raw counters the insights walk exposes (algoCatalog). Definitions live in
// admin_config under one key; the Metrics tab is the editor.

interface MetricDef {
  id: string;
  name: string;
  description: string;
  num: string; // catalog key
  den: string; // catalog key or "" for a plain count
  format: "count" | "percent" | "avg";
}

const KEY = "algo_metrics";

// The starting set mirrors the Algorithm health tiles; owners edit from here.
const DEFAULT_METRICS: MetricDef[] = [
  { id: "keep", name: "Keep rate", description: "Kept vs denied, of decided finds", num: "approved", den: "decided", format: "percent" },
  { id: "reach", name: "Arrive reachable", description: "Search finds with an email or handle", num: "withContact", den: "searchFinds", format: "percent" },
  { id: "highfit", name: "High-fit share", description: "Scored finds at 80%+ fit", num: "fitHigh", den: "fitCount", format: "percent" },
  { id: "reply", name: "Reply rate", description: "Replied, of sent", num: "replied", den: "outbound", format: "percent" },
  { id: "floor", name: "Hit the 5-find floor", description: "Runs delivering 5 or more", num: "runsAtFloor", den: "runs", format: "percent" },
  { id: "perrun", name: "Finds per run", description: "Average per search run", num: "runFindSum", den: "runs", format: "avg" },
  { id: "bounce", name: "Bounce rate", description: "Bounced, of messages sent", num: "bounced", den: "outbound", format: "percent" },
  { id: "found", name: "Finds discovered", description: "By search, all time", num: "searchFinds", den: "", format: "count" },
];

export async function GET(req: NextRequest) {
  const me = await userFromReq(req);
  if (!me || !isOwnerEmail(me.email)) {
    return NextResponse.json({ error: "Not authorized." }, { status: 403 });
  }
  if (!supabaseAdmin) {
    return NextResponse.json({ metrics: DEFAULT_METRICS, editable: false });
  }
  const { data, error } = await supabaseAdmin
    .from("admin_config")
    .select("value")
    .eq("key", KEY)
    .maybeSingle();
  if (error) {
    // Most likely the table isn't created yet; defaults still render, edits
    // need supabase/admin_config.sql run once.
    return NextResponse.json({ metrics: DEFAULT_METRICS, editable: false, notReady: true });
  }
  const stored = (data?.value as MetricDef[] | undefined) || null;
  return NextResponse.json({
    metrics: Array.isArray(stored) && stored.length ? stored : DEFAULT_METRICS,
    editable: true,
  });
}

export async function POST(req: NextRequest) {
  const me = await userFromReq(req);
  if (!me || !isOwnerEmail(me.email)) {
    return NextResponse.json({ error: "Not authorized." }, { status: 403 });
  }
  if (!supabaseAdmin) {
    return NextResponse.json({ error: "Service role not configured." }, { status: 500 });
  }
  const body = await req.json().catch(() => ({}));
  const raw = Array.isArray(body?.metrics) ? body.metrics : null;
  if (!raw) return NextResponse.json({ error: "No metrics to save." }, { status: 400 });
  const metrics: MetricDef[] = raw
    .map((m: any) => ({
      id: String(m?.id || "").slice(0, 40) || Math.random().toString(36).slice(2, 8),
      name: String(m?.name || "").slice(0, 60),
      description: String(m?.description || "").slice(0, 140),
      num: String(m?.num || ""),
      den: String(m?.den || ""),
      format: ["count", "percent", "avg"].includes(m?.format) ? m.format : "count",
    }))
    .filter((m: MetricDef) => m.name && m.num)
    .slice(0, 24);
  const { error } = await supabaseAdmin
    .from("admin_config")
    .upsert({ key: KEY, value: metrics, updated_at: new Date().toISOString() });
  if (error) {
    return NextResponse.json(
      { error: `Save failed (run supabase/admin_config.sql?): ${error.message}` },
      { status: 500 }
    );
  }
  return NextResponse.json({ ok: true, metrics });
}
