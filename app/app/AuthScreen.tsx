"use client";

import { useState } from "react";
import { supabase, setRememberMe } from "@/lib/supabase";

/**
 * Account screen. Sign up collects first name, last name, email, and password,
 * then verifies the email with a 6-digit code before the account is active.
 * Sign in offers a "Remember me" option. Supabase handles hashing, sessions,
 * sending the confirmation code, and verifying it; on success the parent's auth
 * listener fires and the app loads.
 */

const INPUT =
  "w-full rounded-xl border border-warm-border px-3.5 py-3 text-sm text-ink outline-none transition focus:border-coral focus:ring-4 focus:ring-coral/15";
const LABEL = "mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-body/60";

type Mode = "in" | "up" | "verify" | "forgot" | "newpw";

// `recovery` is set by the parent when the user arrives via a password-reset
// email link (Supabase fires a PASSWORD_RECOVERY auth event); we jump straight
// to the "set a new password" form. onRecoveryDone lets the parent leave the
// recovery screen once the new password is saved.
export default function AuthScreen({
  recovery = false,
  onRecoveryDone,
}: {
  recovery?: boolean;
  onRecoveryDone?: () => void;
} = {}) {
  const [mode, setMode] = useState<Mode>(recovery ? "newpw" : "in");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [remember, setRemember] = useState(true);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const reset = (m: Mode) => {
    setMode(m);
    setError("");
    setNotice("");
    setCode("");
  };

  // Send the "reset your password" email. The link returns the user to /app,
  // where the parent detects the recovery event and shows the newpw form.
  async function sendReset(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase) return;
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const redirectTo =
        typeof window !== "undefined" ? `${window.location.origin}/app` : undefined;
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo });
      if (error) throw error;
      setNotice(
        `If an account exists for ${email.trim()}, a reset link is on its way. Open it on this device to set a new password.`
      );
    } catch (e: any) {
      setError(e?.message || "Couldn't send a reset link. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  // Set the new password (the recovery session from the email link is active).
  async function setNewPassword(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase) return;
    setError("");
    setNotice("");
    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }
    if (password !== confirmPw) {
      setError("Those passwords don't match.");
      return;
    }
    setBusy(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      setNotice("Your password is updated. Taking you in…");
      setTimeout(() => onRecoveryDone?.(), 900);
    } catch (e: any) {
      setError(e?.message || "Couldn't update your password. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function signUp(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase) return;
    setError("");
    setNotice("");
    setBusy(true);
    try {
      // New accounts are remembered by default; they can change it next sign-in.
      setRememberMe(true);
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: {
            first_name: firstName.trim(),
            last_name: lastName.trim(),
            full_name: `${firstName.trim()} ${lastName.trim()}`.trim(),
          },
        },
      });
      if (error) throw error;
      // If the project confirms email (recommended), there's no session yet —
      // send the user to the code step. If confirmation is off, we're already in.
      if (!data.session) {
        setNotice(`We sent a 6-digit code to ${email}. Enter it below to finish.`);
        setMode("verify");
      }
    } catch (e: any) {
      setError(e?.message || "Couldn't create your account. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase) return;
    setError("");
    setBusy(true);
    try {
      const { error } = await supabase.auth.verifyOtp({
        email,
        token: code.trim(),
        type: "signup",
      });
      if (error) throw error;
      // Success creates the session — the parent's auth listener takes over.
    } catch (e: any) {
      setError(e?.message || "That code didn't work. Check it and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    if (!supabase) return;
    setError("");
    setBusy(true);
    try {
      const { error } = await supabase.auth.resend({ type: "signup", email });
      if (error) throw error;
      setNotice(`A new code is on its way to ${email}.`);
    } catch (e: any) {
      setError(e?.message || "Couldn't resend the code. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase) return;
    setError("");
    setNotice("");
    setBusy(true);
    try {
      setRememberMe(remember);
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
    } catch (e: any) {
      setError(e?.message || "Couldn't sign you in. Check your email and password.");
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
            <span className="text-brown">Scout</span>
          </span>
        </div>

        <div className="rounded-3xl border border-warm-border bg-surface p-7 shadow-soft">
          <h1 className="text-xl font-extrabold tracking-tight text-ink">
            {mode === "in"
              ? "Welcome back"
              : mode === "up"
              ? "Create your account"
              : mode === "forgot"
              ? "Reset your password"
              : mode === "newpw"
              ? "Set a new password"
              : "Check your email"}
          </h1>
          <p className="mt-1 text-sm text-body">
            {mode === "in"
              ? "Sign in to reach your people."
              : mode === "up"
              ? "Your Profile and searches, private to you."
              : mode === "forgot"
              ? "Enter your email and we'll send you a link to set a new one."
              : mode === "newpw"
              ? "Choose a new password for your account."
              : `Enter the 6-digit code we sent to ${email}.`}
          </p>

          {/* ---------- Sign in ---------- */}
          {mode === "in" && (
            <form onSubmit={signIn} className="mt-5 space-y-3">
              <div>
                <label className={LABEL}>Email</label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                  className={INPUT}
                />
              </div>
              <div>
                <label className={LABEL}>Password</label>
                <input
                  type="password"
                  required
                  minLength={6}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  className={INPUT}
                />
              </div>
              <div className="flex items-center justify-between pt-0.5">
                <label className="flex cursor-pointer items-center gap-2.5 text-sm text-body">
                  <input
                    type="checkbox"
                    checked={remember}
                    onChange={(e) => setRemember(e.target.checked)}
                    className="h-4 w-4 rounded border-warm-border text-brown accent-brown focus:ring-brown/30"
                  />
                  Remember me
                </label>
                <button
                  type="button"
                  onClick={() => reset("forgot")}
                  className="text-sm font-semibold text-brown hover:underline"
                >
                  Forgot password?
                </button>
              </div>
              <Feedback error={error} notice={notice} />
              <Submit busy={busy}>Sign in</Submit>
            </form>
          )}

          {/* ---------- Forgot password ---------- */}
          {mode === "forgot" && (
            <form onSubmit={sendReset} className="mt-5 space-y-3">
              <div>
                <label className={LABEL}>Email</label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                  className={INPUT}
                />
              </div>
              <Feedback error={error} notice={notice} />
              <Submit busy={busy}>Send reset link</Submit>
              <div className="pt-1 text-center text-xs text-body/70">
                <button type="button" onClick={() => reset("in")} className="hover:text-ink">
                  &larr; Back to sign in
                </button>
              </div>
            </form>
          )}

          {/* ---------- Set a new password (recovery link) ---------- */}
          {mode === "newpw" && (
            <form onSubmit={setNewPassword} className="mt-5 space-y-3">
              <div>
                <label className={LABEL}>New password</label>
                <input
                  type="password"
                  required
                  minLength={6}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  className={INPUT}
                />
              </div>
              <div>
                <label className={LABEL}>Confirm new password</label>
                <input
                  type="password"
                  required
                  minLength={6}
                  value={confirmPw}
                  onChange={(e) => setConfirmPw(e.target.value)}
                  autoComplete="new-password"
                  className={INPUT}
                />
              </div>
              <Feedback error={error} notice={notice} />
              <Submit busy={busy}>Update password</Submit>
            </form>
          )}

          {/* ---------- Sign up ---------- */}
          {mode === "up" && (
            <form onSubmit={signUp} className="mt-5 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={LABEL}>First name</label>
                  <input
                    required
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    autoComplete="given-name"
                    className={INPUT}
                  />
                </div>
                <div>
                  <label className={LABEL}>Last name</label>
                  <input
                    required
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    autoComplete="family-name"
                    className={INPUT}
                  />
                </div>
              </div>
              <div>
                <label className={LABEL}>Email</label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                  className={INPUT}
                />
              </div>
              <div>
                <label className={LABEL}>Password</label>
                <input
                  type="password"
                  required
                  minLength={6}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  className={INPUT}
                />
              </div>
              <Feedback error={error} notice={notice} />
              <Submit busy={busy}>Create account</Submit>
            </form>
          )}

          {/* ---------- Verify code ---------- */}
          {mode === "verify" && (
            <form onSubmit={verify} className="mt-5 space-y-3">
              <div>
                <label className={LABEL}>Verification code</label>
                <input
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  required
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  placeholder="123456"
                  className={`${INPUT} text-center text-lg font-semibold tracking-[0.4em]`}
                />
              </div>
              <Feedback error={error} notice={notice} />
              <Submit busy={busy}>Verify &amp; continue</Submit>
              <div className="flex items-center justify-between pt-1 text-xs text-body/70">
                <button type="button" onClick={() => reset("up")} className="hover:text-ink">
                  &larr; Back
                </button>
                <button
                  type="button"
                  onClick={resend}
                  disabled={busy}
                  className="font-semibold text-brown hover:text-brown-deep disabled:opacity-50"
                >
                  Resend code
                </button>
              </div>
            </form>
          )}

          {(mode === "in" || mode === "up") && (
            <div className="mt-5 text-center text-sm text-body">
              {mode === "in" ? "New to Scout?" : "Already have an account?"}{" "}
              <button
                onClick={() => reset(mode === "in" ? "up" : "in")}
                className="font-semibold text-brown hover:underline"
              >
                {mode === "in" ? "Create an account" : "Sign in"}
              </button>
            </div>
          )}
        </div>

        <p className="mt-4 text-center text-xs text-body/60">
          Your Profile is private and only visible to you.
        </p>
      </div>
    </div>
  );
}

function Feedback({ error, notice }: { error: string; notice: string }) {
  if (!error && !notice) return null;
  return error ? (
    <div className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
      {error}
    </div>
  ) : (
    <div className="rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-800">
      {notice}
    </div>
  );
}

function Submit({ busy, children }: { busy: boolean; children: React.ReactNode }) {
  return (
    <button
      type="submit"
      disabled={busy}
      className="w-full rounded-xl bg-brand-gradient px-6 py-3 text-sm font-bold text-white shadow-soft transition hover:opacity-95 disabled:opacity-50"
    >
      {busy ? "…" : children}
    </button>
  );
}

function Logo() {
  // The owner's brushed dog-nose mark (also the sidebar/footer/favicon logo).
  return (
    <img src="/scout-logo.png" alt="Scout" width={28} height={28} className="h-7 w-7" />
  );
}
