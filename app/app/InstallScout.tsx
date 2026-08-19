"use client";

import { useEffect, useState } from "react";

/* Getting Scout onto a home screen, explained in the product instead of in a
 * support doc. Three different things have to happen depending on the browser:
 *
 *   - Chrome / Edge / Android fire `beforeinstallprompt`, which we hold onto so
 *     a button here can trigger the real install dialog.
 *   - iOS has no install API at all. Safari only offers it through the Share
 *     sheet, so the honest thing is to show the steps.
 *   - Already installed, or a browser that can't install: say so, or say
 *     nothing.
 */

// Not in lib.dom yet.
type InstallEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export type InstallState = {
  /** Running from the home screen already. */
  installed: boolean;
  /** A real install dialog is available right now. */
  canPrompt: boolean;
  /** iOS, where the only route is the Share sheet. */
  needsManualIos: boolean;
  install: () => Promise<void>;
};

export function useInstallState(): InstallState {
  const [deferred, setDeferred] = useState<InstallEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [isIos, setIsIos] = useState(false);

  useEffect(() => {
    const standalone = () =>
      window.matchMedia("(display-mode: standalone)").matches ||
      // iOS predates the display-mode media query and uses its own flag.
      (navigator as any).standalone === true;
    setInstalled(standalone());

    // iPadOS reports itself as a Mac, so touch points are the tell.
    setIsIos(
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
    );

    const onPrompt = (e: Event) => {
      // Holding the event back is what lets us put the install behind our own
      // button instead of the browser's mini-infobar.
      e.preventDefault();
      setDeferred(e as InstallEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
    };
    const mq = window.matchMedia("(display-mode: standalone)");
    const onDisplay = () => setInstalled(standalone());

    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    mq.addEventListener("change", onDisplay);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
      mq.removeEventListener("change", onDisplay);
    };
  }, []);

  return {
    installed,
    canPrompt: !installed && !!deferred,
    needsManualIos: !installed && !deferred && isIos,
    async install() {
      if (!deferred) return;
      await deferred.prompt();
      await deferred.userChoice;
      // The event is single-use; drop it either way.
      setDeferred(null);
    },
  };
}

function ShareIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="inline-block align-[-2px]"
    >
      <path d="M12 15V3" />
      <path d="m8 7 4-4 4 4" />
      <path d="M4 13v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6" />
    </svg>
  );
}

/** Settings card: install Scout, or the steps to do it by hand on iOS. */
export function InstallCard() {
  const { installed, canPrompt, needsManualIos, install } = useInstallState();

  return (
    <section className="mt-3 rounded-3xl border border-warm-border bg-surface p-5 shadow-soft sm:p-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-md">
          <h2 className="text-base font-extrabold tracking-tight text-ink">
            Scout on your phone
          </h2>
          <p className="mt-1.5 text-sm leading-relaxed text-body">
            {installed
              ? "You're running the installed app. It opens full screen, keeps you signed in, and lives on your home screen like any other app."
              : "Add Scout to your home screen and it opens full screen with its own icon, no browser bar. Same account, same finds."}
          </p>
        </div>
        {canPrompt && (
          <button
            onClick={install}
            className="shrink-0 rounded-xl bg-brand-gradient px-4 py-2.5 text-sm font-bold text-white shadow-soft transition hover:opacity-90"
          >
            Add to home screen
          </button>
        )}
        {installed && (
          <span className="shrink-0 rounded-full bg-success/15 px-3 py-1.5 text-xs font-bold text-success-deep">
            Installed
          </span>
        )}
      </div>

      {needsManualIos && (
        <ol className="mt-4 space-y-2 border-t border-warm-border pt-4 text-sm leading-relaxed text-body">
          <li className="flex gap-2.5">
            <span className="shrink-0 font-bold text-brown-deep">1.</span>
            <span>
              Tap the Share button <ShareIcon /> in Safari&rsquo;s toolbar.
            </span>
          </li>
          <li className="flex gap-2.5">
            <span className="shrink-0 font-bold text-brown-deep">2.</span>
            <span>
              Scroll down and choose <b className="text-ink">Add to Home Screen</b>.
            </span>
          </li>
          <li className="flex gap-2.5">
            <span className="shrink-0 font-bold text-brown-deep">3.</span>
            <span>
              Tap <b className="text-ink">Add</b>. Scout appears on your home
              screen with its own icon.
            </span>
          </li>
        </ol>
      )}

      {!installed && !canPrompt && !needsManualIos && (
        <p className="mt-4 border-t border-warm-border pt-4 text-sm leading-relaxed text-body/80">
          Your browser handles this from its own menu — look for{" "}
          <b className="text-ink">Install</b> or{" "}
          <b className="text-ink">Add to Home Screen</b>. Chrome, Edge, and
          Safari on iOS all support it.
        </p>
      )}
    </section>
  );
}

const DISMISS_KEY = "scout_install_nudge";

/** One-time nudge above the app content on phones that can install. */
export function InstallBanner() {
  const { installed, canPrompt, needsManualIos, install } = useInstallState();
  const [dismissed, setDismissed] = useState(true); // assume dismissed until read

  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(DISMISS_KEY) === "1");
    } catch {
      setDismissed(false);
    }
  }, []);

  const close = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {}
  };

  if (installed || dismissed || (!canPrompt && !needsManualIos)) return null;

  return (
    <div className="flex items-center gap-3 border-b border-warm-border bg-brown-tint/50 px-4 py-2.5 text-sm md:hidden">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/scout-logo.png" alt="" width={22} height={22} className="h-[22px] w-[22px] shrink-0" />
      <div className="min-w-0 flex-1 leading-snug">
        <span className="font-semibold text-ink">Add Scout to your home screen</span>{" "}
        <span className="text-body/80">
          {needsManualIos ? (
            <>
              — Share <ShareIcon /> then Add to Home Screen.
            </>
          ) : (
            "— opens full screen, no browser bar."
          )}
        </span>
      </div>
      {canPrompt && (
        <button
          onClick={install}
          className="shrink-0 rounded-lg bg-brand-gradient px-3 py-1.5 text-xs font-bold text-white shadow-soft transition hover:opacity-90"
        >
          Add
        </button>
      )}
      <button
        onClick={close}
        aria-label="Dismiss"
        className="shrink-0 rounded-lg px-1.5 text-lg leading-none text-body/50 transition hover:text-ink"
      >
        ×
      </button>
    </div>
  );
}
