"use client";

import { useCallback, useEffect, useState } from "react";

// Scout is a single-page app, so a tab that has been open since this morning is
// still running this morning's JavaScript. Server-side fixes go live at once
// while the client half stays behind, and the result is indistinguishable from
// the fix not working: you test, nothing changes, and nobody thinks to reload.
//
// So the tab watches for a deploy and says so. The bundle knows the commit it
// was built from; /api/build-id reports the commit the server is running now.
// When they differ, offer a refresh. Never reload on its own, that would throw
// away whatever the person is in the middle of typing.
const MINE = process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA || "";
const EVERY_MS = 120000;

export function UpdateBanner() {
  const [stale, setStale] = useState(false);

  const check = useCallback(async () => {
    if (!MINE || stale) return;
    try {
      const r = await fetch("/api/build-id", { cache: "no-store" });
      if (!r.ok) return;
      const j = await r.json();
      const live = String(j?.build || "");
      if (live && live !== MINE) setStale(true);
    } catch {
      // offline or blocked: nothing to say, try again on the next tick
    }
  }, [stale]);

  useEffect(() => {
    if (!MINE) return; // local dev, or a host that does not report a commit
    void check();
    const timer = setInterval(check, EVERY_MS);
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [check]);

  if (!stale) return null;

  return (
    <div
      role="status"
      className="fixed bottom-4 left-1/2 z-[95] w-[min(92vw,26rem)] -translate-x-1/2 rounded-2xl border border-warm-border bg-surface px-4 py-3 shadow-float"
      style={{ marginBottom: "env(safe-area-inset-bottom)" }}
    >
      <div className="flex items-center gap-3">
        <div className="min-w-0">
          <p className="text-sm font-bold text-ink">A newer Scout is ready</p>
          <p className="mt-0.5 text-xs leading-relaxed text-body/70">
            This tab is still running an older version. Reload to pick up the
            latest changes.
          </p>
        </div>
        <button
          onClick={() => {
            // Drop any cached shell first, so the reload cannot be answered
            // from the copy that is already out of date.
            const go = () => window.location.reload();
            if ("caches" in window) {
              caches
                .keys()
                .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
                .then(go, go);
            } else go();
          }}
          className="ml-auto shrink-0 rounded-xl bg-brown px-3.5 py-2 text-xs font-bold text-white shadow-soft transition hover:opacity-90"
        >
          Reload
        </button>
      </div>
    </div>
  );
}
