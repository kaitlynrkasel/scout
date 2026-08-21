import webpush from "web-push";
import { supabaseAdmin } from "./supabaseAdmin";

/* Web Push — the one thing an installed Scout couldn't do until now: reach you
 * when it isn't open.
 *
 * iOS only delivers these to an app installed to the home screen (16.4+), which
 * is exactly what app/manifest.ts + public/sw.js set up. In a browser tab on
 * iOS, subscribing silently isn't available — hence the copy in Settings.
 */

const PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || "";
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const SUBJECT = process.env.VAPID_SUBJECT || "mailto:hello@scout-source.com";

/** Push is optional: without keys the app runs exactly as it did before. */
export function pushConfigured(): boolean {
  return !!PUBLIC_KEY && !!PRIVATE_KEY;
}

let ready = false;
function configure(): boolean {
  if (!pushConfigured()) return false;
  if (!ready) {
    webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);
    ready = true;
  }
  return true;
}

export type PushPayload = {
  title: string;
  body: string;
  /** Where tapping it should land. Defaults to the app. */
  url?: string;
  /** Notifications sharing a tag replace each other instead of stacking. */
  tag?: string;
};

/**
 * Send one notification to every live device on an account.
 *
 * Never throws: a notification failing is not a reason for a cron run to die
 * halfway through the work it was actually doing. Returns what happened so a
 * caller can log it.
 */
export async function sendToUser(
  userId: string,
  payload: PushPayload
): Promise<{ sent: number; failed: number; skipped?: string }> {
  if (!configure()) return { sent: 0, failed: 0, skipped: "no VAPID keys" };
  if (!supabaseAdmin) return { sent: 0, failed: 0, skipped: "no service client" };

  const { data: subs } = await supabaseAdmin
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .eq("user_id", userId)
    .is("expired_at", null);

  if (!subs?.length) return { sent: 0, failed: 0, skipped: "no devices" };

  const body = JSON.stringify(payload);
  let sent = 0;
  let failed = 0;

  await Promise.all(
    subs.map(async (s: any) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          body,
          { TTL: 60 * 60 * 12 }
        );
        sent++;
        await supabaseAdmin!
          .from("push_subscriptions")
          .update({ last_used_at: new Date().toISOString() })
          .eq("id", s.id);
      } catch (e: any) {
        failed++;
        // 404/410 mean the subscription is gone for good — the app was
        // uninstalled, or the browser rotated it. Mark it rather than retrying
        // it forever, and rather than deleting it, so the row still explains
        // itself if someone wonders where their notifications went.
        const code = e?.statusCode;
        if (code === 404 || code === 410) {
          await supabaseAdmin!
            .from("push_subscriptions")
            .update({ expired_at: new Date().toISOString() })
            .eq("id", s.id);
        }
      }
    })
  );

  return { sent, failed };
}
