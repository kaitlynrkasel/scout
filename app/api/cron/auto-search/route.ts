import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { discover } from "@/lib/discover";
import { gmailSendOrDraft } from "@/lib/gmail";
import { outlookSendOrDraft } from "@/lib/outlook";
import { signAction, nextRunAt } from "@/lib/autoSearch";
import { htmlEsc } from "@/lib/tuneEmail";
import { getEntitlement, consumeSearch } from "@/lib/billing";
import { draftFor } from "@/lib/draft";
import { sharedPipelineExclusions, addSharedFinds } from "@/lib/teams";
import { searchPeopleIndex, upsertPeopleIndex } from "@/lib/peopleIndex";
import type { Opportunity } from "@/lib/types";
import { sendToUser } from "@/lib/push";

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

  // Runs every 10 min (Pro plan). Process a small batch of due searches per run —
  // capped to stay well under maxDuration (each discover is ~30-60s). Any extras
  // drain on the next tick a few minutes later.
  const { data: due, error } = await supabaseAdmin
    .from("auto_searches")
    .select("id, user_id, email, goal, use_case, about, label, max_finds, cadence, email_digest, shared_project_id")
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
      // Team dedup: if this auto-search targets a shared project, skip everyone
      // already in the team's pipeline so this teammate's email carries a
      // DIFFERENT slice than the others. New finds are written back to the pool
      // (below), so the pool grows and the next run naturally avoids them.
      const sharedProjectId = (s as any).shared_project_id as string | null;
      let feedback: any = undefined;
      if (sharedProjectId) {
        try {
          const { names } = await sharedPipelineExclusions(sharedProjectId);
          if (names.length)
            feedback = {
              avoid: names.map((n) => ({ name: n, reason: "already in your team's shared pipeline" })),
            };
        } catch {
          /* if the pool can't be read, run without exclusions rather than skip */
        }
      }
      const result = await discover(
        String(s.goal),
        String(s.about || ""),
        String(s.use_case || "networking"),
        Math.min(Number(s.max_finds) || 5, 10),
        feedback,
        undefined,
        undefined,
        undefined,
        {
          // Same shared-index blend as interactive searches: small salted
          // slice in, results written back (public-web finds only).
          indexLookup: (g) => searchPeopleIndex(g, 6, `${s.user_id}:${id}`),
        }
      );
      void upsertPeopleIndex(result.opportunities || []);
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

      // Team dedup: add this run's finds to the shared pipeline so the pool
      // grows and every teammate's future run (and email) skips them.
      if (sharedProjectId) {
        try {
          await addSharedFinds(
            String(s.user_id),
            String(s.email || ""),
            sharedProjectId,
            opps.map((opp) => ({ opp, status: "new" }))
          );
        } catch {
          /* best-effort — the personal digest below still goes out */
        }
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

      // A notification for finds that landed while Scout was closed — the
      // whole point of the installed app. Independent of the email digest:
      // someone can want a buzz without wanting mail. Never allowed to break
      // the run, so failures are swallowed inside sendToUser.
      void sendToUser(String(s.user_id), {
        title: `${opps.length} new ${opps.length === 1 ? "find" : "finds"}`,
        body: `Scout found ${opps.length === 1 ? "someone" : "people"} for "${String(
          s.label || s.goal
        ).slice(0, 60)}". Tap to review.`,
        url: "/app",
        tag: "new-finds",
      });

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
          lines.push(`   Approve & draft: ${base}/auto/draft?t=${signAction(fid, "approve")}`);
          lines.push(`   Not a fit:       ${base}/api/auto/action?t=${signAction(fid, "deny")}`);
        }
        lines.push(``);
      });
      lines.push(`Open in Scout: ${base}/app`);
      lines.push(`(Manage or stop this auto-search in Scout → Outreach.)`);
      const bodyText = lines.join("\n");
      const subject = `Scout: ${opps.length} new ${opps.length === 1 ? "find" : "finds"} — ${label}`;

      // Branded HTML version, so the digest reads like a real product email
      // instead of a wall of raw links. Table-based + inline styles for email
      // clients; the plain-text bodyText above stays as the fallback.
      const NAVY = "#13273F";
      const cardsHtml = opps
        .map((o, i) => {
          const fid = ids[i];
          const fitPct = typeof o.fitScore === "number" ? Math.round(o.fitScore * 100) : null;
          const contact = [o.contactEmail, o.contactHandle, o.url].filter(Boolean)[0] || "";
          // Approve now opens the review-and-send page (draft ready to edit);
          // Not-a-fit still just records the decision.
          const approve = `${base}/auto/draft?t=${signAction(fid, "approve")}`;
          const deny = `${base}/api/auto/action?t=${signAction(fid, "deny")}`;
          const roleBit = o.contactRole ? `<span style="color:#8A8172"> · ${htmlEsc(o.contactRole)}</span>` : "";
          const fitChip = fitPct != null
            ? `<span style="display:inline-block;background:${NAVY};color:#fff;font-size:11px;font-weight:700;border-radius:999px;padding:2px 9px;margin-left:8px;vertical-align:middle">${fitPct}% fit</span>`
            : "";
          return `
          <tr><td style="padding:0 0 12px">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #D2C9B8;border-radius:14px;box-shadow:0 1px 0 #E7DFD2">
              <tr><td style="padding:16px 18px">
                <div style="font-size:16px;font-weight:800;color:#241C13;line-height:1.3">${htmlEsc(o.name)}${roleBit}${fitChip}</div>
                ${o.whyItFits ? `<div style="font-size:13px;line-height:1.55;color:#57503f;margin-top:6px">${htmlEsc(o.whyItFits)}</div>` : ""}
                ${contact ? `<div style="font-size:12px;color:#8A8172;margin-top:8px;word-break:break-all">${htmlEsc(contact)}</div>` : ""}
                ${fid ? `
                <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:14px"><tr>
                  <td><a href="${approve}" style="display:inline-block;background:${NAVY};color:#ffffff;font-size:13px;font-weight:700;text-decoration:none;padding:10px 20px;border-radius:9px">Approve &amp; draft</a></td>
                  <td style="width:10px"></td>
                  <td><a href="${deny}" style="display:inline-block;background:#ffffff;color:#57503f;font-size:13px;font-weight:700;text-decoration:none;padding:9px 19px;border:1px solid #DED6C7;border-radius:9px">Not a fit</a></td>
                </tr></table>` : ""}
              </td></tr>
            </table>
          </td></tr>`;
        })
        .join("");
      const bodyHtml = `
      <div style="margin:0;padding:0;background:#F5F2EB">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F2EB">
          <tr><td align="center" style="padding:28px 16px">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:820px">
              <tr><td style="background:${NAVY};border-radius:14px 14px 0 0;padding:18px 22px">
                <span style="color:#ffffff;font-size:18px;font-weight:800;letter-spacing:-.01em">Scout</span>
                <span style="color:#9FB0C6;font-size:13px;font-weight:600;margin-left:8px">found ${opps.length} new ${opps.length === 1 ? "match" : "matches"}</span>
              </td></tr>
              <tr><td style="background:#F5F2EB;padding:18px 22px 6px">
                <div style="font-size:14px;color:#57503f;line-height:1.55">
                  For <b style="color:#241C13">${htmlEsc(label)}</b>. Approve the ones worth reaching, pass on the rest, approved contacts land in your Scout pipeline ready to draft.
                </div>
              </td></tr>
              <tr><td style="background:#F5F2EB;padding:12px 22px 4px">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${cardsHtml}</table>
              </td></tr>
              <tr><td style="background:#F5F2EB;padding:6px 22px 26px;border-radius:0 0 14px 14px">
                <a href="${base}/app" style="display:inline-block;color:${NAVY};font-size:13px;font-weight:700;text-decoration:none">Open Scout →</a>
                <div style="font-size:11px;color:#A99E88;margin-top:10px">Manage or stop this auto-search in Scout → Outreach.</div>
              </td></tr>
            </table>
          </td></tr>
        </table>
      </div>`;

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
          html: bodyHtml,
          mode: "send",
        });
        emailed++;
      } else if (outlook.data?.refresh_token) {
        await outlookSendOrDraft({
          refreshToken: outlook.data.refresh_token as string,
          to,
          subject,
          body: bodyText,
          html: bodyHtml,
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
