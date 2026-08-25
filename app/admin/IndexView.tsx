"use client";

// Owner-only gauge for the shared people index (the data flywheel): size,
// growth, reachability, and the newest additions, in plain numbers. Read-only;
// the index itself is written by the discovery engine.

import { useEffect, useState } from "react";

interface IndexStats {
  notReady?: boolean;
  message?: string;
  total: number;
  added7: number;
  added30: number;
  withEmail: number;
  withHandle: number;
  seenOnce: number;
  seenFew: number;
  seenMany: number;
  sampled: number;
  topOutlets: [string, number][];
  days: { day: string; n: number }[];
  recent: {
    name: string;
    role: string;
    outlet: string;
    location: string;
    hasEmail: boolean;
    hasHandle: boolean;
    seen: number;
    lastSeen: string;
  }[];
}

export default function IndexView({
  getToken,
}: {
  getToken: () => Promise<string | null>;
}) {
  const [data, setData] = useState<IndexStats | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = await getToken();
        if (!token) return;
        const res = await fetch("/api/admin/index", {
          headers: { authorization: `Bearer ${token}` },
        });
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) setErr(body?.error || "Couldn't load the index.");
        else setData(body);
      } catch (e: any) {
        if (!cancelled) setErr(e?.message || "Couldn't load the index.");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (err)
    return <p className="rounded-2xl border border-warm-border bg-surface p-6 text-sm text-danger">{err}</p>;
  if (!data)
    return <p className="text-sm text-body/60">Loading the index…</p>;
  if (data.notReady)
    return (
      <div className="rounded-2xl border border-dashed border-warm-border bg-surface p-6 text-sm text-body">
        <p className="font-bold text-ink">The index table isn&apos;t set up yet.</p>
        <p className="mt-1 leading-relaxed">
          Run <code className="rounded bg-warm-bg px-1.5 py-0.5 text-xs">supabase/people_index.sql</code> in
          the Supabase SQL editor, then reload this page. Searches work fine
          without it; they just don&apos;t compound yet.
        </p>
      </div>
    );

  const pct = (n: number) => (data.total ? Math.round((n / Math.min(data.sampled, data.total)) * 100) : 0);
  const maxDay = Math.max(1, ...data.days.map((d) => d.n));
  // One-click backup: the whole table as a dated JSON file on your machine.
  async function downloadBackup() {
    try {
      const token = await getToken();
      if (!token) return;
      const res = await fetch("/api/admin/index?export=1", {
        headers: { authorization: `Bearer ${token}` },
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || "Export failed.");
      const blob = new Blob([JSON.stringify(body, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `people-index-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e: any) {
      setErr(e?.message || "Export failed.");
    }
  }

  const tile = (label: string, value: string, sub?: string) => (
    <div className="rounded-2xl border border-warm-border bg-surface p-5 shadow-soft">
      <div className="text-[11px] font-bold uppercase tracking-wider text-body/50">{label}</div>
      <div className="mt-1 text-3xl font-extrabold tabular-nums text-ink">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-body/60">{sub}</div>}
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <button
          onClick={downloadBackup}
          title="Download the whole index as a dated JSON file"
          className="rounded-xl border border-warm-border bg-surface px-3 py-1.5 text-xs font-semibold text-body transition hover:bg-warm-bg"
        >
          Download a backup
        </button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {tile("People in the index", String(data.total))}
        {tile("Added this week", String(data.added7), `${data.added30} in the last 30 days`)}
        {tile("With an email", `${pct(data.withEmail)}%`, "of recent records")}
        {tile("With a profile link", `${pct(data.withHandle)}%`, "of recent records")}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Growth, last 14 days */}
        <div className="rounded-2xl border border-warm-border bg-surface p-5 shadow-soft">
          <div className="flex items-baseline justify-between gap-2">
            <div className="text-[11px] font-bold uppercase tracking-wider text-body/50">
              New people per day, last 14 days
            </div>
            <div className="text-xs font-bold tabular-nums text-body/70">
              {data.days.reduce((a, d) => a + d.n, 0)} total
            </div>
          </div>
          {data.days.every((d) => d.n === 0) ? (
            <div className="mt-4 grid h-24 place-items-center rounded-xl bg-warm-bg/40 text-xs text-body/50">
              No new people in the last 14 days
            </div>
          ) : (
            <>
              <div className="mt-4 flex h-28 items-end gap-1.5 border-b border-warm-border pb-px">
                {data.days.map((d) => (
                  <div
                    key={d.day}
                    title={`${d.day}: ${d.n} new`}
                    className="flex h-full flex-1 flex-col items-center justify-end gap-0.5"
                  >
                    {d.n > 0 && (
                      <span className="text-[9px] font-bold tabular-nums leading-none text-body/60">
                        {d.n}
                      </span>
                    )}
                    {d.n > 0 ? (
                      <div
                        className="w-full rounded-t bg-brown/75"
                        style={{ height: `${Math.max(6, (d.n / maxDay) * 82)}%` }}
                      />
                    ) : (
                      <div className="h-[3px] w-full rounded-t bg-warm-border" />
                    )}
                  </div>
                ))}
              </div>
              <div className="mt-1 flex justify-between text-[9px] text-body/40">
                <span>{data.days[0]?.day.slice(5)}</span>
                <span>{data.days[Math.floor(data.days.length / 2)]?.day.slice(5)}</span>
                <span>{data.days[data.days.length - 1]?.day.slice(5)}</span>
              </div>
            </>
          )}
          <div className="mt-4 grid grid-cols-3 gap-2">
            {(
              [
                [data.seenOnce, "Seen once"],
                [data.seenFew, "Seen 2 to 4 times"],
                [data.seenMany, "Seen 5+ times"],
              ] as const
            ).map(([n, label]) => (
              <div key={label} className="rounded-xl bg-warm-bg/50 px-3 py-2.5 text-center">
                <div className="text-lg font-extrabold tabular-nums text-ink">{n}</div>
                <div className="text-[10px] font-semibold text-body/60">{label}</div>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-body/50">
            Repeat sightings raise confidence in a record&apos;s details. They never make
            someone rank higher in users&apos; searches, that&apos;s the diversity guard.
          </p>
        </div>

        {/* Top organizations */}
        <div className="rounded-2xl border border-warm-border bg-surface p-5 shadow-soft">
          <div className="text-[11px] font-bold uppercase tracking-wider text-body/50">
            Most-seen organizations
          </div>
          {data.topOutlets.length === 0 ? (
            <p className="mt-3 text-sm text-body/60">Nothing yet, run a search or two.</p>
          ) : (
            <div className="mt-3 space-y-2">
              {data.topOutlets.map(([name, n]) => (
                <div key={name} className="flex items-center gap-2 text-sm">
                  <span className="min-w-0 flex-1 truncate text-ink">{name}</span>
                  <span className="h-1.5 rounded-full bg-brown/60" style={{ width: `${Math.max(8, (n / data.topOutlets[0][1]) * 120)}px` }} />
                  <span className="w-6 text-right text-xs tabular-nums text-body/60">{n}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Newest additions */}
      <div className="overflow-hidden rounded-2xl border border-warm-border bg-surface shadow-soft">
        <div className="border-b border-warm-border px-5 py-3 text-[11px] font-bold uppercase tracking-wider text-body/50">
          Most recently seen
        </div>
        {data.recent.length === 0 ? (
          <p className="p-5 text-sm text-body/60">Empty so far.</p>
        ) : (
          <div className="divide-y divide-warm-border">
            {data.recent.map((r, i) => (
              <div key={i} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-2.5 text-sm">
                <div className="min-w-0 flex-1">
                  <span className="font-semibold text-ink">{r.name}</span>
                  <span className="text-body/60">
                    {[r.role, r.outlet].filter(Boolean).length > 0 && " · "}
                    {[r.role, r.outlet].filter(Boolean).join(", ")}
                  </span>
                </div>
                {r.location && <span className="text-xs text-body/50">{r.location}</span>}
                <span className="text-xs text-body/60">
                  {r.hasEmail ? "email" : r.hasHandle ? "profile" : "no route"}
                </span>
                <span className="text-xs tabular-nums text-body/50" title="times seen · last seen">
                  {r.seen}x · {r.lastSeen}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
