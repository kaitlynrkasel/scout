/* Browser side of notifications: ask, subscribe, tell the server, undo.
 *
 * Kept out of the component so the Settings toggle reads as a toggle rather
 * than as a pile of Push API ceremony. */

/** The push service wants the VAPID public key as raw bytes, not base64url. */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padded = base64.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** iOS only offers notifications to an app installed to the home screen. */
export function installedToHomeScreen(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as any).standalone === true
  );
}

export function permission(): NotificationPermission | "unsupported" {
  return pushSupported() ? Notification.permission : "unsupported";
}

/** A name for this device, so a list of subscriptions is readable later. */
function deviceLabel(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Mac/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  return "This device";
}

/**
 * Turn notifications on. Returns null on success, or a sentence explaining why
 * not — the caller shows it as-is, so it has to read like something a person
 * would say.
 */
export async function enablePush(
  vapidPublicKey: string,
  authFetch: (url: string, init?: RequestInit) => Promise<Response>
): Promise<string | null> {
  if (!pushSupported()) {
    return "This browser can't do notifications.";
  }
  if (!vapidPublicKey) {
    return "Notifications aren't set up on the server yet.";
  }
  const perm = await Notification.requestPermission();
  if (perm !== "granted") {
    return perm === "denied"
      ? "Notifications are blocked for Scout. You can allow them again in your browser or system settings."
      : "Notifications weren't turned on.";
  }

  const reg = await navigator.serviceWorker.ready;
  // An existing subscription is reused; the endpoint is stable per install, so
  // this is what keeps one row per device instead of one per toggle.
  const sub =
    (await reg.pushManager.getSubscription()) ||
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
    }));

  const res = await authFetch("/api/push/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ subscription: sub.toJSON(), label: deviceLabel() }),
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    return j?.error || "Couldn't save the subscription.";
  }
  return null;
}

/** Turn them off on this device, both sides. */
export async function disablePush(
  authFetch: (url: string, init?: RequestInit) => Promise<Response>
): Promise<string | null> {
  let endpoint = "";
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      endpoint = sub.endpoint;
      await sub.unsubscribe();
    }
  } catch {
    // Even if the browser side fails, clearing our side is what stops the
    // notifications — so carry on to the request.
  }
  const res = await authFetch("/api/push/subscribe", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint }),
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    return j?.error || "Couldn't turn notifications off.";
  }
  return null;
}
