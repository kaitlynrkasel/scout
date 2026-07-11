import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { discover } from "@/lib/discover";
import { gmailSendOrDraft } from "@/lib/gmail";
import { outlookSendOrDraft } from "@/lib/outlook";
import { signAction, nextRunAt } from "@/lib/autoSearch";
import { getEntitlement, consumeSearch } from "@/lib/billing";
import type { Opportunity } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300; // discover chains several Tavily + Claude passes
export const dynamic = "force-dynamic";

function origin(req: NextRequest): string {
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || "";
  const proto = req.headers.get("x-forwarded-proto") || (host.startsWith("localhost") ? "http" : "https");
  const configured = process.env.NEXT_PUBLIC_SITE_URL || "";
  return configured || (host ? `${proto}://${host}` : "https://scout-source.com");
}

// Vercel Cron target. Runs due auto-searches: for each, run the discovery engine,
// store the finds, and email the user a plain-text digest with one-tap
// Approve / Not-a-fit links. Auth: Vercel sends `Authorization: Bearer
// <CRON_SECRET>`.
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") || "";
  const secret = process.env.CRON_SECRET || "";
  if (!secret) return NextResponse.json({ error: "CRON_SECRET not set." }, { status: 500 });
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  if (!supabaseAdmin) {
    return NextResponse.json({ error: "Service role not configured." }, { status: 500 });
  }
  if (!process.env.TAVILY_API_KEY || !process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "Search keys not configured." }, { status: 500 });
  }

  // A few due searches per tick, so one run never exceeds maxDuration.
  const { data: due, error } = await supabaseAdmin
    .from("auto_searches")
    .select("id, user_id, email, goal, use_case, about, label, max_finds, cadence, email_digest")
    .eq("active", true)
    .lte("next_run_at", new Date().toISOString())
    .order("next_run_at", { ascending: true })
    .limit(3);
  if (error) {
    return NextResponse.json({ error: `Read failed: ${error.message}` }, { status: 500 });
  }
  if (!due?.length) {
    return NextResponse.json({ ok: true, ran: 0, checkedAt: new Date().toISOString() });
  }

  const base = origin(req);
  let ran = 0;
  let emailed = 0;
  const results: any[] = [];

  for (const s of due) {
    const id = s.id as string;
    // Reschedule up front so a failure doesn't wedge this search on every tick.
    await supabaseAdmin
      .from("auto_searches")
      .update({
        last_run_at: new Date().toISOString(),
        next_run_at: nextRunAt(String(s.cadence), new Date()).toISOString(),
      })
      .eq("id", id);

    // An auto-run counts as a search: skip (don't run, don't spend) when the
    // user is out of quota — it'll try again next cadence. Mirrors /api/discover.
    try {
      const ent = await getEntitlement(s.user_id as string);
      const paid = ent.tier === "starter" || ent.tier === "pro";
      const out = paid
        ? ent.searchesUsed >= ent.searchLimit
        : ent.freeUsed >= ent.freeLimit;
      if (out) {
        results.push({ id, skipped: "out of searches" });
        continue;
      }
    } catch {
      /* if entitlement can't be read, fall through and run */
    }
    ran++;

    try {
      const result = await discover(
        String(s.goal),
        String(s.about || ""),
        String(s.use_case || "networking"),
        Math.min(Number(s.max_finds) || 5, 10)
      );
      // Running the engine spent a search — meter it against their plan.
      try {
        await consumeSearch(s.user_id as string);
      } catch {
        /* metering is best-effort; never fail the run over it */
      }
      const opps: Opportunity[] = (result.opportunities || []).slice(
        0,
        Math.min(Number(s.max_finds) || 5, 10)
      );
      if (!opps.length) {
        results.push({ id, finds: 0 });
        continue;
      }

      // Store the finds so the approve/deny links have rows to act on.
      const rows = opps.map((opp) => ({
        auto_search_id: id,
        user_id: s.user_id,
        opp,
      }));
      const inserted = await supabaseAdmin
        .from("auto_finds")
        .insert(rows)
        .select("id");
      const ids: string[] = (inserted.data || []).map((r: any) => r.id);

      // Also drop EVERY find into the user's Scout pipeline (via the seeded-finds
      // channel), so they show up in Finds on the website too — not just the
      // email. They land as "new"; the email's Approve/Deny is a quick inbox
      // shortcut, but the same finds are reviewable in the app.
      if (s.email && opps.length) {
        await supabaseAdmin.from("admin_seeded_finds").insert(
          opps.map((opp) => ({
            email: String(s.email).toLowerCase(),
            opp,
            note: `Auto-search: ${String(s.label || s.goal).slice(0, 80)}`,
            created_by: "auto-search",
          }))
        );
      }

      // "Auto-emails" is optional: when off, the finds still land in Finds
      // (seeded above) but we skip the digest.
      if (s.email_digest === false) {
        results.push({ id, finds: opps.length, emailed: false });
        continue;
      }

      // Build a plain-text digest — clickable links work in every mail client.
      const label = String(s.label || s.goal).slice(0, 80);
      const lines: string[] = [
        `Scout found ${opps.length} new ${opps.length === 1 ? "match" : "matches"} for "${label}".`,
        ``,
        `Tap Approve or Not a fit on each — approved ones land in your Scout pipeline.`,
        ``,
      ];
      opps.forEach((o, i) => {
        const fid = ids[i];
        const fit = typeof o.fitScore === "number" ? ` (${Math.round(o.fitScore * 100)}% fit)` : "";
        const contact = [o.contactEmail, o.contactHandle, o.url].filter(Boolean)[0] || "";
        lines.push(`${i + 1}. ${o.name}${o.contactRole ? ` — ${o.contactRole}` : ""}${fit}`);
        if (o.whyItFits) lines.push(`   Why: ${o.whyItFits}`);
        if (contact) lines.push(`   Contact: ${contact}`);
        if (fid) {
          lines.push(`   Approve:   ${base}/api/auto/action?t=${signAction(fid, "approve")}`);
          lines.push(`   Not a fit: ${base}/api/auto/action?t=${signAction(fid, "deny")}`);
        }
        lines.push(``);
      });
      lines.push(`Open in Scout: ${base}/app`);
      lines.push(`(Manage or stop this auto-search in Scout → Outreach.)`);
      const bodyText = lines.join("\n");
      const subject = `Scout: ${opps.length} new ${opps.length === 1 ? "find" : "finds"} — ${label}`;

      // Send from the user's own connected mailbox to their own address.
      const gmail = await supabaseAdmin
        .from("gmail_connections")
        .select("email, refresh_token")
        .eq("user_id", s.user_id)
        .maybeSingle();
      const outlook = gmail.data?.refresh_token
        ? { data: null as any }
        : await supabaseAdmin
            .from("outlook_connections")
            .select("email, refresh_token")
            .eq("user_id", s.user_id)
            .maybeSingle();

      const to = String(s.email || gmail.data?.email || outlook.data?.email || "");
      if (gmail.data?.refresh_token) {
        await gmailSendOrDraft({
          refreshToken: gmail.data.refresh_token as string,
          from: (gmail.data.email as string) || "me",
          to,
          subject,
          body: bodyText,
          mode: "send",
        });
        emailed++;
      } else if (outlook.data?.refresh_token) {
        await outlookSendOrDraft({
          refreshToken: outlook.data.refresh_token as string,
          to,
          subject,
          body: bodyText,
          mode: "send",
        });
        emailed++;
      }
      results.push({ id, finds: opps.length, emailedTo: to });
    } catch (e: any) {
      results.push({ id, error: String(e?.message || "failed").slice(0, 200) });
    }
  }

  return NextResponse.json({ ok: true, ran, emailed, results, checkedAt: new Date().toISOString() });
}
