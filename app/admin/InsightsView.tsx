"use client";

// Owner-only aggregate view of every user's denials, approvals, and reasons.
// Rendered under /admin, gated by /api/admin/whoami. Extracted from the old
// in-sidebar Insights tab so the customer-facing /app view has no trace of it.

import { useEffect, useState } from "react";

interface AdminInsights {
  totals: {
    users: number;
    users_with_state_rows: number;
    finds: number;
    new: number;
    denied: number;
    approved: number;
    drafted: number;
    sent: number;
    replied: number;
  };
  denyReasons: { reason: string; count: number; examples: string[] }[];
  denyByHost: { host: string; count: number }[];
  denyRateByUseCase: { useCase: string; total: number; denied: number; rate: number }[];
  funnel: { finds: number; drafted: number; sent: number; replied: number };
  denials: {
    name: string;
    host: string;
    url: string;
    reason: string;
    useCase: string;
    addedAt: number;
  }[];
  perUser: {
    userId: string;
    finds: number;
    denied: number;
    approved: number;
    updatedAt: string;
    hasFindsField: boolean;
    useCase: string;
  }[];
  generatedAt: string;
}

export default function InsightsView({
  getToken,
}: {
  getToken?: () => Promise<string | null>;
}) {
  const [data, setData] = useState<AdminInsights | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [q, setQ] = useState(""); // free-text filter over the raw denial list

  async function load() {
    if (!getToken) return;
    setBusy(true);
    setError("");
    try {
      const token = await getToken();
      if (!token) throw new Error("Not signed in");
      const res = await fetch("/api/admin/insights", {
        headers: { authorization: `Bearer ${token}` },
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      setData(body);
    } catch (e: any) {
      setError(e?.message || "Failed to load insights.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = data?.denials.filter((d) => {
    if (!q.trim()) return true;
    const s = q.toLowerCase();
    return (
      d.name.toLowerCase().includes(s) ||
      d.reason.toLowerCase().includes(s) ||
      d.host.toLowerCase().includes(s) ||
      d.useCase.toLowerCase().includes(s)
    );
  }) || [];

  function copyDenialsJSON() {
    if (!data) return;
    navigator.clipboard.writeText(JSON.stringify(data.denials, null, 2));
  }

  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-10">
      <div className="mb-6 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight text-ink">
            <span className="brand-text">Insights</span>
          </h1>
          <p className="mt-1 text-sm text-body">
            Owner-only. Every user's denials, approvals, and reasons — the
            signal for tuning the extract prompt and filter.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={load}
            disabled={busy}
            className="rounded-xl border border-warm-border px-3 py-1.5 text-xs font-semibold text-body transition hover:bg-brown-tint disabled:opacity-50"
          >
            {busy ? "Loading…" : "Refresh"}
          </button>
          <button
            onClick={copyDenialsJSON}
            disabled={!data}
            className="rounded-xl bg-brown px-3 py-1.5 text-xs font-bold text-white shadow-soft transition hover:opacity-90 disabled:opacity-50"
          >
            Copy denials JSON
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {!data && !error && busy && (
        <div className="rounded-2xl border border-warm-border bg-surface p-6 text-sm text-body">
          Aggregating across all users…
        </div>
      )}

      {data && (
        <>
          {/* Top-line totals. "State rows" is every user_state row we can see
              (including ones with no finds saved yet); "Users" is only those
              with at least one find. If these two diverge a lot, some users'
              finds aren't landing in Supabase. */}
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              [
                "State rows / Users",
                `${data.totals.users_with_state_rows} / ${data.totals.users}`,
              ],
              ["Finds", data.totals.finds],
              ["Denied", data.totals.denied],
              ["Approved", data.totals.approved],
              ["Drafted", data.totals.drafted],
              ["Sent", data.totals.sent],
              ["Replied", data.totals.replied],
              [
                "Deny rate",
                data.totals.finds
                  ? `${Math.round((data.totals.denied / data.totals.finds) * 100)}%`
                  : "—",
              ],
            ].map(([label, value]) => (
              <div
                key={String(label)}
                className="rounded-2xl border border-warm-border bg-surface p-4"
              >
                <div className="text-[10px] font-bold uppercase tracking-[0.09em] text-muted">
                  {label}
                </div>
                <div className="mt-1 text-2xl font-extrabold text-ink tabular-nums">
                  {value}
                </div>
              </div>
            ))}
          </section>

          {/* Per-user drill-down. If a tester's row is missing here entirely,
              their client never synced to Supabase (incognito, signed out, or
              a different Supabase project). If their row is here but shows 0
              finds, the finds array isn't being saved. */}
          <section className="mt-6 rounded-2xl border border-warm-border bg-surface p-5">
            <h2 className="text-sm font-extrabold uppercase tracking-wide text-ink">
              Per-user (sorted by finds)
            </h2>
            <p className="mt-1 text-xs text-body/70">
              Every row in <code>user_state</code>. Missing testers ⇒ their state
              never hit Supabase.
            </p>
            <div className="mt-3 max-h-64 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-surface">
                  <tr className="text-left text-[10px] font-bold uppercase tracking-wide text-muted">
                    <th className="py-1">User</th>
                    <th className="py-1 text-right">Finds</th>
                    <th className="py-1 text-right">Denied</th>
                    <th className="py-1 text-right">Approved</th>
                    <th className="py-1">Use case</th>
                    <th className="py-1">Has finds field?</th>
                    <th className="py-1">Last saved</th>
                  </tr>
                </thead>
                <tbody>
                  {data.perUser.map((u) => (
                    <tr key={u.userId} className="border-t border-warm-border align-top">
                      <td className="py-1.5 pr-2 font-mono text-[11px] text-body/80">
                        {u.userId}
                      </td>
                      <td className="py-1.5 pr-2 text-right font-bold tabular-nums text-ink">
                        {u.finds}
                      </td>
                      <td className="py-1.5 pr-2 text-right tabular-nums text-body">
                        {u.denied}
                      </td>
                      <td className="py-1.5 pr-2 text-right tabular-nums text-body">
                        {u.approved}
                      </td>
                      <td className="py-1.5 pr-2 text-body/80">
                        {u.useCase || "—"}
                      </td>
                      <td className="py-1.5 pr-2 text-body/80">
                        {u.hasFindsField ? "yes" : (
                          <span className="font-bold text-red-600">no</span>
                        )}
                      </td>
                      <td className="py-1.5 pr-2 text-body/60">
                        {u.updatedAt ? new Date(u.updatedAt).toLocaleString() : "—"}
                      </td>
                    </tr>
                  ))}
                  {data.perUser.length === 0 && (
                    <tr>
                      <td colSpan={7} className="py-3 text-sm text-body/60">
                        No user_state rows found at all.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {/* Deny reasons + top denied hosts side by side */}
          <div className="mt-6 grid gap-6 md:grid-cols-2">
            <section className="rounded-2xl border border-warm-border bg-surface p-5">
              <h2 className="text-sm font-extrabold uppercase tracking-wide text-ink">
                Top deny reasons
              </h2>
              <ul className="mt-3 space-y-2 text-sm">
                {data.denyReasons.slice(0, 15).map((r) => (
                  <li key={r.reason} className="flex items-start gap-3">
                    <span className="mt-0.5 w-10 shrink-0 rounded-lg bg-brown-tint px-2 py-0.5 text-center text-xs font-extrabold text-brown-deep tabular-nums">
                      {r.count}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold text-ink">{r.reason}</div>
                      {r.examples.length > 0 && (
                        <div className="mt-0.5 text-xs text-body/70">
                          e.g. {r.examples.join(", ")}
                        </div>
                      )}
                    </div>
                  </li>
                ))}
                {data.denyReasons.length === 0 && (
                  <li className="text-sm text-body/60">No denials yet.</li>
                )}
              </ul>
            </section>

            <section className="rounded-2xl border border-warm-border bg-surface p-5">
              <h2 className="text-sm font-extrabold uppercase tracking-wide text-ink">
                Top denied hosts
              </h2>
              <ul className="mt-3 space-y-1.5 text-sm">
                {data.denyByHost.map((h) => (
                  <li key={h.host} className="flex items-center gap-3">
                    <span className="w-10 shrink-0 rounded-lg bg-brown-tint px-2 py-0.5 text-center text-xs font-extrabold text-brown-deep tabular-nums">
                      {h.count}
                    </span>
                    <span className="truncate font-semibold text-ink">{h.host}</span>
                  </li>
                ))}
                {data.denyByHost.length === 0 && (
                  <li className="text-sm text-body/60">No hosts yet.</li>
                )}
              </ul>
            </section>
          </div>

          {/* Deny rate per use case */}
          <section className="mt-6 rounded-2xl border border-warm-border bg-surface p-5">
            <h2 className="text-sm font-extrabold uppercase tracking-wide text-ink">
              Deny rate by use case
            </h2>
            <table className="mt-3 w-full text-sm">
              <thead>
                <tr className="text-left text-xs font-bold uppercase tracking-wide text-muted">
                  <th className="py-1">Use case</th>
                  <th className="py-1 text-right">Finds</th>
                  <th className="py-1 text-right">Denied</th>
                  <th className="py-1 text-right">Rate</th>
                </tr>
              </thead>
              <tbody>
                {data.denyRateByUseCase.map((row) => (
                  <tr key={row.useCase} className="border-t border-warm-border">
                    <td className="py-2 font-semibold text-ink">{row.useCase}</td>
                    <td className="py-2 text-right tabular-nums text-body">
                      {row.total}
                    </td>
                    <td className="py-2 text-right tabular-nums text-body">
                      {row.denied}
                    </td>
                    <td className="py-2 text-right tabular-nums font-extrabold text-brown-deep">
                      {Math.round(row.rate * 100)}%
                    </td>
                  </tr>
                ))}
                {data.denyRateByUseCase.length === 0 && (
                  <tr>
                    <td colSpan={4} className="py-3 text-sm text-body/60">
                      No use case data yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </section>

          {/* Raw denial log with search */}
          <section className="mt-6 rounded-2xl border border-warm-border bg-surface p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-extrabold uppercase tracking-wide text-ink">
                Raw denials ({data.denials.length}, newest first)
              </h2>
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Filter by name / reason / host / use case"
                className="w-64 rounded-lg border border-warm-border px-3 py-1.5 text-xs text-ink outline-none focus:border-brown"
              />
            </div>
            <div className="mt-3 max-h-[520px] overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-surface">
                  <tr className="text-left text-[10px] font-bold uppercase tracking-wide text-muted">
                    <th className="py-1">Name</th>
                    <th className="py-1">Reason</th>
                    <th className="py-1">Host</th>
                    <th className="py-1">Use case</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((d, i) => (
                    <tr key={i} className="border-t border-warm-border align-top">
                      <td className="py-1.5 pr-2 font-semibold text-ink">{d.name}</td>
                      <td className="py-1.5 pr-2 text-body">{d.reason}</td>
                      <td className="py-1.5 pr-2 text-body/80">
                        {d.url ? (
                          <a
                            href={d.url}
                            target="_blank"
                            rel="noreferrer"
                            className="underline-offset-2 hover:underline"
                          >
                            {d.host || d.url}
                          </a>
                        ) : (
                          d.host
                        )}
                      </td>
                      <td className="py-1.5 pr-2 text-body/80">{d.useCase}</td>
                    </tr>
                  ))}
                  {filtered.length === 0 && (
                    <tr>
                      <td colSpan={4} className="py-3 text-sm text-body/60">
                        No matches.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <p className="mt-4 text-[11px] text-body/60">
            Generated {new Date(data.generatedAt).toLocaleString()}
          </p>
        </>
      )}
    </main>
  );
}
