import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { gmailSendOrDraft } from "@/lib/gmail";
import { outlookSendOrDraft } from "@/lib/outlook";

export const runtime = "nodejs";
export const maxDuration = 300;
// Never cache, the cron runs on a schedule and must see the current queue.
export const dynamic = "force-dynamic";

// Vercel Cron target. Runs on the schedule set in vercel.json and drains any
// scheduled_sends rows whose send_at is now or earlier. Auth: Vercel sends
// `Authorization: Bearer <CRON_SECRET>` when a scheduled cron fires; anyone
// else calling the URL gets 401. Set CRON_SECRET in the Vercel env.
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") || "";
  const secret = process.env.CRON_SECRET || "";
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET not set." }, { status: 500 });
  }
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  if (!supabaseAdmin) {
    return NextResponse.json(
      { error: "Supabase service role not configured." },
      { status: 500 }
    );
  }

  // Pull the batch of due messages. Cap the batch so a large backlog doesn't
  // exceed maxDuration; extras drain on the next tick.
  const BATCH = 25;
  const { data: due, error } = await supabaseAdmin
    .from("scheduled_sends")
    .select("id, user_id, provider, to_addr, subject, body, attachment, find_id, opportunity_id, attempts")
    .lte("send_at", new Date().toISOString())
    .eq("status", "pending")
    .order("send_at", { ascending: true })
    .limit(BATCH);
  if (error) {
    return NextResponse.json(
      { error: `Failed to read queue: ${error.message}` },
      { status: 500 }
    );
  }
  if (!due?.length) {
    return NextResponse.json({ ok: true, checkedAt: new Date().toISOString(), sent: 0 });
  }

  let sent = 0;
  let failed = 0;
  const results: { id: string; status: "sent" | "failed"; error?: string }[] = [];

  for (const row of due) {
    const id = row.id as string;
    const provider = row.provider as "gmail" | "outlook";
    try {
      const conn = await supabaseAdmin
        .from(provider === "gmail" ? "gmail_connections" : "outlook_connections")
        .select("email, refresh_token")
        .eq("user_id", row.user_id)
        .maybeSingle();
      if (!conn.data?.refresh_token) {
        throw new Error(`No ${provider} connection.`);
      }

      // Attachment stored as { name, mime, dataUrl }, unpack to base64 for
      // the provider send helpers, same shape as the /api/gmail/send route.
      let att: { name: string; mime: string; dataBase64: string } | undefined;
      const raw = row.attachment as any;
      if (raw?.dataUrl) {
        const m = String(raw.dataUrl).match(/^data:([^;]+);base64,(.*)$/s);
        const base64 = m ? m[2] : String(raw.dataUrl).replace(/^data:[^,]*,/, "");
        if (base64 && base64.length < 7_000_000) {
          att = {
            name: String(raw.name || "attachment"),
            mime: (m && m[1]) || raw.mime || "application/octet-stream",
            dataBase64: base64,
          };
        }
      }

      const opts = {
        refreshToken: conn.data.refresh_token as string,
        from: (conn.data.email as string) || "me",
        to: row.to_addr as string,
        subject: (row.subject as string) || "",
        body: (row.body as string) || "",
        mode: "send" as const,
        attachment: att,
      };
      if (provider === "gmail") await gmailSendOrDraft(opts);
      else await outlookSendOrDraft(opts);

      await supabaseAdmin
        .from("scheduled_sends")
        .update({
          status: "sent",
          sent_at: new Date().toISOString(),
          attempts: (row.attempts || 0) + 1,
        })
        .eq("id", id);

      // Best-effort: mark the corresponding Find as sent so the user's UI
      // matches reality after their next hydrate. We only have the string
      // find_id (Scout's local key), which lives inside the user_state JSON
      // blob, updating that safely is a big diff, so we skip it here. On
      // next login the client's own status-badge on that find can be
      // re-checked, or the send tracker (Gmail thread id) will catch replies.

      sent++;
      results.push({ id, status: "sent" });
    } catch (e: any) {
      const attempts = (row.attempts || 0) + 1;
      const status = attempts >= 3 ? "failed" : "pending";
      const message = String(e?.message || "unknown error").slice(0, 400);
      // Push send_at forward on transient failures so we don't hammer the
      // same broken row every tick; leave it alone when marking failed
      // (the column is NOT NULL). Status filter keeps failed rows out of the
      // next batch either way.
      const patch: Record<string, unknown> = {
        status,
        attempts,
        last_error: message,
      };
      if (status === "pending") {
        patch.send_at = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      }
      await supabaseAdmin.from("scheduled_sends").update(patch).eq("id", id);
      failed++;
      results.push({ id, status: "failed", error: message });
    }
  }

  return NextResponse.json({
    ok: true,
    checkedAt: new Date().toISOString(),
    considered: due.length,
    sent,
    failed,
    results,
  });
}
