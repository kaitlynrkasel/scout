"use client";

// The launch-readiness checklist as a LIVE, shared page: every verdict saves to
// the shared table and everyone on the page sees everyone else's progress
// within a few seconds. Reached via a secret link (?k=...), no Scout account
// needed, so collaborators can test without signing up. Content mirrors the
// "Scout Launch Readiness" reference document.

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import DATA from "./data.json";

export const dynamic = "force-dynamic";

type Verdict = "" | "ok" | "warn" | "bad";
interface CheckRow {
  key: string;
  verdict: Verdict;
  owner_name: string;
  note: string;
  updated_at: string;
}
interface Item {
  key: string;
  sev: "must" | "should" | "later";
  title: string;
  good: string;
  steps?: string[];
  tech?: string;
}
interface Section {
  id: string;
  title: string;
  blurb: string;
  items: Item[];
}
interface Part {
  part: string;
  title: string;
  intro: string;
  sections: Section[];
}

const SEV_LABEL: Record<string, string> = {
  must: "Must work",
  should: "Should work",
  later: "Later",
};
const VERDICTS: { v: Verdict; label: string }[] = [
  { v: "ok", label: "Works" },
  { v: "warn", label: "Needs work" },
  { v: "bad", label: "Broken" },
];

function ReadinessInner() {
  const k = useSearchParams().get("k") || "";
  const parts = (DATA as any).parts as Part[];
  const allItems = useMemo(
    () => parts.flatMap((p) => p.sections.flatMap((s) => s.items)),
    [parts]
  );
  const [checks, setChecks] = useState<Record<string, CheckRow>>({});
  const [status, setStatus] = useState<"loading" | "live" | "denied" | "notReady">("loading");
  const [openKey, setOpenKey] = useState("");
  const [me, setMe] = useState("");
  const meRef = useRef("");
  useEffect(() => {
    try {
      const saved = localStorage.getItem("scout_readiness_name") || "";
      setMe(saved);
      meRef.current = saved;
    } catch {}
  }, []);

  // Poll shared state every 5s, that's the "real time" everyone shares.
  useEffect(() => {
    if (!k) {
      setStatus("denied");
      return;
    }
    let alive = true;
    async function pull() {
      try {
        const r = await fetch(`/api/readiness?k=${encodeURIComponent(k)}`);
        const j = await r.json();
        if (!alive) return;
        if (r.status === 403) setStatus("denied");
        else if (j.notReady) setStatus("notReady");
        else {
          const map: Record<string, CheckRow> = {};
          for (const c of j.checks || []) map[c.key] = c;
          setChecks(map);
          setStatus("live");
        }
      } catch {
        /* transient; next poll retries */
      }
    }
    pull();
    const id = setInterval(pull, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [k]);

  async function save(key: string, patch: Partial<CheckRow>) {
    const prev = checks[key];
    const next: CheckRow = {
      key,
      verdict: (patch.verdict ?? prev?.verdict ?? "") as Verdict,
      owner_name: patch.owner_name ?? prev?.owner_name ?? meRef.current,
      note: patch.note ?? prev?.note ?? "",
      updated_at: new Date().toISOString(),
    };
    setChecks((c) => ({ ...c, [key]: next })); // optimistic; poll reconciles
    try {
      await fetch(`/api/readiness?k=${encodeURIComponent(k)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          key,
          verdict: next.verdict,
          owner: next.owner_name,
          note: next.note,
        }),
      });
    } catch {
      /* poll will restore truth */
    }
  }

  const done = allItems.filter((i) => checks[i.key]?.verdict).length;
  const counts = {
    ok: allItems.filter((i) => checks[i.key]?.verdict === "ok").length,
    warn: allItems.filter((i) => checks[i.key]?.verdict === "warn").length,
    bad: allItems.filter((i) => checks[i.key]?.verdict === "bad").length,
  };
  const mustLeft = allItems.filter((i) => i.sev === "must" && checks[i.key]?.verdict !== "ok").length;

  if (status === "denied")
    return (
      <Center>
        <p className="text-sm font-bold text-ink">This page needs its link key.</p>
        <p className="mt-1 text-sm text-body/70">
          Open it from the exact link you were sent (it ends in ?k=...).
        </p>
      </Center>
    );
  if (status === "notReady")
    return (
      <Center>
        <p className="text-sm font-bold text-ink">Almost ready.</p>
        <p className="mt-1 text-sm text-body/70">
          The readiness table isn&apos;t in the database yet, run supabase/readiness.sql, then reload.
        </p>
      </Center>
    );

  return (
    <div className="lg:grid lg:h-screen lg:grid-cols-[minmax(0,1fr)_minmax(500px,46%)] lg:overflow-hidden">
      {/* Live Scout on the left (desktop): run the steps without leaving the
          checklist. Same-origin embed, so the security headers allow it. */}
      <div className="hidden border-r border-warm-border lg:flex lg:min-h-0 lg:flex-col">
        <div className="flex items-center gap-2 border-b border-warm-border bg-surface px-4 py-2 text-xs">
          <span className="font-bold text-ink">Scout, live</span>
          <span className="text-body/50">do the steps right here</span>
          <a
            href="/app"
            target="_blank"
            rel="noreferrer"
            className="ml-auto font-semibold text-accent hover:underline"
          >
            Open in its own tab
          </a>
        </div>
        <iframe src="/app" title="Scout" className="min-h-0 w-full flex-1 bg-cream" />
      </div>

      <main className="mx-auto w-full max-w-3xl px-5 pb-24 pt-10 lg:h-screen lg:max-w-none lg:overflow-y-auto lg:px-8">
      <div className="kicker">Scout, before we go live</div>
      <h1 className="mt-2 font-display text-[30px] font-bold leading-[1.05] tracking-[-0.02em] text-ink">
        Launch readiness
      </h1>
      <p className="mt-2 max-w-[60ch] text-sm leading-relaxed text-body/80">
        Shared and live: everyone with this link marks what they tested, and
        everyone sees everyone&apos;s progress within a few seconds. Put your name in
        first so your marks carry it.
      </p>

      {/* Who am I + totals */}
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <input
          value={me}
          onChange={(e) => {
            setMe(e.target.value);
            meRef.current = e.target.value;
            try {
              localStorage.setItem("scout_readiness_name", e.target.value);
            } catch {}
          }}
          placeholder="Your name"
          className="w-40 rounded-xl border border-warm-border bg-surface px-3.5 py-2 text-sm text-ink outline-none focus:border-brown"
        />
        <span className="rounded-full border border-warm-border bg-surface px-3 py-1.5 text-xs font-bold tabular-nums text-ink">
          {done} of {allItems.length} tested
        </span>
        <span className="text-xs font-semibold text-body/70">
          {counts.ok} work · {counts.warn} need work · {counts.bad} broken
        </span>
        <span className={`text-xs font-bold ${mustLeft ? "text-danger" : "text-sage-deep"}`}>
          {mustLeft ? `${mustLeft} must-works left` : "every must-work passes"}
        </span>
        {status === "loading" && <span className="text-xs text-body/50">syncing…</span>}
      </div>

      {parts.map((p) => (
        <div key={p.part} className="mt-10">
          <div className="border-t-2 border-ink pt-4">
            <div className="kicker">{p.part}</div>
            <h2 className="mt-1 text-xl font-extrabold tracking-tight text-ink">{p.title}</h2>
            <p className="mt-1 max-w-[62ch] text-sm text-body/70">{p.intro}</p>
          </div>
          {p.sections.map((s) => (
            <section key={s.id} className="mt-7">
              <h3 className="text-base font-extrabold text-ink">{s.title}</h3>
              <p className="mt-0.5 max-w-[62ch] text-[13px] text-body/60">{s.blurb}</p>
              <div className="mt-3 space-y-2">
                {s.items.map((it) => {
                  const c = checks[it.key];
                  const open = openKey === it.key;
                  return (
                    <div
                      key={it.key}
                      className={`rounded-xl border bg-surface ${
                        c?.verdict === "bad"
                          ? "border-danger/40"
                          : c?.verdict
                            ? "border-warm-border opacity-90"
                            : "border-warm-border"
                      }`}
                    >
                      <div className="px-4 py-3">
                        <button
                          onClick={() => setOpenKey(open ? "" : it.key)}
                          className="flex w-full items-baseline gap-2 text-left"
                        >
                          <span className={`text-[10px] text-body/40 ${open ? "rotate-90" : ""}`}>▶</span>
                          {/* Done marker: verdict color at a glance. */}
                          {c?.verdict && (
                            <span
                              aria-hidden
                              className={`h-2.5 w-2.5 shrink-0 self-center rounded-full ${
                                c.verdict === "ok"
                                  ? "bg-sage"
                                  : c.verdict === "warn"
                                    ? "bg-attention"
                                    : "bg-danger"
                              }`}
                            />
                          )}
                          <span
                            className={`flex-1 text-sm font-bold leading-snug ${
                              c?.verdict && !open ? "text-body/55" : "text-ink"
                            }`}
                          >
                            {it.title}
                          </span>
                        </button>
                        {/* Marked items fold down to one line; open to see detail. */}
                        {(!c?.verdict || open) && (
                          <p className="ml-5 mt-1 text-[13px] leading-relaxed text-body/75">
                            <b className="text-ink/80">Good looks like:</b> {it.good}
                          </p>
                        )}
                        <div className={`ml-5 flex flex-wrap items-center gap-2 ${c?.verdict && !open ? "mt-1.5" : "mt-2.5"}`}>
                          <span
                            className={`rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                              it.sev === "must"
                                ? "bg-danger/10 text-danger"
                                : it.sev === "should"
                                  ? "bg-attention/10 text-attention"
                                  : "bg-warm-bg text-body/60"
                            }`}
                          >
                            {SEV_LABEL[it.sev]}
                          </span>
                          <div className="flex gap-1">
                            {VERDICTS.map(({ v, label }) => (
                              <button
                                key={v}
                                onClick={() =>
                                  save(it.key, {
                                    verdict: c?.verdict === v ? "" : v,
                                    owner_name: meRef.current,
                                  })
                                }
                                className={`rounded-lg border px-2.5 py-1 text-xs font-semibold transition ${
                                  c?.verdict === v
                                    ? v === "ok"
                                      ? "border-sage bg-sage/15 text-sage-deep"
                                      : v === "warn"
                                        ? "border-attention bg-attention/10 text-attention"
                                        : "border-danger bg-danger/10 text-danger"
                                    : "border-warm-border text-body/60 hover:border-brown/40 hover:text-ink"
                                }`}
                              >
                                {label}
                              </button>
                            ))}
                          </div>
                          {c?.verdict && (
                            <span className="text-[11px] text-body/50">
                              {c.owner_name || "someone"} · {String(c.updated_at).slice(5, 10)}
                            </span>
                          )}
                        </div>
                        {open && (
                          <div className="ml-5 mt-3 border-t border-warm-border pt-3">
                            {it.steps && it.steps.length > 0 && (
                              <ol className="list-decimal space-y-1 pl-5 text-[13px] leading-relaxed text-body/80">
                                {it.steps.map((st, i) => (
                                  <li key={i}>{st}</li>
                                ))}
                              </ol>
                            )}
                            {it.tech && (
                              <p className="mt-2 rounded-lg bg-warm-bg/60 px-3 py-2 text-xs leading-relaxed text-body/70">
                                {it.tech}
                              </p>
                            )}
                            <textarea
                              defaultValue={c?.note || ""}
                              key={`${it.key}-${c?.note || ""}`}
                              onBlur={(e) => {
                                if (e.target.value !== (c?.note || ""))
                                  save(it.key, { note: e.target.value, owner_name: meRef.current });
                              }}
                              placeholder="What you saw (saved for everyone)"
                              rows={2}
                              className="mt-3 w-full resize-y rounded-lg border border-warm-border bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-brown"
                            />
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      ))}
      </main>
    </div>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-cream px-6">
      <div className="max-w-sm rounded-2xl border border-warm-border bg-surface p-8 text-center shadow-soft">
        {children}
      </div>
    </div>
  );
}

export default function ReadinessPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-cream" />}>
      <ReadinessInner />
    </Suspense>
  );
}
