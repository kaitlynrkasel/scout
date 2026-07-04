"use client";

/**
 * Lightweight, dependency-free SVG charts for the dashboard. Static by default
 * (product register: motion conveys state, not page-load decoration). Accessible:
 * each chart carries a role="img" + descriptive aria-label, and never encodes
 * meaning in color alone (legends carry text labels).
 */

type Pt = { label: string; sent: number; added: number };

// A calm two-series area/line: outreach sent (accent) over finds added (neutral),
// bucketed by week. Renders with a subtle baseline grid and a marked latest point.
export function ActivityChart({
  data,
  height = 168,
}: {
  data: Pt[];
  height?: number;
}) {
  const W = 720;
  const H = height;
  const padL = 8;
  const padR = 8;
  const padT = 14;
  const padB = 22;
  const iw = W - padL - padR;
  const ih = H - padT - padB;
  const max = Math.max(4, ...data.map((d) => Math.max(d.sent, d.added)));
  const n = data.length;
  const x = (i: number) => padL + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v: number) => padT + ih - (v / max) * ih;

  const line = (key: "sent" | "added") =>
    data.map((d, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)} ${y(d[key]).toFixed(1)}`).join(" ");
  const area =
    `M${x(0).toFixed(1)} ${(padT + ih).toFixed(1)} ` +
    data.map((d, i) => `L${x(i).toFixed(1)} ${y(d.sent).toFixed(1)}`).join(" ") +
    ` L${x(n - 1).toFixed(1)} ${(padT + ih).toFixed(1)} Z`;

  const totalSent = data.reduce((s, d) => s + d.sent, 0);
  const totalAdded = data.reduce((s, d) => s + d.added, 0);
  const gridY = [0.33, 0.66, 1].map((f) => padT + ih - f * ih);
  const last = n - 1;

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Outreach over the last ${n} weeks: ${totalSent} sent, ${totalAdded} found.`}
      >
        <defs>
          <linearGradient id="activity-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#7c5837" stopOpacity="0.16" />
            <stop offset="1" stopColor="#7c5837" stopOpacity="0" />
          </linearGradient>
        </defs>
        {gridY.map((gy, i) => (
          <line key={i} x1={padL} x2={W - padR} y1={gy} y2={gy} stroke="#eceae4" strokeWidth="1" />
        ))}
        <path d={area} fill="url(#activity-fill)" />
        <path d={line("added")} fill="none" stroke="#c8b899" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="1 5" />
        <path d={line("sent")} fill="none" stroke="#7c5837" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        {n > 0 && (
          <>
            <circle cx={x(last)} cy={y(data[last].sent)} r="7" fill="#7c5837" fillOpacity="0.14" />
            <circle cx={x(last)} cy={y(data[last].sent)} r="3.5" fill="#7c5837" stroke="#fff" strokeWidth="1.5" />
          </>
        )}
      </svg>
      <figcaption className="mt-2 flex items-center gap-4 text-xs text-muted">
        <span className="flex items-center gap-1.5">
          <span className="h-0.5 w-3 rounded-full bg-brown" aria-hidden />Sent
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-0.5 w-3 rounded-full bg-clay" aria-hidden />Found
        </span>
        <span className="ml-auto tabular-nums">Last {n} weeks</span>
      </figcaption>
    </figure>
  );
}

// A single stacked bar for the pipeline, with a text+count legend beneath it.
export function PipelineBar({
  segments,
}: {
  segments: { label: string; value: number; color: string; text: string }[];
}) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  return (
    <div>
      <div
        className="flex h-2.5 w-full overflow-hidden rounded-full bg-warm-bg"
        role="img"
        aria-label={segments.map((s) => `${s.label}: ${s.value}`).join(", ")}
      >
        {segments.map((s) =>
          s.value > 0 ? (
            <span
              key={s.label}
              className={s.color}
              style={{ width: `${(s.value / total) * 100}%` }}
              title={`${s.label}: ${s.value}`}
            />
          ) : null,
        )}
      </div>
      <ul className="mt-3.5 grid grid-cols-2 gap-x-6 gap-y-2.5">
        {segments.map((s) => (
          <li key={s.label} className="flex items-center gap-2 text-sm">
            <span className={`h-2 w-2 shrink-0 rounded-[3px] ${s.color}`} aria-hidden />
            <span className={s.text}>{s.label}</span>
            <span className="ml-auto font-semibold tabular-nums text-ink">{s.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// A radial gauge for a single 0–100 percentage — a circular shape that gives the
// dashboard something other than stacked rectangles. The number lives in real
// HTML at the center so it inherits the page font (not SVG text).
export function MatchGauge({
  pct,
  size = 132,
  stroke = 11,
}: {
  pct: number;
  size?: number;
  stroke?: number;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const dash = Math.max(0, Math.min(1, pct / 100)) * c;
  const mid = size / 2;
  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={`Match quality: ${pct}% on target.`}
      >
        <circle cx={mid} cy={mid} r={r} fill="none" stroke="#efece5" strokeWidth={stroke} />
        <circle
          cx={mid}
          cy={mid}
          r={r}
          fill="none"
          stroke="#7c5837"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${dash.toFixed(1)} ${(c - dash).toFixed(1)}`}
          transform={`rotate(-90 ${mid} ${mid})`}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-[28px] font-semibold leading-none tabular-nums text-ink">{pct}%</span>
        <span className="mt-1 text-xs text-muted">on target</span>
      </div>
    </div>
  );
}

// A tiny trend line for a metric tile. Renders nothing without at least two real
// points — we never fabricate a series to fill the slot.
export function Sparkline({
  data,
  stroke = "#7c5837",
  width = 76,
  height = 26,
}: {
  data: number[];
  stroke?: string;
  width?: number;
  height?: number;
}) {
  if (data.length < 2) return null;
  const pad = 3;
  const mn = Math.min(...data);
  const mx = Math.max(...data);
  const rng = mx - mn || 1;
  const X = (i: number) => pad + (i / (data.length - 1)) * (width - 2 * pad);
  const Y = (v: number) => pad + (1 - (v - mn) / rng) * (height - 2 * pad);
  const d = data.map((v, i) => `${i ? "L" : "M"}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`).join(" ");
  const lx = X(data.length - 1);
  const ly = Y(data[data.length - 1]);
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={d} fill="none" stroke={stroke} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={lx} cy={ly} r="2.2" fill={stroke} />
    </svg>
  );
}
