import { NextResponse } from "next/server";
import { supabaseAdmin, userFromReq } from "@/lib/supabaseAdmin";
import { isOwnerEmail } from "@/lib/owner";

export const maxDuration = 30;
export const dynamic = "force-dynamic";

// GET /api/admin/index, owner-only view of the shared people index: how big it
// is, how fast it's growing, how reachable the people in it are, and the most
// recent additions. This is the flywheel gauge, not user data: the table holds
// only public-web engine results.
export async function GET(req: Request) {
  const me = await userFromReq(req);
  if (!me || !isOwnerEmail(me.email)) {
    return NextResponse.json({ error: "Not authorized." }, { status: 403 });
  }
  if (!supabaseAdmin) {
    return NextResponse.json({ error: "Service role not configured." }, { status: 500 });
  }
  try {
    // ?export=1: the whole table as JSON, for backups. Owner-only like the
    // rest of this route; pages through in 1000-row batches.
    if (new URL(req.url).searchParams.get("export") === "1") {
      const all: any[] = [];
      for (let fromRow = 0; ; fromRow += 1000) {
        const { data: page, error } = await supabaseAdmin
          .from("people_index")
          .select("key, opp, sources, seen_count, first_seen_at, last_seen_at")
          .order("first_seen_at", { ascending: true })
          .range(fromRow, fromRow + 999);
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        all.push(...(page || []));
        if (!page || page.length < 1000) break;
      }
      return NextResponse.json({ exportedAt: new Date().toISOString(), count: all.length, rows: all });
    }

    const { count: total } = await supabaseAdmin
      .from("people_index")
      .select("id", { count: "exact", head: true });
    // Aggregates from a capped pull; fine well past early scale, and the cap
    // keeps this endpoint cheap no matter how big the table gets.
    const { data: rows, error } = await supabaseAdmin
      .from("people_index")
      .select("opp, seen_count, first_seen_at, last_seen_at")
      .order("last_seen_at", { ascending: false })
      .limit(5000);
    if (error) {
      // Most likely: the table doesn't exist yet (SQL not run).
      return NextResponse.json({ notReady: true, message: error.message });
    }
    const now = Date.now();
    const D = 86400000;
    const within = (iso: string, days: number) => now - new Date(iso).getTime() <= days * D;
    let withEmail = 0;
    let withHandle = 0;
    let added7 = 0;
    let added30 = 0;
    let seenOnce = 0;
    let seenFew = 0;
    let seenMany = 0;
    const outletCounts: Record<string, number> = {};
    const dayCounts: Record<string, number> = {};
    for (const r of rows || []) {
      const o: any = r.opp || {};
      if (o.contactEmail) withEmail++;
      if (o.contactHandle) withHandle++;
      if (within(r.first_seen_at, 7)) added7++;
      if (within(r.first_seen_at, 30)) added30++;
      if (r.seen_count <= 1) seenOnce++;
      else if (r.seen_count <= 4) seenFew++;
      else seenMany++;
      const outlet = String(o.outlet || "").trim();
      if (outlet) outletCounts[outlet] = (outletCounts[outlet] || 0) + 1;
      if (within(r.first_seen_at, 14)) {
        const day = String(r.first_seen_at).slice(0, 10);
        dayCounts[day] = (dayCounts[day] || 0) + 1;
      }
    }
    const topOutlets = Object.entries(outletCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
    // Last 14 days as a filled series, oldest first, for a simple bar strip.
    const days: { day: string; n: number }[] = [];
    for (let i = 13; i >= 0; i--) {
      const day = new Date(now - i * D).toISOString().slice(0, 10);
      days.push({ day, n: dayCounts[day] || 0 });
    }
    const recent = (rows || []).slice(0, 25).map((r) => {
      const o: any = r.opp || {};
      return {
        name: String(o.name || ""),
        role: String(o.contactRole || ""),
        outlet: String(o.outlet || ""),
        location: String(o.location || ""),
        hasEmail: !!o.contactEmail,
        hasHandle: !!o.contactHandle,
        seen: r.seen_count,
        lastSeen: String(r.last_seen_at).slice(0, 10),
      };
    });
    return NextResponse.json({
      total: total || 0,
      added7,
      added30,
      withEmail,
      withHandle,
      seenOnce,
      seenFew,
      seenMany,
      sampled: (rows || []).length,
      topOutlets,
      days,
      recent,
    });
  } catch (e: any) {
    return NextResponse.json({ notReady: true, message: e?.message || "Index unavailable." });
  }
}
