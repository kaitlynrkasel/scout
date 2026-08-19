import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Offline | Scout",
  description: "Scout needs a connection for this.",
};

// Served by the service worker when a page is requested with no network and we
// have no cached copy of it. Static and dependency-free on purpose — it has to
// render from cache alone.
export default function OfflinePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6 py-16 text-center">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/scout-logo.png"
        alt=""
        width={56}
        height={56}
        className="h-14 w-14 opacity-80"
      />
      <h1 className="mt-6 text-2xl font-bold tracking-tight text-ink">
        You&rsquo;re offline
      </h1>
      <p className="mt-3 max-w-sm text-sm leading-relaxed text-body/80">
        Scout searches the live web and drafts through your account, so it needs
        a connection. Anything you already saved is still here once you&rsquo;re
        back on.
      </p>
      <a
        href="/app"
        className="mt-7 rounded-xl bg-brand-gradient px-5 py-2.5 text-sm font-bold text-white shadow-soft transition hover:opacity-90"
      >
        Try again
      </a>
    </main>
  );
}
