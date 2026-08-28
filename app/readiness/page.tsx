"use client";

// The launch-readiness checklist as a LIVE, shared page: every verdict saves to
// the shared table and everyone on the page sees everyone else's progress
// within a few seconds. Reached via a secret link (?k=...), no Scout account
// needed, so collaborators can test without signing up. Content mirrors the
// "Scout Launch Readiness" reference document.

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import DATA from "./data.json";
import AUTO from "./auto.json";

export const dynamic = "force-dynamic";

type Verdict = "" | "ok" | "warn" | "bad" | "later";
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
// "Show me where": each section (and some specific items) maps to a guided
// deep link the live pane can open — /app?guide=tab.spot lands the app on the
// right tab and pulses a ring around the tagged control. Item entries win over
// their section's default; sections with no in-app home (database, billing
// infra, the runbook) simply have no link.
const SECTION_GUIDE: Record<string, string> = {
  "getting-in": "outreach",
  setup: "profile",
  finding: "outreach.start",
  applications: "applications",
  importing: "manual.import",
  writing: "templates.tpl-pages",
  sending: "finds.draft-btn",
  autopilot: "outreach",
  learning: "dashboard",
  tracking: "dashboard",
  teams: "team.invite",
  feel: "dashboard",
  paying: "billing",
  settings: "settings",
};
const ITEM_GUIDE: Record<string, string> = {
  // setup items that are not about the profile
  "setup::templates-is-three-pages-behind-one-toggle": "templates.tpl-pages",
  "setup::your-links-prefill-from-the-profile": "templates.tpl-pages",
  "setup::naming-a-project-retunes-its-starter-categories": "projects",
  "setup::you-can-delete-the-last-project": "projects",
  "setup::the-suggested-starting-projects-are-actually-relevant": "projects",
  "setup::a-search-only-auto-creates-a-category-when-it-adds-something": "outreach.start",
  "setup::solo-search-is-not-mistaken-for-the-run-button": "outreach.start",
  "setup::dictation-shows-your-words-as-you-speak": "outreach.goal",
  "setup::voice-dictation-works-where-it-is-offered": "outreach.goal",
  // tracking items that live in Finds or the spreadsheet, not the dashboard
  "tracking::statuses-stick": "finds.status-tabs",
  "tracking::list-and-grid-views-of-finds": "finds.status-tabs",
  "tracking::deep-links-land-on-the-right-row": "finds",
  "tracking::finds-can-be-filtered-by-where-they-came-from": "finds.filters",
  "tracking::your-own-pass-reasons-become-one-tap-options": "finds",
  "tracking::saved-lists-survive-a-reload": "finds",
  "tracking::lists-give-an-outsider-a-clear-status-board": "finds",
  "tracking::writing-results-out-to-google-sheets": "spreadsheet",
  // mailbox connection happens on the profile
  "sending::connect-a-gmail-account": "profile",
  "sending::connect-an-outlook-account": "profile",
  "sending::disconnecting-a-mailbox-stops-everything-queued-for-it": "profile",
  "finding::trash-restore": "finds.deleted",
  "finding::tile-pastel": "finds.status-tabs",
  "writing::template-choice": "finds.draft-btn",
  "writing::no-double-email": "finds.status-tabs",
  "setup::template-scope-new-project": "templates.tpl-scope",
  "importing::manual-research": "manual.add-contact",
  "applications::paste-posting": "applications",
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
  // Items a machine already settled (scripts/readiness-auto.mjs, run with
  // `npm run readiness`). These sit UNDER the shared table: a person's verdict
  // always wins, and clearing one falls back to the machine's rather than to
  // blank, because the code fact is still true either way.
  const autoAt = String((AUTO as any).generatedAt || "");
  const auto = (AUTO as any).checks as Record<string, { verdict: Verdict; note: string }>;
  const merged = useMemo(() => {
    const m: Record<string, CheckRow> = { ...checks };
    for (const [key, a] of Object.entries(auto)) {
      if (m[key]?.verdict) continue;
      m[key] = {
        key,
        verdict: a.verdict,
        owner_name: "checked by code",
        note: checks[key]?.note || a.note,
        updated_at: autoAt,
      };
    }
    return m;
  }, [checks, auto, autoAt]);
  const isAuto = (key: string) => !!auto[key] && !checks[key]?.verdict;
  const [status, setStatus] = useState<"loading" | "live" | "denied" | "notReady">("loading");
  // What the live pane is showing. "Show me where" swaps in a guided URL; the
  // cache-buster lets the same spot be summoned twice in a row.
  const [liveSrc, setLiveSrc] = useState("/app");
  const liveFrameRef = useRef<HTMLIFrameElement>(null);
  // The pane acks guide messages; no ack within a moment means it runs an old
  // bundle (a long-lived tab), so we reload it straight onto the guided URL.
  const guideAckRef = useRef(0);
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if ((e.data as any)?.type === "scout-guide-ack") guideAckRef.current = Date.now();
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);
  function goTour(it: Item, guide: string) {
    if (typeof window === "undefined") return;
    const w = liveFrameRef.current?.contentWindow;
    const url = `/app?guide=${encodeURIComponent(guide)}&t=${Date.now()}`;
    if (window.innerWidth < 900 || !w) {
      window.innerWidth < 900 ? window.open(url, "_blank") : setLiveSrc(url);
      return;
    }
    const asked = Date.now();
    w.postMessage(
      { type: "scout-tour", title: it.title, steps: it.steps || [], guide },
      window.location.origin
    );
    window.setTimeout(() => {
      if (guideAckRef.current < asked) setLiveSrc(url);
    }, 700);
  }
  function goLive(guide: string) {
    if (typeof window === "undefined") return;
    if (window.innerWidth < 900) {
      window.open(`/app?guide=${encodeURIComponent(guide)}`, "_blank");
      return;
    }
    const url = `/app?guide=${encodeURIComponent(guide)}&t=${Date.now()}`;
    const w = liveFrameRef.current?.contentWindow;
    if (!w) {
      setLiveSrc(url);
      return;
    }
    const asked = Date.now();
    w.postMessage({ type: "scout-guide", guide }, window.location.origin);
    window.setTimeout(() => {
      if (guideAckRef.current < asked) setLiveSrc(url);
    }, 700);
  }
  const [openKey, setOpenKey] = useState("");
  // Text filter over all ~276 items: title, description, and section name.
  // Filters survive a refresh, same per-device memory as the name and the
  // split position.
  const [q, setQ] = useState("");
  useEffect(() => {
    try {
      setQ(localStorage.getItem("scout_readiness_q") || "");
      setOnlyUntested(localStorage.getItem("scout_readiness_untested") === "1");
    } catch {}
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem("scout_readiness_q", q);
    } catch {}
  }, [q]);
  // Show only items nobody (human or machine) has marked yet.
  const [onlyUntested, setOnlyUntested] = useState(false);
  useEffect(() => {
    try {
      localStorage.setItem("scout_readiness_untested", onlyUntested ? "1" : "0");
    } catch {}
  }, [onlyUntested]);
  const ql = q.trim().toLowerCase();
  const itemMatches = (it: Item, sTitle: string) =>
    checks[it.key]?.verdict !== "later" &&
    (!ql || `${it.title} ${it.good} ${sTitle}`.toLowerCase().includes(ql)) &&
    (!onlyUntested || !merged[it.key]?.verdict);
  // Items the team pushed off; they live in their own section at the bottom.
  const laterItems = parts.flatMap((p) =>
    p.sections.flatMap((sec) =>
      sec.items
        .filter((it) => checks[it.key]?.verdict === "later")
        .map((it) => ({ it, sTitle: sec.title }))
    )
  );
  // Split position as a percentage of the window width (checklist column).
  // Dragged with a real divider and remembered per device, because how much
  // room each side deserves depends on what you are doing.
  const [splitPct, setSplitPct] = useState(46);
  const dragRef = useRef(false);
  useEffect(() => {
    try {
      const v = Number(localStorage.getItem("scout_readiness_split"));
      if (v >= 25 && v <= 80) setSplitPct(v);
    } catch {}
  }, []);
  useEffect(() => {
    function move(e: PointerEvent) {
      if (!dragRef.current) return;
      const pct = Math.min(80, Math.max(25, (e.clientX / window.innerWidth) * 100));
      setSplitPct(pct);
    }
    function up() {
      if (!dragRef.current) return;
      dragRef.current = false;
      document.body.style.userSelect = "";
      try {
        localStorage.setItem("scout_readiness_split", String(Math.round(splitPct)));
      } catch {}
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [splitPct]);
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

  const done = allItems.filter((i) => {
    const v = merged[i.key]?.verdict;
    return v && v !== "later";
  }).length;
  const counts = {
    ok: allItems.filter((i) => merged[i.key]?.verdict === "ok").length,
    warn: allItems.filter((i) => merged[i.key]?.verdict === "warn").length,
    bad: allItems.filter((i) => merged[i.key]?.verdict === "bad").length,
  };
  const mustLeft = allItems.filter((i) => i.sev === "must" && merged[i.key]?.verdict !== "ok").length;
  const autoCount = allItems.filter((i) => isAuto(i.key)).length;

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
    <>
    <style>{`
      /* Side-by-side as soon as there is room. This used to require a 1024px
         window, so a normal Safari window on a laptop fell back to the stacked
         phone layout. */
      @media (min-width: 900px) {
        .rd-split { display: grid; height: 100vh; overflow: hidden; }
        .rd-pane { height: 100vh; overflow-y: auto; max-width: none; padding-left: 2rem; padding-right: 2rem; }
        .rd-divider { display: flex; }
        .rd-side { display: flex; min-height: 0; flex-direction: column; }
      }
      @media (max-width: 899px) {
        .rd-divider, .rd-side { display: none; }
      }
    `}</style>
    <div
      className="rd-split"
      style={{ gridTemplateColumns: `minmax(0, ${splitPct}fr) 8px minmax(0, ${100 - splitPct}fr)` }}
    >
      <main className="mx-auto w-full max-w-3xl px-5 pb-24 pt-10 rd-pane rd-main">
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
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search the checklist"
          type="search"
          className="w-52 rounded-xl border border-warm-border bg-surface px-3.5 py-2 text-sm text-ink outline-none focus:border-brown"
        />
        <button
          onClick={() => setOnlyUntested((v) => !v)}
          title="Show only the items nobody has marked yet"
          className={`rounded-full border px-3 py-1.5 text-xs font-bold transition ${
            onlyUntested
              ? "border-brown bg-brown text-white"
              : "border-warm-border bg-surface text-body hover:bg-warm-bg"
          }`}
        >
          Untested only · {allItems.length - done}
        </button>
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

      {autoCount > 0 && (
        <p className="mt-3 max-w-[62ch] rounded-lg border border-warm-border bg-warm-bg/60 px-3 py-2 text-xs leading-relaxed text-body/70">
          <b className="text-ink/80">{autoCount} of these are already settled by code.</b> They carry an{" "}
          <span className="rounded border border-warm-border bg-surface px-1 font-bold uppercase tracking-wide">auto</span>{" "}
          tag and the evidence that decided them, from{" "}
          <code className="text-[11px]">npm run readiness</code> at commit {String((AUTO as any).commit || "?")} on{" "}
          {autoAt.slice(0, 10)}. Nobody needs to re-test those by hand, but marking one yourself overrides the machine.
        </p>
      )}

      {(ql || onlyUntested) &&
        parts.every((p) =>
          p.sections.every((s) => s.items.every((it) => !itemMatches(it, s.title)))
        ) && (
          <p className="mt-8 text-sm text-body/60">Nothing on the checklist matches that.</p>
        )}
      {parts.map((p) => {
        const partShown = p.sections.some((s) => s.items.some((it) => itemMatches(it, s.title)));
        if (!partShown) return null;
        return (
        <div key={p.part} className="mt-10">
          <div className="border-t-2 border-ink pt-4">
            <div className="kicker">{p.part}</div>
            <h2 className="mt-1 text-xl font-extrabold tracking-tight text-ink">{p.title}</h2>
            <p className="mt-1 max-w-[62ch] text-sm text-body/70">{p.intro}</p>
          </div>
          {p.sections.map((s) => {
            const shownItems = s.items.filter((it) => itemMatches(it, s.title));
            if (!shownItems.length) return null;
            return (
            <section key={s.id} className="mt-7">
              <h3 className="text-base font-extrabold text-ink">{s.title}</h3>
              <p className="mt-0.5 max-w-[62ch] text-[13px] text-body/60">{s.blurb}</p>
              <div className="mt-3 space-y-2">
                {shownItems.map((it) => {
                  const c = merged[it.key];
                  const machine = isAuto(it.key);
                  const open = openKey === it.key;
                  // Only a clean pass collapses. "Needs work" and "Broken"
                  // stay open: they are the ones that need a note, and folding
                  // them away hides the very thing someone has to come back to.
                  const folded = c?.verdict === "ok" && !open;
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
                      {/* A tested item collapses to ONE row: dot, title, its
                          verdict, and who marked it. Everything else (the
                          description, the verdict buttons, the steps, the note)
                          appears only when it is expanded, so a long finished
                          section reads as a short list instead of a wall. */}
                      <div className={folded ? "px-4 py-2" : "px-4 py-3"}>
                        <button
                          onClick={() => setOpenKey(open ? "" : it.key)}
                          className="flex w-full items-center gap-2 text-left"
                        >
                          <span className={`text-[10px] text-body/40 ${open ? "rotate-90" : ""}`}>▶</span>
                          {c?.verdict && (
                            <span
                              aria-hidden
                              className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                                c.verdict === "ok"
                                  ? "bg-sage"
                                  : c.verdict === "warn"
                                    ? "bg-attention"
                                    : "bg-danger"
                              }`}
                            />
                          )}
                          <span
                            className={`min-w-0 flex-1 leading-snug ${
                              folded
                                ? "truncate text-[13px] font-semibold text-body/60"
                                : "text-sm font-bold text-ink"
                            }`}
                          >
                            {it.title}
                          </span>
                          {folded && (
                            <span className="shrink-0 text-[11px] text-body/45">
                              {VERDICTS.find((v) => v.v === c?.verdict)?.label}
                              {c?.owner_name ? ` · ${c.owner_name}` : ""}
                            </span>
                          )}
                          {!folded && machine && (
                            <span
                              title="Settled by scripts/readiness-auto.mjs, not by a person"
                              className="shrink-0 rounded-md border border-warm-border bg-warm-bg px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-body/55"
                            >
                              auto
                            </span>
                          )}
                        </button>
                        {/* Description lives behind the expander now: an
                            unexpanded row is one line + buttons, so 278 items
                            scan instead of scroll. */}
                        {/* One tidy action row. A walkthrough supersedes the
                            bare jump (it lands AND reads the steps), so items
                            with steps show it as the lead action. */}
                        {!folded &&
                          ((it.steps || []).length > 0 ||
                            ITEM_GUIDE[it.key] ||
                            SECTION_GUIDE[s.id]) && (
                            <div className="ml-5 mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
                              {(it.steps || []).length > 0 ? (
                                <>
                                  <button
                                    onClick={() =>
                                      goTour(it, ITEM_GUIDE[it.key] || SECTION_GUIDE[s.id] || "")
                                    }
                                    className="text-xs font-bold text-accent hover:underline"
                                  >
                                    Walk me through it →
                                  </button>
                                  {!open && (
                                    <button
                                      onClick={() => setOpenKey(it.key)}
                                      className="text-xs font-semibold text-body/50 hover:text-ink hover:underline"
                                    >
                                      Read the steps
                                    </button>
                                  )}
                                </>
                              ) : (
                                <button
                                  onClick={() => goLive(ITEM_GUIDE[it.key] || SECTION_GUIDE[s.id])}
                                  className="text-xs font-bold text-accent hover:underline"
                                >
                                  Show me where in Scout →
                                </button>
                              )}
                            </div>
                          )}
                        <div className={`ml-5 mt-2.5 flex flex-wrap items-center gap-2 ${folded ? "hidden" : ""}`}>
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
                                onClick={() => {
                                  // Toggle against the PERSON's verdict, not the
                                  // merged one: on a machine-checked item the
                                  // buttons start unpressed, so the first click
                                  // records an opinion instead of clearing one.
                                  const next = checks[it.key]?.verdict === v ? "" : v;
                                  save(it.key, {
                                    verdict: next,
                                    owner_name: meRef.current,
                                  });
                                  // A pass tucks itself away; anything else
                                  // opens so the note box is right there.
                                  if (next === "ok") setOpenKey("");
                                  else if (next) setOpenKey(it.key);
                                }}
                                className={`rounded-lg border px-2.5 py-1 text-xs font-semibold transition ${
                                  checks[it.key]?.verdict === v
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
                          <button
                            onClick={() =>
                              save(it.key, {
                                verdict: checks[it.key]?.verdict === "later" ? "" : "later",
                                owner_name: meRef.current,
                              })
                            }
                            title="Park this in the Do later section at the bottom"
                            className="rounded-lg border border-dashed border-warm-border px-2.5 py-1 text-xs font-semibold text-body/60 transition hover:border-brown/40 hover:text-ink"
                          >
                            Do later
                          </button>
                          {c?.verdict && c.verdict !== "later" && (
                            <span className="text-[11px] text-body/50">
                              {c.owner_name || "someone"} · {String(c.updated_at).slice(5, 10)}
                            </span>
                          )}
                        </div>
                        {(open || c?.verdict === "warn" || c?.verdict === "bad") && (
                          <div className="ml-5 mt-3 border-t border-warm-border pt-3">
                            <p className="mb-3 text-[13px] leading-relaxed text-body/75">
                              <b className="text-ink/80">Good looks like:</b> {it.good}
                            </p>
                            {machine && (
                              <div
                                className={`mb-3 rounded-lg border-l-2 px-3 py-2 text-xs leading-relaxed ${
                                  c?.verdict === "ok"
                                    ? "border-sage bg-sage/5 text-body/80"
                                    : c?.verdict === "warn"
                                      ? "border-attention bg-attention/5 text-body/80"
                                      : "border-danger bg-danger/5 text-body/80"
                                }`}
                              >
                                <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-body/50">
                                  What the code says
                                </div>
                                <div className="whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed">
                                  {auto[it.key].note}
                                </div>
                              </div>
                            )}
                            {it.steps && it.steps.length > 0 && (
                              <>
                                <div className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-body/50">
                                  How to test it
                                </div>
                              <ol className="list-decimal space-y-1 pl-5 text-[13px] leading-relaxed text-body/80">
                                {it.steps.map((st, i) => (
                                  <li key={i}>{st}</li>
                                ))}
                              </ol>
                              {open && (
                                <button
                                  onClick={() => setOpenKey("")}
                                  className="mt-2 text-xs font-semibold text-body/50 transition hover:text-ink"
                                >
                                  Hide the steps
                                </button>
                              )}
                              </>
                            )}
                            {it.tech && (
                              <p className="mt-2 rounded-lg bg-warm-bg/60 px-3 py-2 text-xs leading-relaxed text-body/70">
                                {it.tech}
                              </p>
                            )}
                            <textarea
                              defaultValue={checks[it.key]?.note || ""}
                              key={`${it.key}-${checks[it.key]?.note || ""}`}
                              onBlur={(e) => {
                                if (e.target.value !== (checks[it.key]?.note || ""))
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
            );
          })}
        </div>
        );
      })}
      {laterItems.length > 0 && (
        <div className="mt-10">
          <div className="border-t-2 border-ink pt-4">
            <div className="kicker">Parked</div>
            <h2 className="mt-1 text-xl font-extrabold tracking-tight text-ink">Do later</h2>
            <p className="mt-1 max-w-[62ch] text-sm text-body/70">
              Items the team pushed off. Mark one here and it files back into
              its section; Put it back returns it untested.
            </p>
          </div>
          <div className="mt-4 space-y-2">
            {laterItems.map(({ it, sTitle }) => (
              <div key={it.key} className="rounded-xl border border-warm-border bg-surface px-4 py-3">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="min-w-0 flex-1 text-sm font-bold text-ink">{it.title}</span>
                  <span className="shrink-0 text-[11px] text-body/50">{sTitle}</span>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {VERDICTS.map(({ v, label }) => (
                    <button
                      key={v}
                      onClick={() => {
                        save(it.key, { verdict: v, owner_name: meRef.current });
                        if (v === "ok") setOpenKey("");
                        else setOpenKey(it.key);
                      }}
                      className="rounded-lg border border-warm-border px-2.5 py-1 text-xs font-semibold text-body/60 transition hover:border-brown/40 hover:text-ink"
                    >
                      {label}
                    </button>
                  ))}
                  <button
                    onClick={() => save(it.key, { verdict: "", owner_name: meRef.current })}
                    className="rounded-lg px-2.5 py-1 text-xs font-semibold text-body/50 transition hover:text-ink"
                  >
                    Put it back
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      </main>
      {/* Drag to rebalance the two panes. */}
      <div
        role="separator"
        aria-label="Drag to resize the panels"
        title="Drag to resize"
        onPointerDown={(e) => {
          dragRef.current = true;
          document.body.style.userSelect = "none";
          (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
        }}
        className="rd-divider cursor-col-resize items-center justify-center bg-warm-border/40 transition hover:bg-brown/40"
      >
        <span className="h-10 w-0.5 rounded-full bg-body/25" />
      </div>

      {/* Live Scout on the right (desktop): run the steps without leaving the
          checklist. Same-origin embed, so the security headers allow it. */}
      <div className="rd-side border-l border-warm-border">
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
        <iframe ref={liveFrameRef} src={liveSrc} title="Scout" className="min-h-0 w-full flex-1 bg-cream" />
      </div>

    </div>
    </>
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
