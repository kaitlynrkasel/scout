import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, userFromReq } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";

// The dashboard's news feed: what happened since the caller last read it.
// Three kinds of story, all cheap aggregates, none of them the caller's own
// activity (you don't need news about yourself):
//   - a teammate ran searches (shared finds created since `since`, per person)
//   - a teammate moved outreach (finds marked drafted/sent since, per person)
//   - Scout itself got better (auto-tune entries since; best-effort, the table
//     may not exist on an older database)
// Read state lives on the client; this route just answers "since when".
export async function GET(req: NextRequest) {
  const u = await userFromReq(req);
  if (!u) return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  if (!supabaseAdmin) return NextResponse.json({ items: [] });

  const workspaceId = req.nextUrl.searchParams.get("workspaceId") || "";
  const sinceRaw = req.nextUrl.searchParams.get("since") || "";
  const since = /^\d{4}-\d{2}-\d{2}T/.test(sinceRaw)
    ? sinceRaw
    : new Date(Date.now() - 7 * 86400000).toISOString();
  if (!workspaceId) return NextResponse.json({ items: [] });

  // Membership gate: news is workspace data.
  const { data: member } = await supabaseAdmin
    .from("workspace_members")
    .select("user_id")
    .eq("workspace_id", workspaceId)
    .eq("user_id", u.id)
    .maybeSingle();
  if (!member) return NextResponse.json({ error: "Not a member." }, { status: 403 });

  const { data: projects } = await supabaseAdmin
    .from("shared_projects")
    .select("id, name")
    .eq("workspace_id", workspaceId);
  const projIds = (projects || []).map((p: any) => p.id);
  const projName = new Map((projects || []).map((p: any) => [p.id, String(p.name || "")]));

  const items: {
    kind: "searches" | "outreach" | "scout";
    who?: string;
    count: number;
    detail: string;
    at: string;
  }[] = [];

  if (projIds.length) {
    const mine = (u.email || "").toLowerCase();

    // Searches: new shared finds per teammate.
    const { data: added } = await supabaseAdmin
      .from("shared_finds")
      .select("added_email, shared_project_id, created_at")
      .in("shared_project_id", projIds)
      .gte("created_at", since)
      .limit(2000);
    const byAdder = new Map<string, { count: number; projs: Set<string>; last: string }>();
    for (const r of added || []) {
      const who = String(r.added_email || "").toLowerCase();
      if (!who || who === mine) continue;
      const cur = byAdder.get(who) || { count: 0, projs: new Set(), last: "" };
      cur.count++;
      const nm = projName.get(r.shared_project_id);
      if (nm) cur.projs.add(nm);
      if (r.created_at > cur.last) cur.last = r.created_at;
      byAdder.set(who, cur);
    }
    for (const [who, v] of byAdder) {
      items.push({
        kind: "searches",
        who,
        count: v.count,
        detail: [...v.projs].slice(0, 3).join(", "),
        at: v.last,
      });
    }

    // Outreach: finds a teammate moved to drafted or sent.
    const { data: moved } = await supabaseAdmin
      .from("shared_finds")
      .select("updated_email, status, updated_at")
      .in("shared_project_id", projIds)
      .in("status", ["drafted", "sent"])
      .gte("updated_at", since)
      .limit(2000);
    const byMover = new Map<string, { drafted: number; sent: number; last: string }>();
    for (const r of moved || []) {
      const who = String(r.updated_email || "").toLowerCase();
      if (!who || who === mine) continue;
      const cur = byMover.get(who) || { drafted: 0, sent: 0, last: "" };
      if (r.status === "sent") cur.sent++;
      else cur.drafted++;
      if (r.updated_at > cur.last) cur.last = r.updated_at;
      byMover.set(who, cur);
    }
    for (const [who, v] of byMover) {
      const bits = [];
      if (v.drafted) bits.push(`wrote ${v.drafted} draft${v.drafted === 1 ? "" : "s"}`);
      if (v.sent) bits.push(`sent ${v.sent} message${v.sent === 1 ? "" : "s"}`);
      items.push({
        kind: "outreach",
        who,
        count: v.drafted + v.sent,
        detail: bits.join(", "),
        at: v.last,
      });
    }
  }

  // Scout getting better: the caller's auto-tune history. Best-effort, the
  // table is added by supabase/auto_tune_log.sql and may not exist yet.
  try {
    const { data: tunes, error } = await supabaseAdmin
      .from("auto_tune_log")
      .select("label, created_at")
      .eq("user_id", u.id)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(10);
    if (!error) {
      for (const t of tunes || []) {
        items.push({
          kind: "scout",
          count: 1,
          detail: String(t.label || "Tuned how it searches for you"),
          at: t.created_at,
        });
      }
    }
  } catch {
    /* table absent: no Scout stories, the rest of the feed stands */
  }

  items.sort((a, b) => (a.at < b.at ? 1 : -1));
  return NextResponse.json({ items: items.slice(0, 20) });
}
