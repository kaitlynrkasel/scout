"use client";

// Admin > Metrics: the algorithm's numbers as METRICS THE TEAM DEFINES.
// Each metric is a formula over the raw counters the insights walk exposes
// (a numerator, an optional denominator, and a format); everything here is
// editable and saves for every owner. The Algorithm health panel on
// Insights stays the fixed reference; this tab is the custom set.

import { useEffect, useState } from "react";

interface MetricDef {
  id: string;
  name: string;
  description: string;
  num: string;
  den: string;
  format: "count" | "percent" | "avg";
}

// Plain-language labels for every counter the server exposes.
const CATALOG_LABELS: Record<string, string> = {
  searchFinds: "Finds discovered by search",
  withContact: "Search finds with a contact",
  fitCount: "Finds with a fit score",
  fitHigh: "Finds scoring 80%+ fit",
  bounced: "Bounced messages",
  runs: "Search runs",
  runsAtFloor: "Runs with 5+ finds",
  runFindSum: "Finds across all runs",
  finds: "All finds",
  denied: "Denied finds",
  approved: "Kept finds (drafted or beyond)",
  drafted: "Drafted",
  sent: "Sent",
  replied: "Replied",
  users: "Users with finds",
  searches: "Searches logged",
  decided: "Decided finds (kept + denied)",
  outbound: "Messages out (sent + replied)",
};

function metricValue(m: MetricDef, cat: Record<string, number>): string {
  const num = cat[m.num] ?? 0;
  if (!m.den) return String(num);
  const den = cat[m.den] ?? 0;
  if (!den) return "–";
  if (m.format === "percent") return `${Math.round((num / den) * 100)}%`;
  return (num / den).toFixed(1);
}

export default function MetricsView({
  getToken,
}: {
  getToken: () => Promise<string | null>;
}) {
  const [metrics, setMetrics] = useState<MetricDef[]>([]);
  const [catalog, setCatalog] = useState<Record<string, number> | null>(null);
  const [editable, setEditable] = useState(true);
  const [notReady, setNotReady] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = await getToken();
        if (!token) return;
        const h = { authorization: `Bearer ${token}` };
        const [mr, ir] = await Promise.all([
          fetch("/api/admin/metrics", { headers: h }).then((r) => r.json()),
          fetch("/api/admin/insights", { headers: h }).then((r) => r.json()),
        ]);
        if (cancelled) return;
        setMetrics(Array.isArray(mr?.metrics) ? mr.metrics : []);
        setEditable(mr?.editable !== false);
        setNotReady(!!mr?.notReady);
        setCatalog(ir?.algoCatalog || null);
      } catch {
        if (!cancelled) setNote("Couldn't load the metrics.");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const patch = (i: number, p: Partial<MetricDef>) =>
    setMetrics((ms) => ms.map((m, j) => (j === i ? { ...m, ...p } : m)));

  async function save() {
    if (busy) return;
    setBusy(true);
    setNote("");
    try {
      const token = await getToken();
      const r = await fetch("/api/admin/metrics", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ metrics }),
      });
      const j = await r.json();
      if (!r.ok || j?.error) setNote(j?.error || "Save failed.");
      else {
        setNote("Saved for every owner.");
        setEditing(false);
      }
    } catch (e: any) {
      setNote(e?.message || "Save failed.");
    } finally {
      setBusy(false);
    }
  }

  const catKeys = Object.keys(CATALOG_LABELS);

  return (
    <main className="w-full px-4 py-8 sm:px-6 sm:py-10 xl:px-10">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight text-ink">
            <span className="brand-text">Metrics</span>
          </h1>
          <p className="mt-1 max-w-[70ch] text-sm text-body">
            The algorithm's numbers, as metrics the team defines: each one is a
            counter (or a ratio of two) computed across every account. Edit
            them here; the whole team reads the same set.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {editing ? (
            <>
              <button
                onClick={() =>
                  setMetrics((ms) => [
                    ...ms,
                    {
                      id: Math.random().toString(36).slice(2, 8),
                      name: "New metric",
                      description: "",
                      num: "searchFinds",
                      den: "",
                      format: "count",
                    },
                  ])
                }
                className="rounded-xl border border-warm-border px-3 py-1.5 text-xs font-semibold text-body transition hover:bg-warm-bg"
              >
                Add a metric
              </button>
              <button
                onClick={save}
                disabled={busy}
                className="rounded-xl bg-brown px-4 py-1.5 text-xs font-bold text-white shadow-soft transition hover:opacity-90 disabled:opacity-50"
              >
                {busy ? "Saving…" : "Save"}
              </button>
              <button
                onClick={() => setEditing(false)}
                className="text-xs font-semibold text-body/60 transition hover:text-ink"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              onClick={() => setEditing(true)}
              disabled={!editable}
              title={editable ? "Edit the metric set" : "Run supabase/admin_config.sql to make metrics editable"}
              className="rounded-xl border border-warm-border px-4 py-1.5 text-xs font-bold text-body transition hover:bg-warm-bg disabled:opacity-50"
            >
              Edit metrics
            </button>
          )}
        </div>
      </div>

      {notReady && (
        <p className="mb-5 rounded-xl border border-dashed border-warm-border bg-surface px-4 py-3 text-sm text-body">
          Showing the default set. To edit and save custom metrics, run{" "}
          <code className="rounded bg-warm-bg px-1.5 py-0.5 text-xs">supabase/admin_config.sql</code>{" "}
          once in the Supabase SQL editor, then reload.
        </p>
      )}
      {note && <p className="mb-4 text-sm font-semibold text-body">{note}</p>}

      {!editing ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {metrics.map((m) => (
            <div key={m.id} className="rounded-2xl border border-warm-border bg-surface p-5 shadow-soft">
              <div className="text-3xl font-extrabold tabular-nums text-ink">
                {catalog ? metricValue(m, catalog) : "…"}
              </div>
              <div className="mt-1 text-sm font-bold text-body">{m.name}</div>
              {m.description && <div className="mt-0.5 text-xs text-body/60">{m.description}</div>}
              <div className="mt-2 text-[10px] uppercase tracking-wide text-body/40">
                {CATALOG_LABELS[m.num] || m.num}
                {m.den ? ` ÷ ${CATALOG_LABELS[m.den] || m.den}` : ""}
              </div>
            </div>
          ))}
          {!metrics.length && <p className="text-sm text-body/60">No metrics defined yet.</p>}
        </div>
      ) : (
        <div className="space-y-3">
          {metrics.map((m, i) => (
            <div key={m.id} className="rounded-2xl border border-warm-border bg-surface p-4">
              <div className="grid gap-3 lg:grid-cols-[1fr_1fr_180px_180px_120px_auto]">
                <label className="block">
                  <span className="text-[10px] font-bold uppercase tracking-wide text-body/50">Name</span>
                  <input
                    value={m.name}
                    onChange={(e) => patch(i, { name: e.target.value })}
                    className="mt-1 w-full rounded-lg border border-warm-border bg-surface px-2.5 py-1.5 text-sm text-ink outline-none focus:border-brown"
                  />
                </label>
                <label className="block">
                  <span className="text-[10px] font-bold uppercase tracking-wide text-body/50">Description</span>
                  <input
                    value={m.description}
                    onChange={(e) => patch(i, { description: e.target.value })}
                    className="mt-1 w-full rounded-lg border border-warm-border bg-surface px-2.5 py-1.5 text-sm text-ink outline-none focus:border-brown"
                  />
                </label>
                <label className="block">
                  <span className="text-[10px] font-bold uppercase tracking-wide text-body/50">Count</span>
                  <select
                    value={m.num}
                    onChange={(e) => patch(i, { num: e.target.value })}
                    className="mt-1 w-full rounded-lg border border-warm-border bg-surface px-2 py-1.5 text-sm text-ink outline-none"
                  >
                    {catKeys.map((k) => (
                      <option key={k} value={k}>
                        {CATALOG_LABELS[k]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="text-[10px] font-bold uppercase tracking-wide text-body/50">Divided by</span>
                  <select
                    value={m.den}
                    onChange={(e) => patch(i, { den: e.target.value })}
                    className="mt-1 w-full rounded-lg border border-warm-border bg-surface px-2 py-1.5 text-sm text-ink outline-none"
                  >
                    <option value="">Nothing (plain count)</option>
                    {catKeys.map((k) => (
                      <option key={k} value={k}>
                        {CATALOG_LABELS[k]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="text-[10px] font-bold uppercase tracking-wide text-body/50">Show as</span>
                  <select
                    value={m.format}
                    onChange={(e) => patch(i, { format: e.target.value as MetricDef["format"] })}
                    disabled={!m.den}
                    className="mt-1 w-full rounded-lg border border-warm-border bg-surface px-2 py-1.5 text-sm text-ink outline-none disabled:opacity-50"
                  >
                    <option value="percent">Percent</option>
                    <option value="avg">Average</option>
                  </select>
                </label>
                <div className="flex items-end justify-between gap-3 lg:flex-col lg:items-end">
                  <span className="text-lg font-extrabold tabular-nums text-ink">
                    {catalog ? metricValue(m, catalog) : "…"}
                  </span>
                  <button
                    onClick={() => setMetrics((ms) => ms.filter((_, j) => j !== i))}
                    className="text-xs font-semibold text-body/50 transition hover:text-danger"
                  >
                    Remove
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
