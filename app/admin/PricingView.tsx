"use client";

// Interactive pricing model: drag the levers, watch profit move. All math is
// client-side and instant; inputs persist per device. Chart colors are the
// validated blue/orange pair (CVD-safe on both themes), profit line rides the
// blue slot. One y-scale per chart, no dual axes.

import { useEffect, useMemo, useRef, useState } from "react";

const STORE = "scout_pricing_model";

interface Model {
  freeUsers: number;
  starterUsers: number;
  proUsers: number;
  starterPrice: number;
  proPrice: number;
  freeSearches: number;
  starterSearches: number;
  proSearches: number;
  costPerSearch: number;
  enrichPerPaid: number;
  enrichCost: number;
  vercelCost: number;
  supabaseCost: number;
  claudeSubCost: number;
  otherFixed: number;
  stripePct: number;
  stripeFlat: number;
}

const DEFAULTS: Model = {
  freeUsers: 200,
  starterUsers: 30,
  proUsers: 10,
  starterPrice: 9,
  proPrice: 29,
  freeSearches: 5,
  starterSearches: 50,
  proSearches: 200,
  costPerSearch: 0.15,
  enrichPerPaid: 0,
  enrichCost: 0.25,
  vercelCost: 20, // Vercel Pro
  supabaseCost: 25, // Supabase Pro
  claudeSubCost: 100, // the Claude subscription that builds and runs Scout
  otherFixed: 5, // domain, email sending, misc
  stripePct: 2.9,
  stripeFlat: 0.3,
};

const fixedTotal = (m: Model) =>
  m.vercelCost + m.supabaseCost + m.claudeSubCost + m.otherFixed;

function computed(m: Model) {
  const paid = m.starterUsers + m.proUsers;
  const mrr = m.starterUsers * m.starterPrice + m.proUsers * m.proPrice;
  const stripeFees = mrr * (m.stripePct / 100) + paid * m.stripeFlat;
  const searches =
    m.freeUsers * m.freeSearches +
    m.starterUsers * m.starterSearches +
    m.proUsers * m.proSearches;
  const searchCost = searches * m.costPerSearch;
  const enrich = paid * m.enrichPerPaid * m.enrichCost;
  const variable = searchCost + enrich + stripeFees;
  const fixed = fixedTotal(m);
  const profit = mrr - variable - fixed;
  const margin = mrr > 0 ? ((mrr - variable) / mrr) * 100 : 0;
  // Everything except fixed costs scales linearly with the user mix, so
  // profit(t) = t * marginAtScale1 - fixed. Breakeven t solves profit = 0.
  const scaleMargin = mrr - variable;
  const breakevenT = scaleMargin > 0 ? fixed / scaleMargin : Infinity;
  const breakevenPaid = Number.isFinite(breakevenT) ? Math.ceil(breakevenT * paid) : null;
  return { paid, mrr, stripeFees, searches, searchCost, enrich, variable, profit, margin, scaleMargin, breakevenPaid };
}

const fmt$ = (n: number) =>
  (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 });

export default function PricingView() {
  const [m, setM] = useState<Model>(DEFAULTS);
  const [showTable, setShowTable] = useState(false);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORE);
      if (raw) {
        const p = JSON.parse(raw);
        // Older saves had one lump "fixedCosts"; carry it into Other fixed.
        if (p.fixedCosts != null && p.vercelCost == null) p.otherFixed = p.fixedCosts;
        delete p.fixedCosts;
        setM({ ...DEFAULTS, ...p });
      }
    } catch {}
  }, []);
  const set = (k: keyof Model) => (v: number) => {
    setM((prev) => {
      const next = { ...prev, [k]: v };
      try {
        localStorage.setItem(STORE, JSON.stringify(next));
      } catch {}
      return next;
    });
  };
  const c = useMemo(() => computed(m), [m]);

  // Profit curve: scale the whole user mix 0x..2.5x, profit at each point.
  const curve = useMemo(() => {
    const pts: { paid: number; profit: number }[] = [];
    for (let i = 0; i <= 40; i++) {
      const t = (i / 40) * 2.5;
      pts.push({ paid: Math.round(t * c.paid), profit: t * c.scaleMargin - fixedTotal(m) });
    }
    return pts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.paid, c.scaleMargin, m.vercelCost, m.supabaseCost, m.claudeSubCost, m.otherFixed]);

  const breakdown = [
    { name: "Revenue (MRR)", value: c.mrr, kind: "rev" as const },
    { name: "Search costs", value: c.searchCost, kind: "cost" as const },
    { name: "Enrichment", value: c.enrich, kind: "cost" as const },
    { name: "Stripe fees", value: c.stripeFees, kind: "cost" as const },
    { name: "Fixed: tools", value: fixedTotal(m), kind: "cost" as const },
  ];

  return (
    <div className="space-y-6">
      {/* Validated chart colors, light + dark steps (blue/orange, CVD-safe). */}
      <style>{`:root{--ch-rev:#2a78d6;--ch-cost:#eb6834}html.dark{--ch-rev:#3987e5;--ch-cost:#d95926}`}</style>

      {/* First-timer's guide, collapsed by default */}
      <details className="rounded-2xl border border-warm-border bg-surface px-5 py-4 shadow-soft">
        <summary className="cursor-pointer text-sm font-bold text-ink">
          New to pricing models? Read this first (60 seconds)
        </summary>
        <div className="mt-3 space-y-2 text-sm leading-relaxed text-body/80">
          <p><b className="text-ink">MRR</b> (monthly recurring revenue): what subscribers pay you each month. The number investors and founders track first.</p>
          <p><b className="text-ink">Gross margin</b>: of every revenue dollar, how much is left after the costs that scale with usage (searches, enrichment, card fees). It measures whether the product itself is profitable, before rent-like fixed costs.</p>
          <p><b className="text-ink">Breakeven</b>: how many paying users you need before profit crosses zero, keeping today's mix of tiers and prices.</p>
          <p><b className="text-ink">Per-user economics</b>: what one user of each tier nets you per month. If a tier is negative, every new subscriber on it loses you money, growth makes things worse, not better.</p>
          <p>Play pattern: change ONE lever, watch which tiles move. The advice box below the tiles explains what the current numbers are telling you.</p>
        </div>
      </details>

      {/* Hero numbers */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Monthly profit" value={fmt$(c.profit)} tone={c.profit >= 0 ? "good" : "bad"} sub={c.profit >= 0 ? "after every cost" : "loss at this mix"} />
        <Tile label="MRR" value={fmt$(c.mrr)} sub={`${c.paid} paying of ${m.freeUsers + c.paid} users`} />
        <Tile label="Gross margin" value={`${Math.round(c.margin)}%`} sub="revenue minus variable costs" />
        <Tile
          label="Breakeven"
          value={c.breakevenPaid == null ? "never" : `${c.breakevenPaid} paid`}
          tone={c.breakevenPaid == null ? "bad" : undefined}
          sub={c.breakevenPaid == null ? "unit economics negative" : "paying users at this mix"}
        />
      </div>

      {/* Industry benchmarks + what-this-means advice */}
      <HealthCard m={m} c={c} />

      <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
        {/* ---- Levers ---- */}
        <div className="space-y-4">
          <Panel title="Users">
            <Lever label="Free users" v={m.freeUsers} set={set("freeUsers")} min={0} max={5000} step={10} />
            <Lever label="Starter subscribers" v={m.starterUsers} set={set("starterUsers")} min={0} max={1000} step={1} />
            <Lever label="Pro subscribers" v={m.proUsers} set={set("proUsers")} min={0} max={500} step={1} />
          </Panel>
          <Panel title="Pricing">
            <Lever label="Starter price / mo" v={m.starterPrice} set={set("starterPrice")} min={0} max={50} step={1} money />
            <Lever label="Pro price / mo" v={m.proPrice} set={set("proPrice")} min={0} max={150} step={1} money />
          </Panel>
          <Panel title="Usage">
            <Lever label="Searches / free user" v={m.freeSearches} set={set("freeSearches")} min={0} max={30} step={1} />
            <Lever label="Searches / Starter" v={m.starterSearches} set={set("starterSearches")} min={0} max={300} step={5} />
            <Lever label="Searches / Pro" v={m.proSearches} set={set("proSearches")} min={0} max={1000} step={10} />
            <Lever label="Enrichments / paid user" v={m.enrichPerPaid} set={set("enrichPerPaid")} min={0} max={200} step={5} />
          </Panel>
          <Panel title="Costs">
            <Lever label="Cost / search" v={m.costPerSearch} set={set("costPerSearch")} min={0} max={1} step={0.01} money />
            <Lever label="Cost / enrichment" v={m.enrichCost} set={set("enrichCost")} min={0} max={1} step={0.01} money />
            <Lever label="Vercel (hosting)" v={m.vercelCost} set={set("vercelCost")} min={0} max={200} step={5} money />
            <Lever label="Supabase (database)" v={m.supabaseCost} set={set("supabaseCost")} min={0} max={200} step={5} money />
            <Lever label="Claude subscription" v={m.claudeSubCost} set={set("claudeSubCost")} min={0} max={400} step={10} money />
            <Lever label="Other fixed (domain, email)" v={m.otherFixed} set={set("otherFixed")} min={0} max={200} step={1} money />
            <Lever label="Stripe %" v={m.stripePct} set={set("stripePct")} min={0} max={6} step={0.1} />
          </Panel>
          <button
            onClick={() => {
              setM(DEFAULTS);
              try {
                localStorage.removeItem(STORE);
              } catch {}
            }}
            className="text-xs font-semibold text-body/50 transition hover:text-accent"
          >
            Reset to defaults
          </button>
        </div>

        {/* ---- Read-outs ---- */}
        <div className="space-y-4">
          <ProfitChart curve={curve} currentPaid={c.paid} breakevenPaid={c.breakevenPaid} />
          <Breakdown rows={breakdown} profit={c.profit} />
          <div className="rounded-2xl border border-warm-border bg-surface p-5 shadow-soft">
            <div className="flex items-center justify-between">
              <div className="text-[11px] font-bold uppercase tracking-wider text-body/50">Per-user economics</div>
              <button onClick={() => setShowTable((v) => !v)} className="text-xs font-semibold text-accent hover:underline">
                {showTable ? "Hide numbers" : "Show all numbers"}
              </button>
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-3 text-sm">
              <Unit name="Free user" rev={0} cost={m.freeSearches * m.costPerSearch} />
              <Unit name="Starter" rev={m.starterPrice} cost={m.starterSearches * m.costPerSearch + m.enrichPerPaid * m.enrichCost + m.starterPrice * (m.stripePct / 100) + m.stripeFlat} />
              <Unit name="Pro" rev={m.proPrice} cost={m.proSearches * m.costPerSearch + m.enrichPerPaid * m.enrichCost + m.proPrice * (m.stripePct / 100) + m.stripeFlat} />
            </div>
            {showTable && (
              <table className="mt-4 w-full text-left text-xs tabular-nums">
                <thead>
                  <tr className="border-b border-warm-border text-body/50">
                    <th className="py-1 font-bold">Line</th>
                    <th className="py-1 text-right font-bold">$ / month</th>
                  </tr>
                </thead>
                <tbody>
                  {breakdown.map((r) => (
                    <tr key={r.name} className="border-b border-warm-border/60">
                      <td className="py-1 text-body">{r.name}</td>
                      <td className={`py-1 text-right ${r.kind === "rev" ? "text-ink" : "text-body"}`}>
                        {r.kind === "rev" ? "" : "-"}{fmt$(r.value)}
                      </td>
                    </tr>
                  ))}
                  <tr>
                    <td className="py-1 font-bold text-ink">Profit</td>
                    <td className={`py-1 text-right font-bold ${c.profit >= 0 ? "text-sage-deep" : "text-danger"}`}>{fmt$(c.profit)}</td>
                  </tr>
                </tbody>
              </table>
            )}
            <p className="mt-3 text-[11px] leading-relaxed text-body/50">
              Free users cost {fmt$(m.freeUsers * m.freeSearches * m.costPerSearch)} a month at this mix, that is the
              marketing budget the free tier really is. Everything scales except Fixed.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// Industry benchmarks + what-the-numbers-mean advice, in plain language. The
// targets are the widely used SaaS rules of thumb, not laws: gross margin 70%+
// (great software businesses run 75-85%), freemium free-to-paid conversion 2-5%,
// and every paid tier profitable on its own.
function HealthCard({ m, c }: { m: Model; c: ReturnType<typeof computed> }) {
  const starterCost =
    m.starterSearches * m.costPerSearch + m.enrichPerPaid * m.enrichCost + m.starterPrice * (m.stripePct / 100) + m.stripeFlat;
  const proCost =
    m.proSearches * m.costPerSearch + m.enrichPerPaid * m.enrichCost + m.proPrice * (m.stripePct / 100) + m.stripeFlat;
  const starterNet = m.starterPrice - starterCost;
  const proNet = m.proPrice - proCost;
  const conv = m.freeUsers + c.paid > 0 ? (c.paid / (m.freeUsers + c.paid)) * 100 : 0;
  const freeBurn = m.freeUsers * m.freeSearches * m.costPerSearch;

  type Status = "good" | "warn" | "bad";
  const rows: { name: string; value: string; target: string; status: Status; meaning: string }[] = [
    {
      name: "Gross margin",
      value: `${Math.round(c.margin)}%`,
      target: "70%+ (software standard)",
      status: c.margin >= 70 ? "good" : c.margin >= 50 ? "warn" : "bad",
      meaning:
        c.margin >= 70
          ? "Healthy: most of each dollar survives its own costs."
          : "Usage costs eat too much of each dollar. Biggest levers: cost per search, or smaller search allowances per tier.",
    },
    {
      name: "Free to paid conversion",
      value: `${conv.toFixed(1)}%`,
      target: "2 to 5% (freemium standard)",
      status: conv >= 2 ? "good" : conv >= 1 ? "warn" : "bad",
      meaning:
        conv >= 2
          ? "In the normal band for freemium products."
          : "Below the freemium norm. Either the free tier gives too much away, or upgrading isn't tempting enough.",
    },
    {
      name: "Starter tier per-user",
      value: `${starterNet >= 0 ? "+" : ""}$${starterNet.toFixed(2)}`,
      target: "positive",
      status: starterNet >= 0 ? "good" : "bad",
      meaning:
        starterNet >= 0
          ? "Every Starter subscriber adds money."
          : "Each Starter LOSES money: the search allowance costs more than the price. Raise the price or shrink the allowance.",
    },
    {
      name: "Pro tier per-user",
      value: `${proNet >= 0 ? "+" : ""}$${proNet.toFixed(2)}`,
      target: "positive",
      status: proNet >= 0 ? "good" : "bad",
      meaning:
        proNet >= 0
          ? "Every Pro subscriber adds money."
          : "Each Pro LOSES money: the allowance costs more than the price. Growth makes this worse, fix before launch.",
    },
    {
      name: "Free-tier spend",
      value: fmt$(freeBurn) + "/mo",
      target: "an amount you'd happily call marketing",
      status: c.mrr === 0 ? "warn" : freeBurn <= c.mrr * 0.5 ? "good" : "warn",
      meaning:
        "Free users are your ad budget. Fine while it converts; cap free searches if this number outgrows its job.",
    },
  ];
  const chip = (s: Status) =>
    s === "good"
      ? "bg-sage/15 text-sage-deep border-sage/40"
      : s === "warn"
        ? "bg-attention/10 text-attention border-attention/40"
        : "bg-danger/10 text-danger border-danger/40";
  const word = (s: Status) => (s === "good" ? "on target" : s === "warn" ? "watch" : "fix");
  return (
    <div className="rounded-2xl border border-warm-border bg-surface p-5 shadow-soft">
      <div className="text-[11px] font-bold uppercase tracking-wider text-body/50">
        How healthy is this? (vs industry standards)
      </div>
      <div className="mt-3 space-y-2.5">
        {rows.map((r) => (
          <div key={r.name} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-sm">
            <span className="w-44 shrink-0 font-semibold text-ink">{r.name}</span>
            <span className="w-20 shrink-0 font-bold tabular-nums text-ink">{r.value}</span>
            <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase ${chip(r.status)}`}>
              {word(r.status)}
            </span>
            <span className="text-xs text-body/50">aim: {r.target}</span>
            <span className="w-full pl-0 text-[12.5px] leading-relaxed text-body/70 sm:w-auto sm:flex-1 sm:basis-full">
              {r.meaning}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "good" | "bad" }) {
  return (
    <div className="rounded-2xl border border-warm-border bg-surface p-5 shadow-soft">
      <div className="text-[11px] font-bold uppercase tracking-wider text-body/50">{label}</div>
      <div className={`mt-1 text-3xl font-extrabold tabular-nums ${tone === "good" ? "text-sage-deep" : tone === "bad" ? "text-danger" : "text-ink"}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-body/60">{sub}</div>}
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-warm-border bg-surface p-4 shadow-soft">
      <div className="mb-3 text-[11px] font-bold uppercase tracking-wider text-body/50">{title}</div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function Lever({ label, v, set, min, max, step, money }: { label: string; v: number; set: (n: number) => void; min: number; max: number; step: number; money?: boolean }) {
  return (
    <label className="block text-xs">
      <span className="flex items-center justify-between">
        <span className="font-semibold text-body">{label}</span>
        <input
          type="number"
          value={v}
          min={min}
          step={step}
          onChange={(e) => set(Number(e.target.value) || 0)}
          className="w-20 rounded-md border border-warm-border bg-surface px-1.5 py-0.5 text-right text-xs tabular-nums text-ink outline-none focus:border-brown"
        />
      </span>
      <input
        type="range"
        value={Math.min(v, max)}
        min={min}
        max={max}
        step={step}
        onChange={(e) => set(Number(e.target.value))}
        aria-label={label}
        className="mt-1 w-full accent-brown"
      />
      {money && <span className="sr-only">dollars</span>}
    </label>
  );
}

function Unit({ name, rev, cost }: { name: string; rev: number; cost: number }) {
  const net = rev - cost;
  return (
    <div className="rounded-xl border border-warm-border bg-warm-bg/40 px-3 py-2.5">
      <div className="text-xs font-bold text-ink">{name}</div>
      <div className={`mt-0.5 text-lg font-extrabold tabular-nums ${net >= 0 ? "text-sage-deep" : "text-danger"}`}>
        {net >= 0 ? "+" : ""}{net.toFixed(2)}
      </div>
      <div className="text-[10px] text-body/50 tabular-nums">${rev.toFixed(0)} in · ${cost.toFixed(2)} out</div>
    </div>
  );
}

// Profit vs paid-user count: single blue line, zero line, breakeven + current
// markers, crosshair tooltip on hover.
function ProfitChart({ curve, currentPaid, breakevenPaid }: { curve: { paid: number; profit: number }[]; currentPaid: number; breakevenPaid: number | null }) {
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<SVGSVGElement>(null);
  const W = 640, H = 220, PAD = { l: 52, r: 14, t: 14, b: 26 };
  const xs = curve.map((p) => p.paid);
  const ys = curve.map((p) => p.profit);
  const xMax = Math.max(1, ...xs);
  const yMin = Math.min(0, ...ys);
  const yMax = Math.max(1, ...ys);
  const X = (v: number) => PAD.l + ((W - PAD.l - PAD.r) * v) / xMax;
  const Y = (v: number) => PAD.t + (H - PAD.t - PAD.b) * (1 - (v - yMin) / (yMax - yMin || 1));
  const path = curve.map((p, i) => `${i ? "L" : "M"}${X(p.paid).toFixed(1)},${Y(p.profit).toFixed(1)}`).join("");
  const hovered = hover != null ? curve[hover] : null;
  return (
    <div className="rounded-2xl border border-warm-border bg-surface p-5 shadow-soft">
      <div className="text-[11px] font-bold uppercase tracking-wider text-body/50">
        Monthly profit as this user mix scales
      </div>
      <div className="relative mt-3 overflow-x-auto">
        <svg
          ref={ref}
          viewBox={`0 0 ${W} ${H}`}
          className="w-full"
          role="img"
          aria-label="Profit versus paying-user count"
          onMouseMove={(e) => {
            const r = ref.current?.getBoundingClientRect();
            if (!r) return;
            const px = ((e.clientX - r.left) / r.width) * W;
            const t = Math.round(((px - PAD.l) / (W - PAD.l - PAD.r)) * (curve.length - 1));
            setHover(Math.max(0, Math.min(curve.length - 1, t)));
          }}
          onMouseLeave={() => setHover(null)}
        >
          {/* zero line + faint grid */}
          <line x1={PAD.l} x2={W - PAD.r} y1={Y(0)} y2={Y(0)} stroke="currentColor" strokeOpacity=".28" strokeWidth="1" className="text-body" />
          {[0.25, 0.5, 0.75, 1].map((f) => (
            <text key={f} x={PAD.l - 8} y={Y(yMin + (yMax - yMin) * f) + 3} textAnchor="end" fontSize="10" className="fill-current text-body" opacity=".55">
              {fmt$(yMin + (yMax - yMin) * f)}
            </text>
          ))}
          {[0.25, 0.5, 0.75, 1].map((f) => (
            <text key={f} x={X(xMax * f)} y={H - 8} textAnchor="middle" fontSize="10" className="fill-current text-body" opacity=".55">
              {Math.round(xMax * f)}
            </text>
          ))}
          <text x={W - PAD.r} y={H - 8} textAnchor="end" fontSize="9" className="fill-current text-body" opacity=".45">paying users</text>
          {/* profit line */}
          <path d={path} fill="none" stroke="var(--ch-rev)" strokeWidth="2" />
          {/* breakeven marker */}
          {breakevenPaid != null && breakevenPaid <= xMax && (
            <g>
              <circle cx={X(breakevenPaid)} cy={Y(0)} r="5" fill="var(--ch-cost)" stroke="rgb(var(--c-surface))" strokeWidth="2" />
              <text x={X(breakevenPaid)} y={Y(0) - 10} textAnchor="middle" fontSize="10" fontWeight="700" className="fill-current text-ink">
                breakeven {breakevenPaid}
              </text>
            </g>
          )}
          {/* current mix marker */}
          <circle cx={X(currentPaid)} cy={Y((curve.find((p) => p.paid >= currentPaid) || curve[curve.length - 1]).profit)} r="5" fill="var(--ch-rev)" stroke="rgb(var(--c-surface))" strokeWidth="2" />
          {/* crosshair */}
          {hovered && (
            <line x1={X(hovered.paid)} x2={X(hovered.paid)} y1={PAD.t} y2={H - PAD.b} stroke="currentColor" strokeOpacity=".3" className="text-body" />
          )}
        </svg>
        {hovered && (
          <div className="pointer-events-none absolute rounded-lg border border-warm-border bg-surface px-2.5 py-1.5 text-xs shadow-card" style={{ left: `${(X(hovered.paid) / W) * 100}%`, top: 0, transform: "translateX(-50%)" }}>
            <b className="text-ink tabular-nums">{hovered.paid}</b> paying · <b className={hovered.profit >= 0 ? "text-sage-deep" : "text-danger"}>{fmt$(hovered.profit)}</b>/mo
          </div>
        )}
      </div>
      <p className="mt-2 text-[11px] text-body/50">
        Same tier mix and prices, scaled up and down. The dot on the line is where you are now.
      </p>
    </div>
  );
}

// Revenue vs each cost line: horizontal bars, direct labels, 2px surface gaps.
function Breakdown({ rows, profit }: { rows: { name: string; value: number; kind: "rev" | "cost" }[]; profit: number }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="rounded-2xl border border-warm-border bg-surface p-5 shadow-soft">
      <div className="flex items-center gap-4">
        <div className="text-[11px] font-bold uppercase tracking-wider text-body/50">Where the money goes</div>
        <div className="ml-auto flex items-center gap-3 text-[11px] text-body/60">
          <span className="flex items-center gap-1.5"><i className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: "var(--ch-rev)" }} />revenue</span>
          <span className="flex items-center gap-1.5"><i className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: "var(--ch-cost)" }} />costs</span>
        </div>
      </div>
      <div className="mt-3 space-y-2">
        {rows.map((r) => (
          <div key={r.name} className="flex items-center gap-2 text-xs" title={`${r.name}: ${fmt$(r.value)} per month`}>
            <span className="w-32 shrink-0 text-body">{r.name}</span>
            <div className="h-4 flex-1 rounded-r">
              <div
                className="h-4 rounded-r"
                style={{ width: `${Math.max(1, (r.value / max) * 100)}%`, background: r.kind === "rev" ? "var(--ch-rev)" : "var(--ch-cost)" }}
              />
            </div>
            <span className="w-16 shrink-0 text-right font-semibold tabular-nums text-ink">{fmt$(r.value)}</span>
          </div>
        ))}
        <div className="flex items-center gap-2 border-t border-warm-border pt-2 text-xs">
          <span className="w-32 shrink-0 font-bold text-ink">Profit</span>
          <span className="flex-1" />
          <span className={`w-16 shrink-0 text-right font-extrabold tabular-nums ${profit >= 0 ? "text-sage-deep" : "text-danger"}`}>{fmt$(profit)}</span>
        </div>
      </div>
    </div>
  );
}
