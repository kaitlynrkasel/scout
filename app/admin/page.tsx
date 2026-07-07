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

export default function AdminPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [checked, setChecked] = useState(false);
  const [isOwner, setIsOwner] = useState<boolean | null>(null); // null = still probing
  const [adminTab, setAdminTab] = useState<"insights" | "concierge">("insights");

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
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-6 py-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/scout-logo.png" alt="Scout" width={28} height={28} className="h-7 w-7" />
          <span className="text-lg font-extrabold tracking-tight text-ink">Scout · Admin</span>
          <nav className="ml-4 flex items-center gap-1">
            {(["insights", "concierge"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setAdminTab(t)}
                className={`rounded-lg px-3 py-1.5 text-xs font-bold capitalize transition ${
                  adminTab === t
                    ? "bg-brown-tint text-brown-deep"
                    : "text-body hover:bg-brown-tint/50"
                }`}
              >
                {t}
              </button>
            ))}
          </nav>
          <Link
            href="/app"
            className="ml-auto rounded-lg border border-warm-border px-3 py-1.5 text-xs font-semibold text-body transition hover:bg-brown-tint"
          >
            Back to the app
          </Link>
        </div>
      </header>
      {adminTab === "insights" ? (
        <InsightsView getToken={getToken} />
      ) : (
        <main className="mx-auto w-full max-w-6xl px-6 py-10">
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
