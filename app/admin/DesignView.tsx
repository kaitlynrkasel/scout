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
  // The surface this version belongs to; history is grouped by it, because
  // design versions are formatting as much as color.
  surface: string;
  // Which mockup the era renders and the palette it ran on.
  kind: "form" | "stage" | "grid-shots" | "grid-tiles" | "fit-pct" | "fit-words" | "dash-matches" | "dash-numbers";
  colors: { bg: string; card: string; ink: string; button: string; buttonText: string };
}

const ERAS: Era[] = [
  {
    id: "coral",
    surface: "Search screen",
    name: "Coral spike",
    when: "Early July 2026",
    notes:
      "The Phase 0 spike. White canvas, coral and blush accents, everything on one card. Retired with the rebrand.",
    kind: "form",
    colors: { bg: "#fafafa", card: "#ffffff", ink: "#1f2430", button: "#e8836f", buttonText: "#ffffff" },
  },
  {
    id: "leather",
    surface: "Search screen",
    name: "Leather and denim",
    when: "Mid July 2026",
    notes:
      "The warm-brown rebrand: cream canvas, denim rail, browns on content and CTAs. The form layout carried over.",
    kind: "form",
    colors: { bg: "#f8f7f5", card: "#ffffff", ink: "#2b2723", button: "#7a6048", buttonText: "#ffffff" },
  },
  {
    id: "stage",
    surface: "Search screen",
    name: "The stage",
    when: "Late August 2026, live now",
    notes:
      "The composer becomes a brown room: floating pill toggles, the goal as bullet points, a deeper work area that fades in, finds on light cards.",
    kind: "stage",
    colors: { bg: "#5c4634", card: "#4a3729", ink: "#f6efe6", button: "#f6efe6", buttonText: "#4a3729" },
  },
  {
    id: "grid-shots",
    surface: "Finds grid",
    name: "Site screenshots",
    when: "Through August 20, 2026",
    notes:
      "Each card led with a live thumbnail of the find's homepage. Mostly whitespace, cropped at an arbitrary scroll point; forty of them read as noise.",
    kind: "grid-shots",
    colors: { bg: "#f8f7f5", card: "#ffffff", ink: "#2b2723", button: "#7a6048", buttonText: "#fff" },
  },
  {
    id: "grid-tiles",
    surface: "Finds grid",
    name: "Brand tiles",
    when: "August 21, 2026, live now",
    notes:
      "A flat block snapped to the rainbow palette, carrying the company's own logo, the platform mark for a profile, or the Scout dog. The grid stays calm.",
    kind: "grid-tiles",
    colors: { bg: "#f8f7f5", card: "#ffffff", ink: "#2b2723", button: "#7a6048", buttonText: "#fff" },
  },
  {
    id: "fit-pct",
    surface: "Fit labels",
    name: "Percent scores",
    when: "Through August 20, 2026",
    notes:
      "38% fit on every card. Read like a grade, and two digits were false precision on a model's judgement.",
    kind: "fit-pct",
    colors: { bg: "#f8f7f5", card: "#ffffff", ink: "#2b2723", button: "#7a6048", buttonText: "#fff" },
  },
  {
    id: "fit-words",
    surface: "Fit labels",
    name: "Word bands",
    when: "August 21, 2026, live now",
    notes:
      "Perfect, Great, Good, Potential, Far-fetched, each with its own colour so a list can be skimmed. The exact score stays on hover.",
    kind: "fit-words",
    colors: { bg: "#f8f7f5", card: "#ffffff", ink: "#2b2723", button: "#7a6048", buttonText: "#fff" },
  },
  {
    id: "dash-matches",
    surface: "Dashboard",
    name: "Top match and more matches",
    when: "Through August 21, 2026",
    notes:
      "The dashboard led with a spotlight find and a ranked list, duplicating the Finds tab on the landing screen.",
    kind: "dash-matches",
    colors: { bg: "#f8f7f5", card: "#ffffff", ink: "#2b2723", button: "#7a6048", buttonText: "#fff" },
  },
  {
    id: "dash-numbers",
    surface: "Dashboard",
    name: "Numbers and learning",
    when: "August 22, 2026, live now",
    notes:
      "Impactful numbers full width, then what Scout is learning about you. Matches live on Finds where they belong.",
    kind: "dash-numbers",
    colors: { bg: "#f8f7f5", card: "#ffffff", ink: "#2b2723", button: "#7a6048", buttonText: "#fff" },
  },
];

const PIN_KEY = "scout_admin_design_pins";

// ---- Palette helpers: turn any list of colors into a scheme ----
function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
const lum = (hex: string) => {
  const c = hexToRgb(hex);
  return c ? (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255 : 0.5;
};
const shade = (hex: string, f: number) => {
  const c = hexToRgb(hex);
  if (!c) return hex;
  return `#${c.map((v) => Math.max(0, Math.min(255, Math.round(v * f))).toString(16).padStart(2, "0")).join("")}`;
};
const hueOf = (hex: string) => {
  const c = hexToRgb(hex);
  if (!c) return 0;
  const [r, g, b] = c.map((v) => v / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  if (mx === mn) return 0;
  const d = mx - mn;
  let h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return h * 60;
};

// Map an arbitrary color list onto Scout's token slots by luminance: the
// stage wants a deep tone, the canvas a pale one, and the work area is always
// a shade of the stage so the two rooms stay related whatever the source.
function schemeFromColors(colors: string[]): { scheme: Scheme; rainbow: string[] | null } {
  const cs = colors.filter((c) => hexToRgb(c)).map((c) => (c.startsWith("#") ? c : `#${c}`));
  if (cs.length < 2) return { scheme: { ...DEFAULT_SCHEME }, rainbow: null };
  const byLum = [...cs].sort((a, b) => lum(a) - lum(b));
  const darkest = byLum[0];
  const light = byLum[byLum.length - 1];
  const stage = byLum.length >= 3 ? byLum[1] : darkest;
  const mid = byLum[Math.floor(byLum.length / 2)];
  const scheme: Scheme = {
    "Stage brown": lum(stage) < 0.55 ? stage : shade(stage, 0.55),
    "Work area": shade(lum(stage) < 0.55 ? stage : shade(stage, 0.55), 0.8),
    "Cream": lum(light) > 0.75 ? light : "#f6efe6",
    "Canvas": lum(light) > 0.75 ? shade(light, 1.03) : "#f8f7f5",
    "Ink": lum(darkest) < 0.2 ? darkest : "#2b2723",
    "Accent blue": mid,
  };
  const rainbow =
    cs.length >= 6 ? [...cs].sort((a, b) => hueOf(a) - hueOf(b)).slice(0, 6) : null;
  return { scheme, rainbow };
}

// Pull the dominant colors out of an uploaded image (a palette shot, a website
// screenshot) with a coarse quantize-and-count, keeping the winners apart so
// six near-identical pixels of one background don't fill every slot.
async function colorsFromImage(file: File): Promise<string[]> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = url;
    });
    const w = 80;
    const h = Math.max(1, Math.round((img.height / img.width) * w));
    const cv = document.createElement("canvas");
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext("2d")!;
    ctx.drawImage(img, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    const buckets = new Map<string, { n: number; r: number; g: number; b: number }>();
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 200) continue;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const k = `${r >> 4}-${g >> 4}-${b >> 4}`;
      const cur = buckets.get(k) || { n: 0, r: 0, g: 0, b: 0 };
      cur.n++; cur.r += r; cur.g += g; cur.b += b;
      buckets.set(k, cur);
    }
    const ranked = [...buckets.values()]
      .sort((a, b) => b.n - a.n)
      .map((v) => [Math.round(v.r / v.n), Math.round(v.g / v.n), Math.round(v.b / v.n)] as const);
    const out: string[] = [];
    for (const [r, g, b] of ranked) {
      const hex = `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
      // keep winners visually apart
      if (out.some((o) => {
        const c = hexToRgb(o)!;
        return Math.abs(c[0] - r) + Math.abs(c[1] - g) + Math.abs(c[2] - b) < 90;
      }))
        continue;
      out.push(hex);
      if (out.length >= 8) break;
    }
    return out;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// A spread of ready palettes, deliberately wide: warm, cool, loud, quiet.
const PRESET_PALETTES: { name: string; colors: string[] }[] = [
  { name: "Shipped Scout", colors: ["#2b2723", "#5c4634", "#536872", "#f6efe6", "#f8f7f5", "#377ec0"] },
  { name: "Espresso", colors: ["#1f1712", "#3b2c20", "#6f4e37", "#c89f7c", "#efe3d5", "#a3542f"] },
  { name: "Tidepool", colors: ["#0e2a33", "#155e63", "#12baaa", "#9fd2d6", "#f2f7f6", "#f7891f"] },
  { name: "Sunset motel", colors: ["#241b2f", "#5460ac", "#f04f52", "#f7891f", "#fbdf54", "#fdf6ec"] },
  { name: "Meadow", colors: ["#1e2a1c", "#3f5f3a", "#7ba05b", "#cfe3b8", "#f6f8ef", "#c96f3a"] },
  { name: "Ink and paper", colors: ["#14161a", "#3a3f4a", "#7b8494", "#d8dbe0", "#fafbfc", "#b5443c"] },
  { name: "Grape soda", colors: ["#231631", "#4a2d6b", "#7a5aa8", "#c9b6e4", "#f7f3fb", "#12baaa"] },
  { name: "Desert clay", colors: ["#2c1c14", "#8a5a44", "#c98a5e", "#e8c9a8", "#faf3ea", "#3f5666"] },
  { name: "Deep pine", colors: ["#0f1f18", "#1e4034", "#4a5f52", "#a8c5b2", "#f1f6f2", "#e0a53a"] },
  { name: "Denim", colors: ["#141c26", "#2b3f57", "#537ba2", "#a9c2d8", "#f4f7fa", "#c96f3a"] },
  { name: "Rosewood", colors: ["#26141a", "#5f2a3a", "#a04a5e", "#dba6b0", "#faf1f3", "#3f6b4f"] },
  { name: "Citrus press", colors: ["#20250f", "#5a5f3f", "#a3b02a", "#fbdf54", "#fbfaef", "#f04f52"] },
  { name: "Harbor slate", colors: ["#161c1f", "#2f4356", "#536872", "#a5b0b6", "#f3f5f6", "#12baaa"] },
  { name: "Bubblegum", colors: ["#2a1622", "#8a2f5c", "#e0699e", "#f7c2d8", "#fdf3f7", "#377ec0"] },
  { name: "Harvest", colors: ["#241a0e", "#6b4a1f", "#a9761f", "#e0b45c", "#faf3e3", "#6d3f52"] },
  { name: "Night shift", colors: ["#0b0d12", "#1c2230", "#39415a", "#8b93ad", "#e8eaf1", "#f7891f"] },
];

export default function DesignView() {
  const [scheme, setScheme] = useState<Scheme>(() => ({ ...DEFAULT_SCHEME }));
  const [rainbow, setRainbow] = useState<string[]>([...DEFAULT_RAINBOW]);
  const [copied, setCopied] = useState(false);
  const [typedColors, setTypedColors] = useState("");
  const [sourceNote, setSourceNote] = useState("");

  const applyColors = (colors: string[], label: string) => {
    const { scheme: sc, rainbow: rb } = schemeFromColors(colors);
    setScheme(sc);
    if (rb) setRainbow(rb);
    setSourceNote(label);
  };
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
        {/* Start from anywhere: a preset, a photo, or a pasted list. */}
        <div className="mt-4 flex flex-wrap gap-2">
          {PRESET_PALETTES.map((pp) => (
            <button
              key={pp.name}
              onClick={() => applyColors(pp.colors, pp.name)}
              title={pp.name}
              className={`group flex items-center gap-2 rounded-xl border px-2.5 py-1.5 transition hover:border-brown/50 ${
                sourceNote === pp.name ? "border-brown bg-brown-tint/40" : "border-warm-border bg-surface"
              }`}
            >
              <span className="flex overflow-hidden rounded-md">
                {pp.colors.map((c) => (
                  <span key={c} className="h-4 w-3.5" style={{ background: c }} />
                ))}
              </span>
              <span className="text-xs font-semibold text-body group-hover:text-ink">{pp.name}</span>
            </button>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label className="cursor-pointer rounded-xl border border-warm-border bg-surface px-3.5 py-2 text-xs font-semibold text-body transition hover:border-brown/50 hover:text-ink">
            Pull colors from a photo
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                try {
                  const cols = await colorsFromImage(f);
                  if (cols.length >= 2) applyColors(cols, f.name);
                  else setSourceNote("Could not read enough distinct colors from that image.");
                } catch {
                  setSourceNote("Could not read that image.");
                }
                e.target.value = "";
              }}
            />
          </label>
          <input
            value={typedColors}
            onChange={(e) => setTypedColors(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              const cols = typedColors.match(/#?[0-9a-fA-F]{6}|#?[0-9a-fA-F]{3}\b/g) || [];
              if (cols.length >= 2) applyColors(cols, "typed colors");
              else setSourceNote("Type at least two hex colors, like #5c4634 #f6efe6.");
            }}
            placeholder="Or type hex colors and press Enter: #5c4634 #f6efe6 #536872"
            className="min-w-[280px] flex-1 rounded-xl border border-warm-border bg-surface px-3.5 py-2 text-xs text-ink outline-none transition focus:border-brown"
          />
          {sourceNote && <span className="text-xs text-body/60">From: {sourceNote}</span>}
        </div>

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
        {Array.from(new Set(ordered.map((e) => e.surface))).map((surface) => (
        <div key={surface} className="mt-6">
        <div className="kicker mb-2">{surface}</div>
        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          {ordered.filter((e) => e.surface === surface).map((era) => {
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
                  {era.kind === "grid-shots" || era.kind === "grid-tiles" ? (
                    <div className="grid h-full grid-cols-2 gap-2">
                      {[0, 1, 2, 3].map((i) => (
                        <div key={i} className="overflow-hidden rounded-lg border border-black/10 bg-white text-[8px]">
                          {era.kind === "grid-shots" ? (
                            <div className="h-2/3 bg-gradient-to-b from-neutral-100 to-neutral-300 p-1">
                              <div className="h-1 w-2/3 rounded bg-neutral-400/60" />
                              <div className="mt-0.5 h-1 w-1/3 rounded bg-neutral-400/40" />
                            </div>
                          ) : (
                            <div
                              className="grid h-2/3 place-items-center"
                              style={{ background: DEFAULT_RAINBOW[i % DEFAULT_RAINBOW.length] }}
                            >
                              <span className="grid h-4 w-4 place-items-center rounded bg-white/85 text-[7px] font-bold" style={{ color: DEFAULT_RAINBOW[i % DEFAULT_RAINBOW.length] }}>
                                {"SKLM"[i]}
                              </span>
                            </div>
                          )}
                          <div className="p-1 font-bold" style={{ color: era.colors.ink }}>
                            {["Slevin & Hart", "Kinkead", "Lackey PLLC", "McKay Law"][i]}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : era.kind === "fit-pct" || era.kind === "fit-words" ? (
                    <div className="flex h-full flex-col justify-center gap-2">
                      {(era.kind === "fit-pct"
                        ? [["Kinkead Entertainment", "52%", "#e8f0e6", "#3f6b4f"], ["Lackey PLLC", "39%", "#e8f0e6", "#3f6b4f"], ["McKay Law", "61%", "#e8f0e6", "#3f6b4f"]]
                        : [["Kinkead Entertainment", "Great fit", "#e2ece5", "#3f6b4f"], ["Lackey PLLC", "Potential fit", "#fdf0dc", "#9a6b1f"], ["McKay Law", "Perfect fit", "#5c4634", "#ffffff"]]
                      ).map(([name, tag, bg, fg]) => (
                        <div key={name} className="flex items-center gap-2 rounded-lg border border-black/10 bg-white px-2 py-1.5 text-[9px]" style={{ color: era.colors.ink }}>
                          <b>{name}</b>
                          <span className="ml-auto rounded-full px-1.5 py-0.5 text-[8px] font-bold" style={{ background: bg, color: fg }}>
                            {tag}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : era.kind === "dash-matches" || era.kind === "dash-numbers" ? (
                    era.kind === "dash-matches" ? (
                      <div className="flex h-full flex-col gap-1.5 text-[8px]" style={{ color: era.colors.ink }}>
                        <div className="rounded-lg border border-black/10 bg-white p-2">
                          <div className="text-[7px] font-bold uppercase tracking-wide" style={{ color: era.colors.button }}>Top match today</div>
                          <div className="text-[10px] font-extrabold">Window Music Publishing</div>
                          <span className="mt-1 inline-block rounded px-2 py-0.5 font-bold text-white" style={{ background: era.colors.button }}>Send in my voice</span>
                        </div>
                        {["Julie Pryor", "Capitol CMG"].map((n) => (
                          <div key={n} className="flex items-center gap-1.5 rounded-lg border border-black/10 bg-white px-2 py-1">
                            <b>{n}</b>
                            <span className="ml-auto opacity-60">Draft</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="flex h-full flex-col gap-1.5 text-[8px]" style={{ color: era.colors.ink }}>
                        <div className="grid grid-cols-3 gap-1.5">
                          {[["45", "Finds"], ["12", "Sent"], ["18%", "Replies"], ["50%", "On-target"], ["21", "Searches"], ["4", "Hours saved"]].map(([v, l]) => (
                            <div key={l} className="rounded-lg border border-black/10 bg-white p-1.5">
                              <div className="text-[11px] font-extrabold">{v}</div>
                              <div className="opacity-60">{l}</div>
                            </div>
                          ))}
                        </div>
                        <div className="rounded-lg border border-black/10 bg-white px-2 py-1.5">
                          <b>What Scout learned:</b> you keep smaller companies and pass on big brands.
                        </div>
                      </div>
                    )
                  ) : era.kind === "form" ? (
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
        </div>
        ))}
        <p className="mt-3 text-xs text-body/55">
          New eras get added here when the design meaningfully changes, so this
          stays the record of where the look has been.
        </p>
      </section>
    </div>
  );
}
