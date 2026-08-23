"use client";

// Owner-only aggregate view of every user's denials, approvals, and reasons.
// Rendered under /admin, gated by /api/admin/whoami. Extracted from the old
// in-sidebar Insights tab so the customer-facing /app view has no trace of it.

import { useEffect, useState } from "react";
import workHistory from "./workHistory.json";

interface AdminInsights {
  health?: {
    wau: number;
    mau: number;
    newThisWeek: number;
    dormant: number;
    trend: { week: string; finds: number; sent: number }[];
    signupsByWeek: { week: string; signups: number }[];
    funnelUsers: {
      signedUp: number;
      searched: number;
      found: number;
      drafted: number;
      sent: number;
      replied: number;
    };
  };
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
  algo?: {
    searchFinds: number;
    contactRate: number;
    avgFit: number;
    highFitShare: number;
    keepRate: number;
    replyRate: number;
    bounceRate: number;
    runs: number;
    avgFindsPerRun: number;
    floorRate: number;
  };
  searchCategories?: { name: string; count: number; users: number; examples: string[] }[];
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
  averages: {
    activeUsers: number;
    totalUsers: number;
    meanSearches: number;
    medianSearches: number;
    meanFinds: number;
    medianFinds: number;
    meanDrafts: number;
    meanSent: number;
    meanReplied: number;
  };
  topUsers: UserRow[];
  perUser: UserRow[];
  generatedAt: string;
}

interface UserRow {
  userId: string;
  label: string;
  searches: number;
  drafts: number;
  copies: number;
  finds: number;
  denied: number;
  approved: number;
  sent: number;
  replied: number;
  updatedAt: string;
  hasFindsField: boolean;
  useCase: string;
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
            Owner-only. Every user's denials, approvals, and reasons, the
            signal for tuning the extract prompt and filter.
          </p>
        </div>

      {/* -------- Time on Scout: the build itself, from git history --------
          Regenerate with `node scripts/work-history.mjs` and commit the JSON
          (Vercel's shallow clone can't compute this at build time). */}
      <TimeOnScoutCard />
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
          {/* -------- The pulse: who is here, who is activating, what moved. --------
              Modeled on the standard early-stage playbook: activation and
              retention signals lead; totals are context, not the headline. */}
          {(() => {
            const h = data.health;
            const t = data.totals;
            const denyRate = t.finds ? Math.round((t.denied / t.finds) * 100) : 0;
            const replyRate = t.sent + t.replied ? Math.round((t.replied / (t.sent + t.replied)) * 100) : 0;
            const kpis: [string, string, string][] = h
              ? [
                  [String(h.wau), "Active this week", `${h.mau} this month`],
                  [`+${h.newThisWeek}`, "New signups this week", `${h.funnelUsers.signedUp} accounts total`],
                  [
                    h.funnelUsers.signedUp
                      ? `${Math.round((h.funnelUsers.searched / h.funnelUsers.signedUp) * 100)}%`
                      : "0%",
                    "Activation",
                    "signed up and ran a search",
                  ],
                  [`${replyRate}%`, "Reply rate", `${t.replied} of ${t.sent + t.replied} sent`],
                  [`${denyRate}%`, "Deny rate", `${t.denied} of ${t.finds} finds`],
                  [String(h.dormant), "Dormant 14+ days", "worth a nudge email"],
                ]
              : [];
            const funnel = h
              ? ([
                  ["Signed up", h.funnelUsers.signedUp],
                  ["Ran a search", h.funnelUsers.searched],
                  ["Saved finds", h.funnelUsers.found],
                  ["Drafted", h.funnelUsers.drafted],
                  ["Sent outreach", h.funnelUsers.sent],
                  ["Got a reply", h.funnelUsers.replied],
                ] as [string, number][])
              : [];
            const maxTrend = h ? Math.max(1, ...h.trend.map((w) => w.finds)) : 1;
            const maxSign = h ? Math.max(1, ...h.signupsByWeek.map((w) => w.signups)) : 1;
            return (
              <>
                <section className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
                  {kpis.map(([v, label, sub]) => (
                    <div key={label} className="rounded-2xl border border-warm-border bg-surface p-4">
                      <div className="font-display text-[30px] font-bold leading-none tabular-nums text-ink">{v}</div>
                      <div className="mt-1.5 text-[11.5px] font-semibold text-body">{label}</div>
                      <div className="mt-0.5 text-[10.5px] text-body/55">{sub}</div>
                    </div>
                  ))}
                </section>

                {h && (
                  <div className="mt-4 grid gap-4 lg:grid-cols-2">
                    {/* Activation funnel by users, drop-off between stages. */}
                    <section className="rounded-2xl border border-warm-border bg-surface p-5">
                      <h2 className="text-sm font-extrabold uppercase tracking-wide text-ink">
                        Activation funnel
                      </h2>
                      <p className="mt-0.5 text-[11px] text-body/60">
                        Of everyone who ever signed up, how many reached each stage.
                        The biggest drop is where onboarding work goes.
                      </p>
                      <div className="mt-3.5 space-y-2">
                        {funnel.map(([label, n], i) => {
                          const base = funnel[0][1] || 1;
                          const prev = i > 0 ? funnel[i - 1][1] : n;
                          const keep = prev ? Math.round((n / prev) * 100) : 0;
                          return (
                            <div key={label} className="flex items-center gap-3">
                              <span className="w-24 shrink-0 text-xs font-semibold text-body">{label}</span>
                              <div className="h-5 min-w-0 flex-1 overflow-hidden rounded-md bg-warm-bg">
                                <div
                                  className="flex h-full items-center rounded-md bg-brown px-2 text-[10px] font-bold text-white"
                                  style={{ width: `${Math.max(6, (n / base) * 100)}%` }}
                                >
                                  {n}
                                </div>
                              </div>
                              <span className="w-14 shrink-0 text-right text-[11px] tabular-nums text-body/60">
                                {i > 0 ? `${keep}%` : ""}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </section>

                    {/* Eight-week trend: finds landing, messages going out, signups. */}
                    <section className="rounded-2xl border border-warm-border bg-surface p-5">
                      <h2 className="text-sm font-extrabold uppercase tracking-wide text-ink">
                        Eight-week trend
                      </h2>
                      <p className="mt-0.5 text-[11px] text-body/60">
                        Finds saved (brown), messages sent (blue), signups below.
                      </p>
                      <div className="mt-4 flex h-28 items-end gap-2">
                        {h.trend.map((w) => (
                          <div key={w.week} className="flex min-w-0 flex-1 flex-col items-center gap-1">
                            <div className="flex w-full items-end justify-center gap-0.5" style={{ height: 84 }}>
                              <div
                                className="w-2/5 rounded-t bg-brown"
                                title={`${w.finds} finds`}
                                style={{ height: `${(w.finds / maxTrend) * 100}%`, minHeight: w.finds ? 3 : 0 }}
                              />
                              <div
                                className="w-2/5 rounded-t bg-blue-deep"
                                title={`${w.sent} sent`}
                                style={{ height: `${(w.sent / maxTrend) * 100}%`, minHeight: w.sent ? 3 : 0 }}
                              />
                            </div>
                            <span className="truncate text-[9px] tabular-nums text-body/50">{w.week}</span>
                          </div>
                        ))}
                      </div>
                      <div className="mt-3 border-t border-warm-border pt-2">
                        <div className="flex items-end gap-2">
                          {h.signupsByWeek.map((w) => (
                            <div key={w.week} className="flex min-w-0 flex-1 flex-col items-center gap-1">
                              <div
                                className="w-1/2 rounded-t bg-sage"
                                title={`${w.signups} signups`}
                                style={{ height: 4 + (w.signups / maxSign) * 22 }}
                              />
                            </div>
                          ))}
                        </div>
                        <div className="mt-1 text-center text-[9.5px] text-body/50">signups per week</div>
                      </div>
                    </section>
                  </div>
                )}

                {/* Raw totals, demoted to a single quiet strip. */}
                <section className="mt-4 flex flex-wrap gap-x-5 gap-y-1 rounded-2xl border border-warm-border bg-surface px-4 py-3 text-xs text-body">
                  {[
                    ["Finds", t.finds],
                    ["Approved", t.approved],
                    ["Drafted", t.drafted],
                    ["Sent", t.sent],
                    ["Replied", t.replied],
                    ["Denied", t.denied],
                    ["State rows / users", `${t.users_with_state_rows} / ${t.users}`],
                  ].map(([l, v]) => (
                    <span key={String(l)}>
                      <b className="tabular-nums text-ink">{v}</b> {l}
                    </span>
                  ))}
                </section>
              </>
            );
          })()}

          {/* How much the average user actually uses the platform. Averaged
              over ACTIVE users (ran at least one search or has a find) so
              never-active signups don't flatten the mean. Median shown next to
              mean since a few power users skew the average. */}
          <section className="mt-6 rounded-2xl border border-warm-border bg-surface p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-sm font-extrabold uppercase tracking-wide text-ink">
                Average usage per user
              </h2>
              <span className="text-xs text-body/70">
                {data.averages.activeUsers} active of {data.averages.totalUsers} total
              </span>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                ["Searches", data.averages.meanSearches, data.averages.medianSearches],
                ["Finds", data.averages.meanFinds, data.averages.medianFinds],
                ["Drafts", data.averages.meanDrafts, null],
                ["Sent", data.averages.meanSent, null],
                ["Replied", data.averages.meanReplied, null],
              ].map(([label, mean, med]) => (
                <div
                  key={String(label)}
                  className="rounded-2xl border border-warm-border bg-brown-tint/40 p-4"
                >
                  <div className="text-[10px] font-bold uppercase tracking-[0.09em] text-muted">
                    Avg {label}
                  </div>
                  <div className="mt-1 text-2xl font-extrabold text-ink tabular-nums">
                    {mean}
                  </div>
                  {med !== null && (
                    <div className="mt-0.5 text-[11px] text-body/60 tabular-nums">
                      median {med as number}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>

          {/* Top users by engagement (searches run, then finds). Owner-only, so
              real emails/names are shown to make them recognizable. */}
          <section className="mt-6 rounded-2xl border border-warm-border bg-surface p-5">
            <h2 className="text-sm font-extrabold uppercase tracking-wide text-ink">
              Top users
            </h2>
            <p className="mt-1 text-xs text-body/70">
              Ranked by searches run, then finds saved.
            </p>
            <div className="mt-3 max-h-80 overflow-auto">
              <table className="w-full min-w-[420px] text-xs">
                <thead className="sticky top-0 bg-surface">
                  <tr className="text-left text-[10px] font-bold uppercase tracking-wide text-muted">
                    <th className="py-1 pr-2">#</th>
                    <th className="py-1 pr-2">User</th>
                    <th className="py-1 pr-2 text-right">Searches</th>
                    <th className="py-1 pr-2 text-right">Finds</th>
                    <th className="py-1 pr-2 text-right">Drafts</th>
                    <th className="py-1 pr-2 text-right">Sent</th>
                    <th className="py-1 pr-2 text-right">Replied</th>
                    <th className="py-1 pr-2">Use case</th>
                    <th className="py-1">Last active</th>
                  </tr>
                </thead>
                <tbody>
                  {data.topUsers.map((u, i) => (
                    <tr key={u.userId} className="border-t border-warm-border align-top">
                      <td className="py-1.5 pr-2 tabular-nums text-body/50">{i + 1}</td>
                      <td className="py-1.5 pr-2 font-semibold text-ink">
                        <span className="block max-w-[220px] truncate" title={u.label}>
                          {u.label}
                        </span>
                        {u.userId !== u.label && (
                          <span className="font-mono text-[10px] text-body/45">{u.userId}</span>
                        )}
                      </td>
                      <td className="py-1.5 pr-2 text-right font-bold tabular-nums text-ink">
                        {u.searches}
                      </td>
                      <td className="py-1.5 pr-2 text-right tabular-nums text-body">{u.finds}</td>
                      <td className="py-1.5 pr-2 text-right tabular-nums text-body">{u.drafts}</td>
                      <td className="py-1.5 pr-2 text-right tabular-nums text-body">{u.sent}</td>
                      <td className="py-1.5 pr-2 text-right tabular-nums font-semibold text-sage-deep">
                        {u.replied}
                      </td>
                      <td className="py-1.5 pr-2 text-body/80">{u.useCase || "-"}</td>
                      <td className="py-1.5 text-body/60">
                        {u.updatedAt ? new Date(u.updatedAt).toLocaleDateString() : "-"}
                      </td>
                    </tr>
                  ))}
                  {data.topUsers.length === 0 && (
                    <tr>
                      <td colSpan={9} className="py-3 text-sm text-body/60">
                        No active users yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
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
            <div className="mt-3 max-h-64 overflow-auto">
              <table className="w-full min-w-[420px] text-xs">
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
                        {u.useCase || "-"}
                      </td>
                      <td className="py-1.5 pr-2 text-body/80">
                        {u.hasFindsField ? "yes" : (
                          <span className="font-bold text-red-600">no</span>
                        )}
                      </td>
                      <td className="py-1.5 pr-2 text-body/60">
                        {u.updatedAt ? new Date(u.updatedAt).toLocaleString() : "-"}
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

          {/* Algorithm health: the finding engine's vitals in plain numbers,
              readable by the whole team. */}
          {data.algo && (
            <section className="mt-6 rounded-2xl border border-warm-border bg-surface p-5">
              <h2 className="text-sm font-extrabold uppercase tracking-wide text-ink">
                Algorithm health
              </h2>
              <p className="mt-1 text-xs leading-relaxed text-body/60">
                How well the finding engine is doing, across every account. Keep rate
                is the share of decided finds people kept rather than denied; the
                floor is the five-finds-per-run promise.
              </p>
              <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                {(
                  [
                    [String(data.algo.searchFinds), "Finds discovered", "by search, all time"],
                    [`${Math.round(data.algo.keepRate * 100)}%`, "Keep rate", "kept vs denied, of decided"],
                    [`${Math.round(data.algo.contactRate * 100)}%`, "Arrive reachable", "found with an email or handle"],
                    [`${Math.round(data.algo.avgFit * 100)}%`, "Average fit", `${Math.round(data.algo.highFitShare * 100)}% score 80+`],
                    [`${Math.round(data.algo.replyRate * 100)}%`, "Reply rate", "replied, of sent"],
                    [String(data.algo.runs), "Search runs", "reconstructed from add times"],
                    [data.algo.avgFindsPerRun.toFixed(1), "Finds per run", "average"],
                    [`${Math.round(data.algo.floorRate * 100)}%`, "Hit the 5-find floor", "runs delivering 5 or more"],
                    [`${Math.round(data.algo.bounceRate * 100)}%`, "Bounce rate", "of messages sent"],
                  ] as const
                ).map(([v, label, sub]) => (
                  <div key={label} className="rounded-xl border border-warm-border bg-warm-bg/40 p-3">
                    <div className="text-xl font-extrabold tabular-nums text-ink">{v}</div>
                    <div className="mt-0.5 text-xs font-bold text-body">{label}</div>
                    <div className="text-[11px] text-body/60">{sub}</div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* What people actually use Scout for, read off real searches. */}
          {(data.searchCategories || []).length > 0 && (
            <section className="mt-6 rounded-2xl border border-warm-border bg-surface p-5">
              <h2 className="text-sm font-extrabold uppercase tracking-wide text-ink">
                What people use Scout for
              </h2>
              <p className="mt-1 text-xs leading-relaxed text-body/60">
                Categorized from the goals of real searches (last 5000), not from a
                profile question.
              </p>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[360px] text-sm">
                  <thead>
                    <tr className="text-left text-[11px] font-bold uppercase tracking-wide text-body/50">
                      <th className="py-1.5">Category</th>
                      <th className="py-1.5 text-right">Searches</th>
                      <th className="py-1.5 text-right">People</th>
                      <th className="py-1.5 pl-4">Example goals</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data.searchCategories || []).map((c) => (
                      <tr key={c.name} className="border-t border-warm-border align-top">
                        <td className="py-2 font-semibold text-ink">{c.name}</td>
                        <td className="py-2 text-right tabular-nums text-body">{c.count}</td>
                        <td className="py-2 text-right tabular-nums text-body">{c.users}</td>
                        <td className="py-2 pl-4 text-xs leading-relaxed text-body/70">
                          {c.examples.join(" · ") || "…"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* Deny rate per use case */}
          <section className="mt-6 rounded-2xl border border-warm-border bg-surface p-5">
            <h2 className="text-sm font-extrabold uppercase tracking-wide text-ink">
              Deny rate by use case
            </h2>
            {/* Scrolls inside the card on a narrow screen instead of widening the page. */}
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[360px] text-sm">
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
            </div>
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
            <div className="mt-3 max-h-[520px] overflow-auto">
              <table className="w-full min-w-[520px] text-xs">
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

// ---------------------------------------------------------------------------
// Concierge: pick a target account (or type an email that hasn't signed up),
// run Scout for them, hand-pick the good results (and/or add contacts by hand),
// then queue them. The finds land in that account on their next load/search.
// ---------------------------------------------------------------------------

interface AdminAccount {
  email: string;
  name: string;
  useCase: string;
  hasAccount: boolean;
  finds: number;
  sent: number;
  replied: number;
  searches: number;
  pendingSeeds: number;
  updatedAt: string;
  bio: string;
  accountType: string;
  company: { name: string; about: string; industry: string; stage: string };
  location: string;
  projects: { name: string; useCase: string; context: string }[];
}

type ConciergeOpp = {
  name?: string;
  outlet?: string;
  url?: string;
  channel?: string;
  contactEmail?: string;
  contactName?: string;
  contactRole?: string;
  contactHandle?: string;
  contactPhone?: string;
  location?: string;
  fitScore?: number | null;
  whyItFits?: string;
  sources?: { title: string; url: string; snippet?: string }[];
  [k: string]: unknown;
};

export function ConciergePanel({ getToken }: { getToken?: () => Promise<string | null> }) {
  const [accounts, setAccounts] = useState<AdminAccount[]>([]);
  const [email, setEmail] = useState("");
  const [goal, setGoal] = useState("");
  const [useCase, setUseCase] = useState("");
  const [running, setRunning] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [results, setResults] = useState<ConciergeOpp[]>([]);
  const [picked, setPicked] = useState<Record<number, boolean>>({});
  const [manual, setManual] = useState<ConciergeOpp[]>([]);
  const [showManual, setShowManual] = useState(false);

  const auth = async (): Promise<Record<string, string>> => {
    const t = getToken ? await getToken() : null;
    return t ? { authorization: `Bearer ${t}` } : {};
  };

  async function loadAccounts() {
    try {
      const res = await fetch("/api/admin/accounts", { headers: await auth() });
      const body = await res.json();
      if (res.ok) setAccounts(body.accounts || []);
    } catch {
      /* non-fatal; the email field still works as free text */
    }
  }
  useEffect(() => {
    loadAccounts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selected = accounts.find((a) => a.email === email.trim().toLowerCase());

  async function runSearch() {
    setErr("");
    setMsg("");
    if (!goal.trim()) {
      setErr("Enter a goal to search for.");
      return;
    }
    setRunning(true);
    setResults([]);
    setPicked({});
    try {
      const res = await fetch("/api/admin/run-search", {
        method: "POST",
        headers: { "content-type": "application/json", ...(await auth()) },
        body: JSON.stringify({
          email: email.trim().toLowerCase(),
          goal: goal.trim(),
          useCase: useCase.trim() || undefined,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      const opps: ConciergeOpp[] = body.opportunities || [];
      setResults(opps);
      // Pre-check every result — the operator usually wants most of them.
      const pre: Record<number, boolean> = {};
      opps.forEach((_, i) => (pre[i] = true));
      setPicked(pre);
      if (!opps.length) setMsg("No results for that goal. Try rewording it.");
    } catch (e: any) {
      setErr(e?.message || "Search failed.");
    } finally {
      setRunning(false);
    }
  }

  async function seed() {
    setErr("");
    setMsg("");
    const chosen = results.filter((_, i) => picked[i]);
    const all = [...chosen, ...manual];
    if (!email.trim() || !/.+@.+\..+/.test(email.trim())) {
      setErr("Enter a valid target email.");
      return;
    }
    if (!all.length) {
      setErr("Pick at least one result or add a contact by hand.");
      return;
    }
    setSeeding(true);
    try {
      const res = await fetch("/api/admin/seed", {
        method: "POST",
        headers: { "content-type": "application/json", ...(await auth()) },
        body: JSON.stringify({
          email: email.trim().toLowerCase(),
          opportunities: all,
          note: note.trim() || undefined,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      setMsg(
        `Queued ${body.seeded} find${body.seeded === 1 ? "" : "s"} for ${email
          .trim()
          .toLowerCase()}. They'll appear on that account's next load or search.`
      );
      setResults([]);
      setPicked({});
      setManual([]);
      setNote("");
      loadAccounts();
    } catch (e: any) {
      setErr(e?.message || "Failed to queue.");
    } finally {
      setSeeding(false);
    }
  }

  const chosenCount = results.filter((_, i) => picked[i]).length + manual.length;

  return (
    <section className="mb-8 rounded-2xl border border-sage/40 bg-sage/5 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-extrabold uppercase tracking-wide text-ink">
          Concierge · seed finds for an account
        </h2>
        <span className="text-xs text-body/60">
          Hand-pick finds to warm up a new customer. They land on that account's
          next load or search.
        </span>
      </div>

      {/* Target account */}
      <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr]">
        <div>
          <label className="text-[11px] font-bold uppercase tracking-wide text-muted">
            Target email
          </label>
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            list="concierge-accounts"
            placeholder="pick an account or type any email"
            className="mt-1 w-full rounded-lg border border-warm-border bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-brown"
          />
          <datalist id="concierge-accounts">
            {accounts.map((a) => (
              <option key={a.email} value={a.email}>
                {a.name || a.email} · {a.finds} finds
                {a.pendingSeeds ? ` · ${a.pendingSeeds} queued` : ""}
                {a.hasAccount ? "" : " · no account yet"}
              </option>
            ))}
          </datalist>
          {selected && (
            <p className="mt-1 text-[11px] text-body/70">
              {selected.name || "-"} · {selected.useCase || "no use case"} ·{" "}
              {selected.finds} finds · {selected.sent} sent · {selected.replied}{" "}
              replied
              {selected.pendingSeeds
                ? ` · ${selected.pendingSeeds} already queued`
                : ""}
            </p>
          )}
          {!selected && email.trim() && (
            <p className="mt-1 text-[11px] text-body/70">
              No account yet. Finds will wait here and appear when they sign up.
            </p>
          )}
        </div>
        <div>
          <label className="text-[11px] font-bold uppercase tracking-wide text-muted">
            Use case override (optional)
          </label>
          <input
            value={useCase}
            onChange={(e) => setUseCase(e.target.value)}
            placeholder={selected?.useCase || "defaults to their profile"}
            className="mt-1 w-full rounded-lg border border-warm-border bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-brown"
          />
        </div>
      </div>

      {/* Target's profile — so you know what to plant for them. */}
      {selected && selected.hasAccount && (
        <div className="mt-3 rounded-xl border border-warm-border bg-surface p-4">
          <div className="mb-2 flex flex-wrap items-baseline gap-2">
            <span className="text-[11px] font-bold uppercase tracking-wide text-muted">
              Their profile
            </span>
            <span className="text-sm font-bold text-ink">{selected.name || "(no name)"}</span>
            {selected.accountType && (
              <span className="rounded-full bg-brown-tint px-2 py-0.5 text-[10px] font-bold uppercase text-brown-deep">
                {selected.accountType}
              </span>
            )}
            {selected.useCase && (
              <span className="text-xs text-body/70">goal: {selected.useCase}</span>
            )}
            {selected.location && (
              <span className="text-xs text-body/60">📍 {selected.location}</span>
            )}
          </div>
          {selected.bio && (
            <p className="text-xs leading-relaxed text-body">
              <span className="font-semibold">Bio: </span>
              {selected.bio}
            </p>
          )}
          {(selected.company.name ||
            selected.company.about ||
            selected.company.industry ||
            selected.company.stage) && (
            <p className="mt-1.5 text-xs leading-relaxed text-body">
              <span className="font-semibold">Company: </span>
              {[
                selected.company.name,
                selected.company.industry,
                selected.company.stage,
              ]
                .filter(Boolean)
                .join(" · ")}
              {selected.company.about ? `, ${selected.company.about}` : ""}
            </p>
          )}
          {selected.projects.length > 0 && (
            <div className="mt-2">
              <div className="text-[10px] font-bold uppercase tracking-wide text-muted">
                Projects ({selected.projects.length})
              </div>
              <ul className="mt-1 space-y-1">
                {selected.projects.map((p, i) => (
                  <li key={i} className="text-xs leading-relaxed text-body">
                    <span className="font-semibold text-ink">{p.name || "Untitled"}</span>
                    {p.useCase ? ` · ${p.useCase}` : ""}
                    {p.context ? <span className="text-body/70">, {p.context}</span> : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {!selected.bio &&
            !selected.company.name &&
            selected.projects.every((p) => !p.context) && (
              <p className="text-xs text-body/50">
                This account hasn't filled in much yet. Search on their use case
                and pick broadly.
              </p>
            )}
        </div>
      )}

      {/* Goal + run */}
      <div className="mt-3">
        <label className="text-[11px] font-bold uppercase tracking-wide text-muted">
          What should Scout look for?
        </label>
        <div className="mt-1 flex flex-wrap gap-2">
          <textarea
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            rows={2}
            placeholder="e.g. indie playlist curators accepting bedroom-pop submissions"
            className="min-w-0 flex-1 resize-y rounded-lg border border-warm-border bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-brown"
          />
          <button
            onClick={runSearch}
            disabled={running}
            className="h-fit shrink-0 rounded-xl bg-brown px-4 py-2 text-xs font-bold text-white shadow-soft transition hover:opacity-90 disabled:opacity-50"
          >
            {running ? "Searching…" : "Run Scout"}
          </button>
        </div>
      </div>

      {err && (
        <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {err}
        </div>
      )}
      {msg && (
        <div className="mt-3 rounded-xl border border-sage/40 bg-sage/10 px-3 py-2 text-xs font-semibold text-ink">
          {msg}
        </div>
      )}

      {/* Results to pick from */}
      {results.length > 0 && (
        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] font-bold uppercase tracking-wide text-muted">
              Results, check the ones to send
            </span>
            <span className="text-[11px] text-body/60">
              {results.filter((_, i) => picked[i]).length}/{results.length} picked
            </span>
          </div>
          <div className="max-h-80 space-y-2 overflow-y-auto">
            {results.map((o, i) => (
              <label
                key={i}
                className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition ${
                  picked[i]
                    ? "border-sage/50 bg-sage/10"
                    : "border-warm-border bg-surface"
                }`}
              >
                <input
                  type="checkbox"
                  checked={!!picked[i]}
                  onChange={(e) =>
                    setPicked((p) => ({ ...p, [i]: e.target.checked }))
                  }
                  className="mt-1"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-bold text-ink">{o.name || "(no name)"}</span>
                    {o.contactRole && (
                      <span className="text-xs text-body/70">{o.contactRole}</span>
                    )}
                    {typeof o.fitScore === "number" && (
                      <span className="text-[10px] font-bold text-sage-deep">
                        {Math.round((o.fitScore || 0) * 100)}% fit
                      </span>
                    )}
                  </div>
                  {o.whyItFits && (
                    <p className="mt-0.5 text-xs text-body/80">{o.whyItFits}</p>
                  )}
                  <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-body/60">
                    {o.contactEmail && <span>{o.contactEmail}</span>}
                    {o.contactHandle && <span>{o.contactHandle}</span>}
                    {o.url && (
                      <a
                        href={o.url}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="underline-offset-2 hover:underline"
                      >
                        source
                      </a>
                    )}
                  </div>
                </div>
              </label>
            ))}
          </div>
        </div>
      )}

      {/* Manual add */}
      <div className="mt-4">
        <button
          onClick={() => setShowManual((s) => !s)}
          className="text-xs font-semibold text-accent hover:underline"
        >
          {showManual ? "− Hide manual add" : "+ Add a contact by hand"}
        </button>
        {showManual && <ManualAdd onAdd={(o) => setManual((m) => [...m, o])} />}
        {manual.length > 0 && (
          <ul className="mt-2 space-y-1 text-xs text-body">
            {manual.map((m, i) => (
              <li
                key={i}
                className="flex items-center justify-between rounded-lg border border-warm-border bg-surface px-3 py-1.5"
              >
                <span className="truncate">
                  <span className="font-semibold text-ink">{m.name}</span>
                  {m.contactEmail ? ` · ${m.contactEmail}` : ""}
                </span>
                <button
                  onClick={() =>
                    setManual((arr) => arr.filter((_, j) => j !== i))
                  }
                  className="text-body/50 hover:text-red-600"
                >
                  remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Note + send */}
      {(results.length > 0 || manual.length > 0) && (
        <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-warm-border pt-4">
          <div className="min-w-0 flex-1">
            <label className="text-[11px] font-bold uppercase tracking-wide text-muted">
              Internal note (optional)
            </label>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="why you picked these"
              className="mt-1 w-full rounded-lg border border-warm-border bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-brown"
            />
          </div>
          <button
            onClick={seed}
            disabled={seeding || chosenCount === 0}
            className="shrink-0 rounded-xl bg-brand-gradient px-5 py-2.5 text-sm font-bold text-white shadow-soft transition hover:opacity-95 disabled:opacity-50"
          >
            {seeding
              ? "Queuing…"
              : `Send ${chosenCount} find${chosenCount === 1 ? "" : "s"} →`}
          </button>
        </div>
      )}
    </section>
  );
}

function ManualAdd({ onAdd }: { onAdd: (o: ConciergeOpp) => void }) {
  const [f, setF] = useState({
    name: "",
    contactRole: "",
    contactEmail: "",
    url: "",
    whyItFits: "",
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setF((prev) => ({ ...prev, [k]: e.target.value }));
  const cls =
    "w-full rounded-lg border border-warm-border bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-brown";
  return (
    <div className="mt-2 grid gap-2 rounded-xl border border-warm-border bg-surface/60 p-3 sm:grid-cols-2">
      <input placeholder="Name *" value={f.name} onChange={set("name")} className={cls} />
      <input placeholder="Role / title" value={f.contactRole} onChange={set("contactRole")} className={cls} />
      <input placeholder="Email" value={f.contactEmail} onChange={set("contactEmail")} className={cls} />
      <input placeholder="URL / profile" value={f.url} onChange={set("url")} className={cls} />
      <input
        placeholder="Why it fits (personalization note)"
        value={f.whyItFits}
        onChange={set("whyItFits")}
        className={`${cls} sm:col-span-2`}
      />
      <div className="sm:col-span-2">
        <button
          onClick={() => {
            if (!f.name.trim() && !f.url.trim()) return;
            onAdd({
              name: f.name.trim(),
              contactRole: f.contactRole.trim(),
              contactEmail: f.contactEmail.trim(),
              url: f.url.trim(),
              whyItFits: f.whyItFits.trim(),
              channel: f.contactEmail.trim() ? "Email" : "",
              fitScore: 0.8,
            });
            setF({ name: "", contactRole: "", contactEmail: "", url: "", whyItFits: "" });
          }}
          className="rounded-lg bg-brown px-3 py-1.5 text-xs font-bold text-white transition hover:opacity-90"
        >
          Add to list
        </button>
      </div>
    </div>
  );
}

/* Time on Scout, with a view toggle (per-person bars, or a per-day line graph)
 * and a pickable time window (presets or any custom from/to). Data comes from
 * workHistory.json's per-day series. */
const TW_COLORS = ["#19455e", "#4e9c9c", "#aa2377", "#7a5aa8", "#c07a3c", "#5460ac"];
function TimeOnScoutCard() {
  const days: { date: string; byWho: Record<string, number> }[] =
    (workHistory as any).days || [];
  const [view, setView] = useState<"bars" | "line">("bars");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const preset = (daysBack: number | null) => {
    if (daysBack === null) {
      setFrom("");
      setTo("");
      return;
    }
    const end = new Date();
    const start = new Date(Date.now() - daysBack * 86400000);
    setFrom(start.toISOString().slice(0, 10));
    setTo(end.toISOString().slice(0, 10));
  };
  const inWindow = days.filter(
    (d) => (!from || d.date >= from) && (!to || d.date <= to)
  );
  const whoTotals = new Map<string, number>();
  for (const d of inWindow)
    for (const [w, h] of Object.entries(d.byWho))
      whoTotals.set(w, (whoTotals.get(w) || 0) + h);
  const people = [...whoTotals.entries()]
    .map(([who, hours]) => ({ who, hours: Math.round(hours * 10) / 10 }))
    .sort((a, b) => b.hours - a.hours);
  const windowTotal = Math.round(people.reduce((a, p) => a + p.hours, 0) * 10) / 10;
  const windowed = !!(from || to);

  // Line graph geometry: a continuous calendar axis (zero-hour days included),
  // one line per person.
  const first = inWindow[0]?.date || "";
  const last = inWindow[inWindow.length - 1]?.date || "";
  const axis: string[] = [];
  if (first && last) {
    const t0 = new Date(`${first}T00:00:00Z`).getTime();
    const t1 = new Date(`${last}T00:00:00Z`).getTime();
    for (let t = t0; t <= t1; t += 86400000) axis.push(new Date(t).toISOString().slice(0, 10));
  }
  const byDate = new Map(inWindow.map((d) => [d.date, d.byWho]));
  const maxH = Math.max(0.5, ...inWindow.flatMap((d) => Object.values(d.byWho)));
  const W = 640, H = 170, PADL = 30, PADB = 18;
  const x = (i: number) =>
    PADL + (axis.length < 2 ? 0 : (i * (W - PADL - 6)) / (axis.length - 1));
  const y = (h: number) => 8 + (H - PADB - 8) * (1 - h / maxH);

  return (
    <section className="mb-8 rounded-2xl border border-warm-border bg-surface p-5 shadow-card">
      <div className="flex flex-wrap items-baseline gap-3">
        <h2 className="text-lg font-bold tracking-tight text-ink">Time on Scout</h2>
        <span className="text-xs text-body/60">
          {workHistory.firstCommit} to {workHistory.lastCommit} · {workHistory.totalCommits}{" "}
          commits · {workHistory.claudeAssistedCommits} with Claude · estimated from commit
          sessions, updated {String(workHistory.generatedAt).slice(0, 10)}
        </span>
        <div className="ml-auto inline-flex gap-1 rounded-xl border border-warm-border bg-warm-bg/40 p-1">
          {(
            [
              ["bars", "Totals"],
              ["line", "Line graph"],
            ] as const
          ).map(([v, label]) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`rounded-lg px-3 py-1 text-xs font-bold transition ${
                view === v ? "bg-surface text-ink shadow-card" : "text-body/70 hover:text-ink"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Any window you like: presets, or exact dates. */}
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
        {(
          [
            ["All time", null],
            ["Last 2 weeks", 14],
            ["Last month", 30],
            ["Last 3 months", 90],
          ] as const
        ).map(([label, back]) => {
          const active =
            back === null
              ? !windowed
              : from === new Date(Date.now() - back * 86400000).toISOString().slice(0, 10);
          return (
            <button
              key={label}
              onClick={() => preset(back)}
              className={`rounded-full border px-2.5 py-1 font-semibold transition ${
                active
                  ? "border-brown bg-brown text-white"
                  : "border-warm-border bg-surface text-body hover:bg-warm-bg"
              }`}
            >
              {label}
            </button>
          );
        })}
        <label className="ml-1 flex items-center gap-1 text-body/70">
          from
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="rounded-lg border border-warm-border bg-surface px-2 py-1 text-xs text-ink outline-none"
          />
        </label>
        <label className="flex items-center gap-1 text-body/70">
          to
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="rounded-lg border border-warm-border bg-surface px-2 py-1 text-xs text-ink outline-none"
          />
        </label>
      </div>

      <div className="mt-2 font-display text-4xl font-bold tabular-nums text-ink">
        {windowed ? windowTotal : workHistory.totalHours} hours
        {windowed && (
          <span className="ml-2 text-sm font-semibold text-body/60">
            in this window ({workHistory.totalHours}h all time)
          </span>
        )}
      </div>

      {view === "bars" ? (
        <div className="mt-4 space-y-2">
          {(windowed ? people : (workHistory.people as any[]).map((p: any) => p)).map(
            (p: any, i: number) => (
              <div key={p.who} className="flex items-center gap-3">
                <span className="w-28 shrink-0 truncate text-sm font-semibold text-ink">{p.who}</span>
                <span
                  className="h-2 rounded-full"
                  style={{
                    background: TW_COLORS[i % TW_COLORS.length],
                    width: `${Math.max(2, (p.hours / Math.max(1, windowed ? windowTotal : workHistory.totalHours)) * 100)}%`,
                  }}
                />
                <span className="shrink-0 text-xs tabular-nums text-body/70">
                  {p.hours}h
                  {p.commits ? ` · ${p.commits} commits · ${p.sessions} sittings` : ""}
                </span>
              </div>
            )
          )}
          {windowed && people.length === 0 && (
            <p className="text-sm text-body/60">No work landed in this window.</p>
          )}
        </div>
      ) : axis.length < 2 ? (
        <p className="mt-4 text-sm text-body/60">Not enough days in this window for a line.</p>
      ) : (
        <div className="mt-4">
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Hours per day">
            {[0.25, 0.5, 0.75, 1].map((f) => (
              <g key={f}>
                <line x1={PADL} x2={W - 6} y1={y(maxH * f)} y2={y(maxH * f)} stroke="rgb(var(--c-warm-border))" strokeWidth="1" />
                <text x={PADL - 4} y={y(maxH * f) + 3} textAnchor="end" fontSize="8" fill="rgb(var(--c-body))" opacity="0.55">
                  {Math.round(maxH * f * 10) / 10}h
                </text>
              </g>
            ))}
            {people.map((p, pi) => (
              <polyline
                key={p.who}
                fill="none"
                stroke={TW_COLORS[pi % TW_COLORS.length]}
                strokeWidth="1.8"
                strokeLinejoin="round"
                strokeLinecap="round"
                points={axis
                  .map((d, i) => `${x(i)},${y((byDate.get(d) || {})[p.who] || 0)}`)
                  .join(" ")}
              />
            ))}
            {[0, Math.floor((axis.length - 1) / 2), axis.length - 1].map((i) => (
              <text key={i} x={x(i)} y={H - 4} textAnchor="middle" fontSize="8" fill="rgb(var(--c-body))" opacity="0.55">
                {axis[i]?.slice(5)}
              </text>
            ))}
          </svg>
          <div className="mt-2 flex flex-wrap gap-3">
            {people.map((p, pi) => (
              <span key={p.who} className="flex items-center gap-1.5 text-xs font-semibold text-body">
                <span className="h-2 w-2 rounded-full" style={{ background: TW_COLORS[pi % TW_COLORS.length] }} />
                {p.who} · {p.hours}h
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
