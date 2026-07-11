import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { discover } from "@/lib/discover";
import { gmailSendOrDraft } from "@/lib/gmail";
import { outlookSendOrDraft } from "@/lib/outlook";
import { signAction, nextRunAt } from "@/lib/autoSearch";
import { getEntitlement, consumeSearch } from "@/lib/billing";
import { draftFor } from "@/lib/draft";
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

  // On the free (Hobby) plan this cron fires roughly once a day, so process a
  // batch of due searches per run — capped to stay well under maxDuration (each
  // discover is ~30-60s). Extras drain on the next daily run.
  const { data: due, error } = await supabaseAdmin
    .from("auto_searches")
    .select("id, user_id, email, goal, use_case, about, label, max_finds, cadence, email_digest")
    .eq("active", true)
    .lte("next_run_at", new Date().toISOString())
    .order("next_run_at", { ascending: true })
    .limit(4);
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

  // ---- Phase 2: auto-draft the finds the user Approved from the digest email,
  // then email them the ready-to-send drafts. Bounded so the whole run stays
  // under maxDuration. Driven by the email "Approve" action (status=approved).
  let drafted = 0;
  try {
    const { data: approved } = await supabaseAdmin
      .from("auto_finds")
      .select("id, user_id, opp, auto_searches(email, about, use_case, goal, label)")
      .eq("status", "approved")
      .order("decided_at", { ascending: true })
      .limit(8);

    // Group the approved finds by user so each person gets one drafts email.
    const byUser = new Map<string, any[]>();
    for (const r of approved || []) {
      const u = String((r as any).user_id);
      if (!byUser.has(u)) byUser.set(u, []);
      byUser.get(u)!.push(r);
    }

    for (const [uid, rows] of Array.from(byUser.entries())) {
      // Load the user's drafting context once (name, signature, templates, voice).
      const [prof, stateRes] = await Promise.all([
        supabaseAdmin.from("profiles").select("name").eq("id", uid).maybeSingle(),
        supabaseAdmin.from("user_state").select("data").eq("user_id", uid).maybeSingle(),
      ]);
      const data = (stateRes.data?.data || {}) as any;
      const senderName = String(prof.data?.name || data?.profileExtras?.companyName || "");
      const signature = String(data?.signature || "");
      const templates = Array.isArray(data?.templates) ? data.templates : [];
      const coaching = Array.isArray(data?.coaching) ? data.coaching : [];
      const editPairs = Array.isArray(data?.editPairs) ? data.editPairs : [];

      const made: { name: string; channel: string; subject: string; body: string }[] = [];
      for (const r of rows) {
        const asr = (r as any).auto_searches || {};
        try {
          const d = await draftFor(
            (r as any).opp,
            String(asr.about || ""),
            String(asr.use_case || "networking"),
            { templates, coaching, editPairs, signature, senderName, goal: String(asr.goal || "") }
          );
          await supabaseAdmin
            .from("auto_finds")
            .update({ status: "drafted", draft: d })
            .eq("id", (r as any).id);
          made.push({
            name: String((r as any).opp?.name || "this contact"),
            channel: d.channelType,
            subject: d.subject || "",
            body: d.body || "",
          });
          drafted++;
        } catch {
          /* leave it 'approved' to retry next run */
        }
      }
      if (!made.length) continue;

      // Build a plain-text "your drafts are ready" digest.
      const to = String((rows[0] as any).auto_searches?.email || "").toLowerCase();
      const dl: string[] = [
        `Your Scout drafts are ready — ${made.length} message${made.length === 1 ? "" : "s"} you approved, written in your voice.`,
        ``,
      ];
      made.forEach((m, i) => {
        dl.push(`${i + 1}. ${m.name} (${m.channel})`);
        if (m.subject) dl.push(`   Subject: ${m.subject}`);
        dl.push(m.body.split("\n").map((l) => "   " + l).join("\n"));
        dl.push(``);
      });
      dl.push(`Copy, tweak, or send from Scout: ${base}/app`);
      const dbody = dl.join("\n");
      const dsubject = `Scout: ${made.length} draft${made.length === 1 ? "" : "s"} ready to send`;

      try {
        const gmail = await supabaseAdmin
          .from("gmail_connections")
          .select("email, refresh_token")
          .eq("user_id", uid)
          .maybeSingle();
        if (gmail.data?.refresh_token) {
          await gmailSendOrDraft({
            refreshToken: gmail.data.refresh_token as string,
            from: (gmail.data.email as string) || "me",
            to: to || (gmail.data.email as string) || "",
            subject: dsubject,
            body: dbody,
            mode: "send",
          });
        } else {
          const ol = await supabaseAdmin
            .from("outlook_connections")
            .select("email, refresh_token")
            .eq("user_id", uid)
            .maybeSingle();
          if (ol.data?.refresh_token) {
            await outlookSendOrDraft({
              refreshToken: ol.data.refresh_token as string,
              to: to || (ol.data.email as string) || "",
              subject: dsubject,
              body: dbody,
              mode: "send",
            });
          }
        }
      } catch (e: any) {
        results.push({ draftsEmailError: String(e?.message || "").slice(0, 160) });
      }
    }
  } catch (e: any) {
    results.push({ draftPassError: String(e?.message || "").slice(0, 160) });
  }

  return NextResponse.json({ ok: true, ran, emailed, drafted, results, checkedAt: new Date().toISOString() });
}
