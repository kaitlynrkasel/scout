"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabase";

// Email + password sign in / sign up. Supabase handles hashing, sessions, and
// (optionally) email confirmation. On success, the parent's auth listener fires.
export default function AuthScreen() {
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase) return;
    setError("");
    setNotice("");
    setBusy(true);
    try {
      if (mode === "up") {
        const { data, error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        if (!data.session) {
          setNotice(
            "Check your email to confirm your account, then come back and sign in."
          );
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (e: any) {
      setError(e?.message || "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-warm-fade px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2">
          <Logo />
          <span className="text-lg font-extrabold tracking-tight">
            <span className="brand-text">Scout</span>
          </span>
        </div>

        <div className="rounded-3xl border border-warm-border bg-surface p-7 shadow-soft">
          <h1 className="text-xl font-extrabold tracking-tight text-ink">
            {mode === "in" ? "Welcome back" : "Create your account"}
          </h1>
          <p className="mt-1 text-sm text-body">
            {mode === "in"
              ? "Sign in to reach your people."
              : "Your Profile and searches, private to you."}
          </p>

          <form onSubmit={submit} className="mt-5 space-y-3">
            <div>
              <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-body/60">
                Email
              </label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                className="w-full rounded-xl border border-warm-border px-3.5 py-3 text-sm text-ink outline-none transition focus:border-coral focus:ring-4 focus:ring-coral/15"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-body/60">
                Password
              </label>
              <input
                type="password"
                required
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === "in" ? "current-password" : "new-password"}
                className="w-full rounded-xl border border-warm-border px-3.5 py-3 text-sm text-ink outline-none transition focus:border-coral focus:ring-4 focus:ring-coral/15"
              />
            </div>

            {error && (
              <div className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
                {error}
              </div>
            )}
            {notice && (
              <div className="rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-800">
                {notice}
              </div>
            )}

            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-xl bg-brand-gradient px-6 py-3 text-sm font-bold text-white shadow-soft transition hover:opacity-95 disabled:opacity-50"
            >
              {busy ? "…" : mode === "in" ? "Sign in" : "Create account"}
            </button>
          </form>

          <div className="mt-5 text-center text-sm text-body">
            {mode === "in" ? "New to Scout?" : "Already have an account?"}{" "}
            <button
              onClick={() => {
                setMode(mode === "in" ? "up" : "in");
                setError("");
                setNotice("");
              }}
              className="font-semibold text-accent hover:underline"
            >
              {mode === "in" ? "Create an account" : "Sign in"}
            </button>
          </div>
        </div>

        <p className="mt-4 text-center text-xs text-body/60">
          Your Profile is private and only visible to you.
        </p>
      </div>
    </div>
  );
}

function Logo() {
  // The owner's brushed dog-nose mark (also the sidebar/footer/favicon logo).
  return (
    <img src="/scout-logo.png" alt="Scout" width={28} height={28} className="h-7 w-7" />
  );
}
