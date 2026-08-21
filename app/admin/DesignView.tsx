"use client";

// Admin-only design workbench, two jobs:
//   1. A color-scheme playground: edit the core tokens and watch real Scout
//      surfaces (the stage, a find card, the buttons) re-render live, then
//      copy the scheme out as CSS variables to hand to engineering.
//   2. A design history: every era the app has shipped through, as small
//      faithful mockups, with pinning so favorites stay on top as references.
//
// Deliberately self-contained: nothing here touches the live app's styling.
// Trying a scheme is safe by construction because only this page re-renders.

import { useEffect, useMemo, useState } from "react";

type Scheme = Record<string, string>;

const DEFAULT_SCHEME: Scheme = {
  "Stage brown": "#5c4634",
  "Work area": "#4a3729",
  "Cream": "#f6efe6",
  "Canvas": "#f8f7f5",
  "Ink": "#2b2723",
  "Accent blue": "#536872",
};

// The shipped rainbow (tiles, monograms). Editable like everything else.
const DEFAULT_RAINBOW = ["#377ec0", "#5460ac", "#7a5aa8", "#12baaa", "#f7891f", "#f04f52"];

interface Era {
  id: string;
  name: string;
  when: string;
  notes: string;
  // Which mockup the era renders and the palette it ran on.
  kind: "form" | "stage";
  colors: { bg: string; card: string; ink: string; button: string; buttonText: string };
}

const ERAS: Era[] = [
  {
    id: "coral",
    name: "Coral spike",
    when: "Early July 2026",
    notes:
      "The Phase 0 spike. White canvas, coral and blush accents, everything on one card. Retired with the rebrand.",
    kind: "form",
    colors: { bg: "#fafafa", card: "#ffffff", ink: "#1f2430", button: "#e8836f", buttonText: "#ffffff" },
  },
  {
    id: "leather",
    name: "Leather and denim",
    when: "Mid July 2026",
    notes:
      "The warm-brown rebrand: cream canvas, denim rail, browns on content and CTAs. The form layout carried over.",
    kind: "form",
    colors: { bg: "#f8f7f5", card: "#ffffff", ink: "#2b2723", button: "#7a6048", buttonText: "#ffffff" },
  },
  {
    id: "stage",
    name: "The stage",
    when: "Late August 2026, live now",
    notes:
      "The composer becomes a brown room: floating pill toggles, the goal as bullet points, a deeper work area that fades in, finds on light cards.",
    kind: "stage",
    colors: { bg: "#5c4634", card: "#4a3729", ink: "#f6efe6", button: "#f6efe6", buttonText: "#4a3729" },
  },
];

const PIN_KEY = "scout_admin_design_pins";

export default function DesignView() {
  const [scheme, setScheme] = useState<Scheme>(() => ({ ...DEFAULT_SCHEME }));
  const [rainbow, setRainbow] = useState<string[]>([...DEFAULT_RAINBOW]);
  const [copied, setCopied] = useState(false);
  const [pins, setPins] = useState<string[]>(() => {
    try {
      const p = JSON.parse(localStorage.getItem(PIN_KEY) || "[]");
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(PIN_KEY, JSON.stringify(pins));
    } catch {}
  }, [pins]);

  const css = useMemo(() => {
    const lines = Object.entries(scheme).map(
      ([k, v]) => `  --${k.toLowerCase().replace(/[^a-z0-9]+/g, "-")}: ${v};`
    );
    lines.push(`  --rainbow: ${rainbow.join(", ")};`);
    return `:root {\n${lines.join("\n")}\n}`;
  }, [scheme, rainbow]);

  const s = (k: string) => scheme[k] || DEFAULT_SCHEME[k];
  const ordered = [...ERAS].sort(
    (a, b) => Number(pins.includes(b.id)) - Number(pins.includes(a.id))
  );

  return (
    <div className="space-y-10">
      {/* ---------------- Playground ---------------- */}
      <section>
        <h2 className="text-lg font-bold text-ink">Try a color scheme</h2>
        <p className="mt-1 max-w-[62ch] text-sm leading-relaxed text-body/70">
          Edit the tokens and the preview re-renders live. Nothing here touches
          the real app; when a scheme feels right, copy it out and hand it over.
        </p>
        <div className="mt-4 grid gap-6 lg:grid-cols-[300px_minmax(0,1fr)]">
          <div className="space-y-2.5">
            {Object.keys(scheme).map((k) => (
              <label key={k} className="flex items-center gap-3">
                <input
                  type="color"
                  value={scheme[k]}
                  onChange={(e) => setScheme((v) => ({ ...v, [k]: e.target.value }))}
                  className="h-8 w-10 cursor-pointer rounded border border-warm-border bg-transparent"
                />
                <span className="min-w-0 flex-1 text-sm font-semibold text-ink">{k}</span>
                <code className="text-xs text-body/60">{scheme[k]}</code>
              </label>
            ))}
            <div className="pt-2">
              <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-body/60">
                Rainbow (tiles and monograms)
              </div>
              <div className="flex flex-wrap gap-1.5">
                {rainbow.map((c, i) => (
                  <input
                    key={i}
                    type="color"
                    value={c}
                    onChange={(e) =>
                      setRainbow((r) => r.map((x, j) => (j === i ? e.target.value : x)))
                    }
                    className="h-8 w-9 cursor-pointer rounded border border-warm-border bg-transparent"
                  />
                ))}
              </div>
            </div>
            <div className="flex gap-2 pt-3">
              <button
                onClick={() => {
                  try {
                    navigator.clipboard.writeText(css);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  } catch {}
                }}
                className="rounded-xl bg-brand-gradient px-4 py-2 text-xs font-bold text-white shadow-soft transition hover:opacity-95"
              >
                {copied ? "Copied" : "Copy as CSS"}
              </button>
              <button
                onClick={() => {
                  setScheme({ ...DEFAULT_SCHEME });
                  setRainbow([...DEFAULT_RAINBOW]);
                }}
                className="rounded-xl border border-warm-border px-4 py-2 text-xs font-semibold text-body transition hover:bg-warm-bg"
              >
                Reset to shipped
              </button>
            </div>
          </div>

          {/* Live preview: the stage, then the work area with a find card. */}
          <div className="overflow-hidden rounded-2xl border border-warm-border shadow-soft">
            <div style={{ background: s("Stage brown"), color: s("Cream") }} className="p-6">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-bold uppercase tracking-[0.14em] opacity-60">
                  Scouting for
                </span>
                <span className="rounded-full border border-white/25 bg-white/10 px-3.5 py-1.5 text-sm font-semibold">
                  Scout
                </span>
                <span className="rounded-full border border-white/25 bg-white/10 px-3.5 py-1.5 text-sm font-semibold">
                  Companies
                </span>
              </div>
              <div className="mt-4 text-[10px] font-bold uppercase tracking-[0.14em] opacity-60">
                This search finds
              </div>
              <div className="mt-2 grid gap-x-10 gap-y-1.5 sm:grid-cols-2">
                {["Companies across many industries", "Any location", "Smaller companies preferred", "Prospects to pitch to"].map(
                  (b) => (
                    <span key={b} className="flex items-start gap-2 text-[15px] font-semibold">
                      <span
                        className="mt-[8px] h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{ background: s("Cream") }}
                      />
                      {b}
                    </span>
                  )
                )}
              </div>
              <span
                className="mt-4 inline-block rounded-full px-6 py-2 text-sm font-bold"
                style={{ background: s("Cream"), color: s("Stage brown") }}
              >
                Scout
              </span>
            </div>
            <div style={{ background: s("Work area") }} className="p-6">
              <div
                className="max-w-sm rounded-2xl p-4 shadow-soft"
                style={{ background: s("Canvas"), color: s("Ink") }}
              >
                <div className="flex items-center gap-2.5">
                  <span
                    className="grid h-8 w-8 place-items-center rounded-lg text-[11px] font-bold text-white"
                    style={{ background: rainbow[0] }}
                  >
                    KE
                  </span>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-bold">Kinkead Entertainment</div>
                    <div className="truncate text-xs opacity-60">
                      CEO and Talent Agent, Nashville TN
                    </div>
                  </div>
                  <span
                    className="ml-auto rounded-full px-2 py-0.5 text-[10px] font-bold text-white"
                    style={{ background: s("Accent blue") }}
                  >
                    Great fit
                  </span>
                </div>
                <div className="mt-3 flex gap-1.5">
                  {rainbow.map((c, i) => (
                    <span key={i} className="h-4 flex-1 rounded" style={{ background: c }} />
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ---------------- History ---------------- */}
      <section>
        <h2 className="text-lg font-bold text-ink">Design history</h2>
        <p className="mt-1 max-w-[62ch] text-sm leading-relaxed text-body/70">
          Every look Scout has shipped with. Pin the ones worth keeping in reach;
          pinned eras stay at the top.
        </p>
        <div className="mt-4 grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          {ordered.map((era) => {
            const pinned = pins.includes(era.id);
            return (
              <div
                key={era.id}
                className={`overflow-hidden rounded-2xl border bg-surface shadow-card ${
                  pinned ? "border-brown/50" : "border-warm-border"
                }`}
              >
                {/* Mockup */}
                <div style={{ background: era.colors.bg }} className="h-40 p-4">
                  {era.kind === "form" ? (
                    <div
                      className="mx-auto h-full max-w-[260px] rounded-xl border p-3 text-[9px]"
                      style={{
                        background: era.colors.card,
                        color: era.colors.ink,
                        borderColor: "rgb(0 0 0 / 0.08)",
                      }}
                    >
                      <div className="mb-2 grid grid-cols-2 gap-2">
                        <span className="rounded border border-black/10 px-1.5 py-1">Project</span>
                        <span className="rounded border border-black/10 px-1.5 py-1">Category</span>
                      </div>
                      <div className="rounded border border-black/10 px-1.5 py-3 opacity-50">
                        Who are you looking for?
                      </div>
                      <span
                        className="mt-2 inline-block rounded px-3 py-1 font-bold"
                        style={{ background: era.colors.button, color: era.colors.buttonText }}
                      >
                        Scout
                      </span>
                    </div>
                  ) : (
                    <div className="h-full text-[9px]" style={{ color: era.colors.ink }}>
                      <div className="flex gap-1.5">
                        <span className="rounded-full border border-white/30 bg-white/10 px-2 py-0.5">
                          Scout
                        </span>
                        <span className="rounded-full border border-white/30 bg-white/10 px-2 py-0.5">
                          Companies
                        </span>
                      </div>
                      <div className="mt-2.5 grid grid-cols-2 gap-1">
                        <span>&bull; Many industries</span>
                        <span>&bull; Any location</span>
                        <span>&bull; Smaller companies</span>
                        <span>&bull; Pitch prospects</span>
                      </div>
                      <span
                        className="mt-2.5 inline-block rounded-full px-3 py-1 font-bold"
                        style={{ background: era.colors.button, color: era.colors.buttonText }}
                      >
                        Scout
                      </span>
                      <div
                        className="mt-2 -mx-4 -mb-4 px-4 py-2"
                        style={{ background: era.colors.card }}
                      >
                        <div className="h-6 max-w-[140px] rounded bg-white/90" />
                      </div>
                    </div>
                  )}
                </div>
                <div className="p-4">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold text-ink">{era.name}</span>
                    <span className="text-[11px] text-body/50">{era.when}</span>
                    <button
                      onClick={() =>
                        setPins((p) =>
                          p.includes(era.id) ? p.filter((x) => x !== era.id) : [...p, era.id]
                        )
                      }
                      className={`ml-auto rounded-lg border px-2.5 py-1 text-[11px] font-bold transition ${
                        pinned
                          ? "border-brown bg-brown-tint/60 text-brown-deep"
                          : "border-warm-border text-body/60 hover:bg-warm-bg"
                      }`}
                    >
                      {pinned ? "Pinned" : "Pin"}
                    </button>
                  </div>
                  <p className="mt-1.5 text-xs leading-relaxed text-body/70">{era.notes}</p>
                </div>
              </div>
            );
          })}
        </div>
        <p className="mt-3 text-xs text-body/55">
          New eras get added here when the design meaningfully changes, so this
          stays the record of where the look has been.
        </p>
      </section>
    </div>
  );
}
