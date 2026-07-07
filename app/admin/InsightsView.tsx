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
                  : "-",
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
            <div className="mt-3 max-h-80 overflow-y-auto">
              <table className="w-full text-xs">
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
              {selected.name || "—"} · {selected.useCase || "no use case"} ·{" "}
              {selected.finds} finds · {selected.sent} sent · {selected.replied}{" "}
              replied
              {selected.pendingSeeds
                ? ` · ${selected.pendingSeeds} already queued`
                : ""}
            </p>
          )}
          {!selected && email.trim() && (
            <p className="mt-1 text-[11px] text-body/70">
              No account yet — finds will wait here and appear when they sign up.
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
              {selected.company.about ? ` — ${selected.company.about}` : ""}
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
                    {p.context ? <span className="text-body/70"> — {p.context}</span> : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {!selected.bio &&
            !selected.company.name &&
            selected.projects.every((p) => !p.context) && (
              <p className="text-xs text-body/50">
                This account hasn't filled in much yet — search on their use case
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
              Results — check the ones to send
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
