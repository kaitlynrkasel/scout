"use client";

// Owner-only admin page. Separate from the customer /app route so a real user
// never sees a hint the tab exists in the sidebar. Access it by URL:
//   yoursite.com/admin
// Auth is the same Supabase session as /app; ownership check hits the same
// /api/admin/whoami as before.

import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import Link from "next/link";
import InsightsView, { ConciergePanel } from "./InsightsView";
import IndexView from "./IndexView";
import PricingView from "./PricingView";

export default function AdminPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [checked, setChecked] = useState(false);
  const [isOwner, setIsOwner] = useState<boolean | null>(null); // null = still probing
  const [adminTab, setAdminTab] = useState<
    "insights" | "concierge" | "index" | "pricing" | "readiness"
  >("insights");
  // Keyed /readiness link, fetched owner-only so the secret never ships in JS.
  const [readinessPath, setReadinessPath] = useState("");
  useEffect(() => {
    if (adminTab !== "readiness" || readinessPath) return;
    (async () => {
      const token = await getToken();
      if (!token) return;
      try {
        const r = await fetch("/api/readiness/link", {
          headers: { authorization: `Bearer ${token}` },
        });
        const j = await r.json();
        if (r.ok && j.path) setReadinessPath(j.path);
      } catch {}
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminTab]);

  useEffect(() => {
    if (!supabase) {
      setChecked(true);
      return;
    }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setChecked(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s);
      setChecked(true);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) {
      setIsOwner(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const { data } = await supabase!.auth.getSession();
        const token = data.session?.access_token;
        if (!token) return;
        const res = await fetch("/api/admin/whoami", {
          headers: { authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        const body = await res.json();
        if (!cancelled) setIsOwner(!!body?.owner);
      } catch {
        if (!cancelled) setIsOwner(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session]);

  const getToken = async (): Promise<string | null> => {
    if (!supabase) return null;
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  };

  if (!checked) return <CenterMsg text="Loading…" />;
  if (!session)
    return (
      <CenterMsg
        text="Sign in first, then reload this page."
        cta={{ href: "/app", label: "Go to sign in" }}
      />
    );
  if (isOwner === null) return <CenterMsg text="Checking access…" />;
  if (!isOwner)
    return (
      <CenterMsg
        text="Not authorized."
        cta={{ href: "/app", label: "Back to Scout" }}
      />
    );

  return (
    <div className="min-h-screen bg-warm-bg">
      <header className="border-b border-warm-border bg-surface/70">
        {/* One row on a desktop; on a phone the title and the escape hatch share
            the first row and the tabs drop to their own scrollable strip below.
            As a single unwrapped row this was far wider than a phone screen,
            which set the whole page scrolling sideways. */}
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 sm:flex-nowrap sm:px-6 sm:py-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/scout-logo.png" alt="Scout" width={28} height={28} className="h-7 w-7 shrink-0" />
          <span className="text-lg font-extrabold tracking-tight text-ink">Scout · Admin</span>
          <Link
            href="/app"
            className="ml-auto shrink-0 whitespace-nowrap rounded-lg border border-warm-border px-3 py-1.5 text-xs font-semibold text-body transition hover:bg-brown-tint sm:order-last"
          >
            Back to the app
          </Link>
          {/* Full-bleed on mobile so the strip scrolls edge to edge instead of
              looking clipped inside the page padding. */}
          <nav className="-mx-4 flex w-full items-center gap-1 overflow-x-auto px-4 pb-0.5 [scrollbar-width:none] sm:mx-0 sm:ml-4 sm:w-auto sm:overflow-visible sm:px-0">
            {(["insights", "concierge", "index", "pricing", "readiness"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setAdminTab(t)}
                className={`shrink-0 whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-bold capitalize transition ${
                  adminTab === t
                    ? "bg-brown-tint text-brown-deep"
                    : "text-body hover:bg-brown-tint/50"
                }`}
              >
                {t}
              </button>
            ))}
          </nav>
        </div>
      </header>
      {adminTab === "insights" ? (
        <InsightsView getToken={getToken} />
      ) : adminTab === "readiness" ? (
        <main className="mx-auto w-full max-w-none px-0">
          {readinessPath ? (
            <>
              <div className="flex items-center gap-3 border-b border-warm-border bg-surface px-6 py-2 text-xs">
                <span className="font-bold text-ink">Launch readiness</span>
                <span className="text-body/50">shared and live, marks save for everyone</span>
                <button
                  onClick={() => {
                    try {
                      navigator.clipboard.writeText(window.location.origin + readinessPath);
                    } catch {}
                  }}
                  className="ml-auto rounded-lg border border-warm-border px-2.5 py-1 font-semibold text-body transition hover:bg-warm-bg"
                >
                  Copy share link
                </button>
                <a
                  href={readinessPath}
                  target="_blank"
                  rel="noreferrer"
                  className="font-semibold text-accent hover:underline"
                >
                  Open full page
                </a>
              </div>
              <iframe
                src={readinessPath}
                title="Launch readiness"
                className="h-[calc(100vh-105px)] w-full bg-cream"
              />
            </>
          ) : (
            <p className="p-8 text-sm text-body/60">Loading the checklist…</p>
          )}
        </main>
      ) : adminTab === "pricing" ? (
        <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
          <div className="mb-6">
            <h1 className="text-3xl font-extrabold tracking-tight text-ink">
              <span className="brand-text">Pricing model</span>
            </h1>
            <p className="mt-1 text-sm text-body">
              Drag the levers, watch profit move. Everything recalculates
              instantly; your inputs stay saved on this device.
            </p>
          </div>
          <PricingView />
        </main>
      ) : adminTab === "index" ? (
        <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
          <div className="mb-6">
            <h1 className="text-3xl font-extrabold tracking-tight text-ink">
              <span className="brand-text">People index</span>
            </h1>
            <p className="mt-1 text-sm text-body">
              The shared flywheel: every engine-found person, deduplicated,
              compounding across searches. Public-web finds, plus published
              business routes from uploaded spreadsheets (submissions@,
              booking@, info@). A private individual&apos;s personal address
              never enters it.
            </p>
          </div>
          <IndexView getToken={getToken} />
        </main>
      ) : (
        <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
          <div className="mb-6">
            <h1 className="text-3xl font-extrabold tracking-tight text-ink">
              <span className="brand-text">Concierge</span>
            </h1>
            <p className="mt-1 text-sm text-body">
              Hand-pick or run finds for any account (even one that hasn't signed
              up yet). They land on that account's next load or search.
            </p>
          </div>
          <ConciergePanel getToken={getToken} />
        </main>
      )}
    </div>
  );
}

function CenterMsg({
  text,
  cta,
}: {
  text: string;
  cta?: { href: string; label: string };
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-warm-bg">
      <div className="rounded-2xl border border-warm-border bg-surface p-8 text-center shadow-soft">
        <p className="text-sm font-semibold text-ink">{text}</p>
        {cta && (
          <Link
            href={cta.href}
            className="mt-3 inline-block rounded-xl bg-brown px-4 py-2 text-xs font-bold text-white shadow-soft transition hover:opacity-90"
          >
            {cta.label}
          </Link>
        )}
      </div>
    </div>
  );
}
