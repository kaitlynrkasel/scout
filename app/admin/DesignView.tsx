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

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import {
  IDEAS,
  PRESETS,
  SIX_ON_WHITE,
  applyPalette,
  contrastOnWhite,
  darken,
  isHex,
  lighten,
  loadSaved,
  saveSaved,
  textOn,
  type IdeaKey,
  type Palette,
} from "@/lib/designLab";

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

// A wide spread of ready palettes, grouped for the dropdown. Warm, cool,
// bold, muted, dark: enough range that "try something different" always has
// somewhere to go.
const PRESET_PALETTES: { name: string; group: string; colors: string[] }[] = [
  { name: "Shipped Scout", group: "Warm", colors: ["#2b2723", "#5c4634", "#536872", "#f6efe6", "#f8f7f5", "#377ec0"] },
  { name: "Espresso", group: "Warm", colors: ["#1f1712", "#3b2c20", "#6f4e37", "#c89f7c", "#efe3d5", "#a3542f"] },
  { name: "Desert clay", group: "Warm", colors: ["#2c1c14", "#8a5a44", "#c98a5e", "#e8c9a8", "#faf3ea", "#3f5666"] },
  { name: "Harvest", group: "Warm", colors: ["#241a0e", "#6b4a1f", "#a9761f", "#e0b45c", "#faf3e3", "#6d3f52"] },
  { name: "Terracotta", group: "Warm", colors: ["#2a1611", "#7a3b2a", "#c4664a", "#e8a186", "#faf0ea", "#3f5f4a"] },
  { name: "Honey oak", group: "Warm", colors: ["#251b0f", "#5f4426", "#a97f3f", "#dcc08a", "#faf5e9", "#536872"] },
  { name: "Cinnamon", group: "Warm", colors: ["#231210", "#6b3428", "#a45c3d", "#d9a37f", "#f9efe6", "#2f5d70"] },
  { name: "Saddle", group: "Warm", colors: ["#1d1410", "#4a3524", "#8a6844", "#c9ae85", "#f6f0e6", "#7a3b2a"] },
  { name: "Tidepool", group: "Cool", colors: ["#0e2a33", "#155e63", "#12baaa", "#9fd2d6", "#f2f7f6", "#f7891f"] },
  { name: "Denim", group: "Cool", colors: ["#141c26", "#2b3f57", "#537ba2", "#a9c2d8", "#f4f7fa", "#c96f3a"] },
  { name: "Harbor slate", group: "Cool", colors: ["#161c1f", "#2f4356", "#536872", "#a5b0b6", "#f3f5f6", "#12baaa"] },
  { name: "Deep pine", group: "Cool", colors: ["#0f1f18", "#1e4034", "#4a5f52", "#a8c5b2", "#f1f6f2", "#e0a53a"] },
  { name: "Glacier", group: "Cool", colors: ["#101d29", "#1f4e66", "#4a90b8", "#b5d8e8", "#f2f8fb", "#e0693a"] },
  { name: "Juniper", group: "Cool", colors: ["#12201b", "#2a4f42", "#5f8a6f", "#bcd8c4", "#f2f7f3", "#a45c3d"] },
  { name: "North sea", group: "Cool", colors: ["#0d151f", "#22364f", "#3f5f8a", "#9fb5d0", "#f1f4f9", "#c9a13f"] },
  { name: "Eucalyptus", group: "Cool", colors: ["#152019", "#3a5f4a", "#7aa88a", "#cfe6d5", "#f4f9f5", "#8a5a9f"] },
  { name: "Sunset motel", group: "Bold", colors: ["#241b2f", "#5460ac", "#f04f52", "#f7891f", "#fbdf54", "#fdf6ec"] },
  { name: "Citrus press", group: "Bold", colors: ["#20250f", "#5a5f3f", "#a3b02a", "#fbdf54", "#fbfaef", "#f04f52"] },
  { name: "Bubblegum", group: "Bold", colors: ["#2a1622", "#8a2f5c", "#e0699e", "#f7c2d8", "#fdf3f7", "#377ec0"] },
  { name: "Arcade", group: "Bold", colors: ["#160f26", "#3b2a7a", "#7a5aa8", "#e0699e", "#f5f1fb", "#12baaa"] },
  { name: "Poppy field", group: "Bold", colors: ["#1c1512", "#5f2a22", "#d64541", "#f2a48f", "#fbf2ec", "#3f6b4f"] },
  { name: "Marigold", group: "Bold", colors: ["#231a08", "#7a5210", "#e8a417", "#f7d374", "#fdf8ea", "#5460ac"] },
  { name: "Kingfisher", group: "Bold", colors: ["#0c1c26", "#155e8a", "#12a4d6", "#8fd8f0", "#f0f9fc", "#f0742a"] },
  { name: "Watermelon", group: "Bold", colors: ["#152015", "#2f6b3f", "#6fc06a", "#f27d88", "#fbf5f0", "#26141a"] },
  { name: "Meadow", group: "Muted", colors: ["#1e2a1c", "#3f5f3a", "#7ba05b", "#cfe3b8", "#f6f8ef", "#c96f3a"] },
  { name: "Ink and paper", group: "Muted", colors: ["#14161a", "#3a3f4a", "#7b8494", "#d8dbe0", "#fafbfc", "#b5443c"] },
  { name: "Rosewood", group: "Muted", colors: ["#26141a", "#5f2a3a", "#a04a5e", "#dba6b0", "#faf1f3", "#3f6b4f"] },
  { name: "Grape soda", group: "Muted", colors: ["#231631", "#4a2d6b", "#7a5aa8", "#c9b6e4", "#f7f3fb", "#12baaa"] },
  { name: "Oat milk", group: "Muted", colors: ["#221f1a", "#5f584a", "#a89f8a", "#ddd6c4", "#faf8f2", "#7a4a3c"] },
  { name: "Sea fog", group: "Muted", colors: ["#1a1f20", "#48585c", "#8aa0a5", "#ccd9db", "#f5f8f8", "#a3542f"] },
  { name: "Lavender field", group: "Muted", colors: ["#1e1a26", "#4f4468", "#8f82ad", "#d5cde5", "#f8f6fb", "#3f6b4f"] },
  { name: "Clay pot", group: "Muted", colors: ["#211713", "#5c4634", "#9a7a5f", "#d8c3ad", "#f8f2ea", "#2f5d70"] },
  { name: "Night shift", group: "Dark", colors: ["#0b0d12", "#1c2230", "#39415a", "#8b93ad", "#e8eaf1", "#f7891f"] },
  { name: "Charcoal", group: "Dark", colors: ["#0e0e0e", "#262626", "#4a4a4a", "#9c9c9c", "#f0f0f0", "#e0693a"] },
  { name: "Aubergine", group: "Dark", colors: ["#150b14", "#331f33", "#5f3a5f", "#a58aa5", "#f3edf3", "#c9a13f"] },
  { name: "Forest floor", group: "Dark", colors: ["#0d120c", "#22301e", "#40543a", "#8fa585", "#eef2ec", "#a45c3d"] },
  { name: "Midnight teal", group: "Dark", colors: ["#081418", "#12333d", "#1f5f6b", "#7fb0ba", "#ecf4f5", "#f0742a"] },
  { name: "Espresso noir", group: "Dark", colors: ["#0f0a07", "#291b12", "#4a3323", "#9a8064", "#f1ebe3", "#537ba2"] },
];

// The Puck page editor is heavy and browser-only; load it only when the
// Page editor mode is opened.
const PageEditor = dynamic(() => import("./PageEditor"), {
  ssr: false,
  loading: () => (
    <p className="rounded-2xl border border-warm-border bg-surface p-6 text-sm text-body/60">
      Opening the page editor…
    </p>
  ),
});

export default function DesignView({
  getToken,
}: {
  getToken?: () => Promise<string | null>;
}) {
  // Two rooms: the token playground, and the full drag-and-drop page editor.
  const [mode, setMode] = useState<"playground" | "editor">("playground");
  // Inside the editor overlay: the live site first, blocks only behind Edit.
  const [editorView, setEditorView] = useState<"preview" | "edit">("preview");
  const [previewPath, setPreviewPath] = useState<"/" | "/app">("/");
  const liveFrameRef = useRef<HTMLIFrameElement | null>(null);
  const [liveChanges, setLiveChanges] = useState<LiveChange[]>([]);
  const [scheme, setScheme] = useState<Scheme>(() => ({ ...DEFAULT_SCHEME }));
  const [rainbow, setRainbow] = useState<string[]>([...DEFAULT_RAINBOW]);
  // Colour-by-meaning: the six ideas, plus whether the palette is painted onto
  // the real app so it can be walked through rather than only previewed here.
  const [ideaPalette, setIdeaPalette] = useState<Palette>(SIX_ON_WHITE);
  const [paintApp, setPaintApp] = useState(false);
  const ideasLoaded = useRef(false);
  useEffect(() => {
    const saved = loadSaved();
    if (saved) {
      setIdeaPalette(saved.palette);
      setPaintApp(saved.whole);
    }
    ideasLoaded.current = true;
  }, []);
  useEffect(() => {
    if (!ideasLoaded.current) return;
    applyPalette(ideaPalette, paintApp);
    saveSaved({ palette: ideaPalette, whole: paintApp });
  }, [ideaPalette, paintApp]);
  const setIdea = (key: IdeaKey, hex: string) =>
    setIdeaPalette((p) => ({ ...p, ideas: { ...p.ideas, [key]: hex } }));
  const [copied, setCopied] = useState(false);
  const [typedColors, setTypedColors] = useState("");
  const [sourceNote, setSourceNote] = useState("");
  const [style, setStyle] = useState({
    radiusPx: 16,
    spacing: "cozy" as "compact" | "cozy" | "roomy",
    navIconPx: 21,
    displayWeight: 700,
    buttonShape: "pill" as "pill" | "rounded",
    shadow: "soft" as "none" | "soft" | "strong",
  });
  const [designNotes, setDesignNotes] = useState<string[]>([]);
  const [designPrompt, setDesignPrompt] = useState("");
  const [promptBusy, setPromptBusy] = useState(false);
  const [promptSummary, setPromptSummary] = useState("");
  const [briefCopied, setBriefCopied] = useState(false);

  // Prompt -> proposal -> preview. The proposal only ever lands in the same
  // tokens the preview renders, so what you see is exactly what was proposed.
  async function runDesignPrompt() {
    const pr = designPrompt.trim();
    if (!pr || promptBusy || !getToken) return;
    setPromptBusy(true);
    setPromptSummary("");
    try {
      const token = await getToken();
      if (!token) throw new Error("Sign in again.");
      const r = await fetch("/api/admin/design-prompt", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ prompt: pr, scheme, rainbow, style }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || "Could not read that instruction.");
      if (j.scheme) setScheme((prev) => ({ ...prev, ...j.scheme }));
      if (j.rainbow) setRainbow(j.rainbow);
      if (j.style) setStyle(j.style);
      setDesignNotes(Array.isArray(j.notes) ? j.notes : []);
      setSourceNote(`prompt: ${pr.slice(0, 40)}`);
      setPromptSummary(j.summary || "Applied to the preview.");
    } catch (e: any) {
      setPromptSummary(e?.message || "Could not read that instruction.");
    } finally {
      setPromptBusy(false);
    }
  }

  // "Implement" = a complete brief on the clipboard: the instruction, the
  // resulting tokens, and where they go. Paste it to engineering and the
  // change is unambiguous.
  function copyImplementationBrief() {
    const brief = [
      "Scout design change request",
      `Instruction: ${designPrompt.trim() || sourceNote || "(tuned by hand)"}`,
      promptSummary ? `Summary: ${promptSummary}` : "",
      "",
      "Tokens (apply in app/globals.css + tailwind.config.ts):",
      ...Object.entries(scheme).map(([k, v]) => `  ${k}: ${v}`),
      `  Rainbow: ${rainbow.join(", ")}`,
      `  Corner radius: ${style.radiusPx}px, spacing: ${style.spacing}, nav icons: ${style.navIconPx}px,`,
      `  display weight: ${style.displayWeight}, buttons: ${style.buttonShape}, shadows: ${style.shadow}`,
      ...(designNotes.length
        ? ["", "Beyond tokens (implement by hand):", ...designNotes.map((n) => `  - ${n}`)]
        : []),
      "",
      "Surfaces affected: Scout stage, work area, canvas, cards, tiles, monograms, nav.",
    ]
      .filter(Boolean)
      .join("\n");
    try {
      navigator.clipboard.writeText(brief);
      setBriefCopied(true);
      setTimeout(() => setBriefCopied(false), 1800);
    } catch {}
  }

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
  // Style tokens rendered into the preview: radius, spacing, shadows, shapes.
  const pad = style.spacing === "compact" ? 16 : style.spacing === "roomy" ? 32 : 24;
  const cardRadius = style.radiusPx;
  const btnRadius = style.buttonShape === "pill" ? 999 : Math.min(12, style.radiusPx);
  const shadowCss =
    style.shadow === "none"
      ? "none"
      : style.shadow === "strong"
        ? "0 14px 34px rgb(0 0 0 / 0.22)"
        : "0 6px 18px rgb(0 0 0 / 0.10)";
  const ordered = [...ERAS].sort(
    (a, b) => Number(pins.includes(b.id)) - Number(pins.includes(a.id))
  );

  return (
    <div className="space-y-10">
      {/* Which room */}
      <div className="inline-flex gap-1 rounded-xl border border-warm-border bg-warm-bg/40 p-1">
        {(
          [
            ["playground", "Tokens and palettes"],
            ["editor", "Website preview and editor"],
          ] as const
        ).map(([m, label]) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`rounded-lg px-3.5 py-1.5 text-xs font-bold transition ${
              mode === m ? "bg-surface text-ink shadow-card" : "text-body/70 hover:text-ink"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {mode === "editor" && (
        // Full screen: an editor in a centered column wastes the one thing an
        // editor needs, room. Fixed overlay over the whole viewport; Close
        // drops back to the tokens view.
        // Opens as the REAL website (live iframe, same as the readiness tab),
        // so you always know where you are. Edit in the top bar swaps to the
        // block editor; the mockup blocks are the editable stand-in, the
        // preview is the truth.
        <div className="fixed inset-0 z-[80] flex flex-col bg-warm-bg">
          <div className="flex items-center gap-3 border-b border-warm-border bg-surface px-4 py-2">
            <span className="text-sm font-extrabold text-ink">Design</span>
            <div className="inline-flex gap-1 rounded-lg border border-warm-border bg-warm-bg/40 p-0.5">
              {(
                [
                  ["preview", "Preview"],
                  ["edit", "Edit"],
                ] as const
              ).map(([v, label]) => (
                <button
                  key={v}
                  onClick={() => setEditorView(v)}
                  className={`rounded-md px-3 py-1 text-xs font-bold transition ${
                    editorView === v ? "bg-surface text-ink shadow-card" : "text-body/70 hover:text-ink"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            {true ? (
              <div className="inline-flex gap-1">
                {(
                  [
                    ["/", "Landing"],
                    ["/app", "App"],
                  ] as const
                ).map(([path, label]) => (
                  <button
                    key={path}
                    onClick={() => setPreviewPath(path)}
                    className={`rounded-md px-2.5 py-1 text-xs font-semibold transition ${
                      previewPath === path ? "text-ink underline underline-offset-4" : "text-body/60 hover:text-ink"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            ) : null}
            {editorView === "edit" && (
              <span className="hidden text-xs text-body/55 lg:block">
                Click anything in the page to select it; drag to move it; edit
                it on the right. Changes preview here only.
              </span>
            )}
            <button
              onClick={() => setMode("playground")}
              className="ml-auto rounded-lg border border-warm-border px-3 py-1.5 text-xs font-semibold text-body transition hover:bg-warm-bg"
            >
              Close
            </button>
          </div>
          <div className="flex min-h-0 flex-1">
            <iframe
              ref={liveFrameRef}
              src={previewPath}
              title="Scout, live"
              className="h-full min-w-0 flex-1 border-0 bg-cream"
            />
            {editorView === "edit" && (
              <LiveEditPanel
                frameRef={liveFrameRef}
                changes={liveChanges}
                setChanges={setLiveChanges}
              />
            )}
          </div>
        </div>
      )}

      {mode === "playground" && (
      <>
      {/* ---------------- Colour by meaning ----------------
          The scheme above colours SURFACES. This colours IDEAS: a person is
          always one colour, a reply always another, wherever either appears.
          That's what makes a single screen carry four or five colours without
          any of them being decoration. */}
      <section className="mb-8">
        <h2 className="text-lg font-bold text-ink">Colour by meaning</h2>
        <p className="mt-1 max-w-[62ch] text-sm leading-relaxed text-body/70">
          Each colour belongs to a kind of thing rather than to a screen.
          Wherever that thing shows up, its colour shows up — so a screen ends
          up carrying several at once. Everything here stays in this browser.
        </p>

        <div className="mt-4 grid gap-5 lg:grid-cols-[340px_minmax(0,1fr)]">
          <div className="space-y-2">
            <div className="mb-3 space-y-1.5">
              {PRESETS.map((preset) => {
                const active = preset.label === ideaPalette.label;
                return (
                  <button
                    key={preset.label}
                    onClick={() => setIdeaPalette(preset)}
                    className={`flex w-full items-center gap-2 rounded-xl border px-3 py-2.5 text-left transition ${
                      active
                        ? "border-brown bg-brown-tint/40"
                        : "border-warm-border hover:border-brown/50 hover:bg-warm-bg/50"
                    }`}
                  >
                    {IDEAS.map(({ key }) => (
                      <span
                        key={key}
                        className="h-5 w-5 rounded-md"
                        style={{ background: preset.ideas[key] }}
                      />
                    ))}
                    <span className="ml-1 text-xs font-bold text-ink">{preset.label}</span>
                  </button>
                );
              })}
            </div>

            {IDEAS.map(({ key, name, blurb }) => {
              const hex = ideaPalette.ideas[key];
              const ratio = contrastOnWhite(hex);
              return (
                <div key={key} className="flex items-center gap-2.5">
                  <input
                    type="color"
                    value={isHex(hex) ? hex : "#888888"}
                    onChange={(e) => setIdea(key, e.target.value)}
                    className="h-9 w-10 shrink-0 cursor-pointer rounded border border-warm-border bg-transparent"
                    aria-label={`Colour for ${name}`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-bold text-ink">{name}</div>
                    <div className="truncate text-[11px] text-body/60" title={blurb}>
                      {blurb}
                    </div>
                  </div>
                  <span
                    className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold tabular-nums"
                    style={{ background: lighten(hex), color: darken(hex) }}
                    title="Contrast against white. Under 4.5:1 can't carry small text."
                  >
                    {ratio}:1
                  </span>
                </div>
              );
            })}

            <label className="mt-3 flex cursor-pointer items-start gap-2.5 rounded-xl border border-warm-border bg-surface p-3">
              <input
                type="checkbox"
                checked={paintApp}
                onChange={(e) => setPaintApp(e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-brown"
              />
              <span className="text-xs leading-relaxed text-body">
                <b className="text-ink">Paint the real app in this.</b> Open
                Scout in another tab and use it normally. Background, text and
                the main accent change; the six meanings need wiring into
                components before they show up out there.
              </span>
            </label>
          </div>

          {/* What several meanings on one screen actually looks like. */}
          <div
            className="rounded-2xl border border-warm-border p-4 shadow-soft"
            style={{ background: ideaPalette.ground }}
          >
            <div className="text-base font-extrabold tracking-tight" style={{ color: ideaPalette.ink }}>
              Tuesday, Kaitlyn
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2">
              {(
                [
                  ["12", "People", ideaPalette.ideas.person],
                  ["7", "Sent", ideaPalette.ideas.sent],
                  ["2", "Replies", ideaPalette.ideas.reply],
                ] as const
              ).map(([n, label, hex]) => (
                <div key={label} className="rounded-xl p-2.5" style={{ background: lighten(hex) }}>
                  <div className="text-xl font-extrabold leading-none tabular-nums" style={{ color: darken(hex) }}>
                    {n}
                  </div>
                  <div className="mt-1 text-[9px] font-bold uppercase tracking-wider" style={{ color: darken(hex) }}>
                    {label}
                  </div>
                </div>
              ))}
            </div>
            <div
              className="mt-3 rounded-lg px-3 py-2 text-center text-xs font-bold"
              style={{
                background: ideaPalette.ideas.search,
                color: textOn(ideaPalette.ideas.search),
              }}
            >
              Run a search
            </div>
            <div
              className="mt-3 flex flex-col gap-1.5 rounded-xl border p-3"
              style={{ background: ideaPalette.surface, borderColor: lighten(ideaPalette.ink, 0.86) }}
            >
              <div className="flex flex-wrap gap-1.5">
                {(
                  [
                    ["Person", ideaPalette.ideas.person],
                    ["Replied", ideaPalette.ideas.reply],
                    ["Cue Creative", ideaPalette.ideas.shared],
                  ] as const
                ).map(([label, hex]) => (
                  <span
                    key={label}
                    className="rounded-full px-2 py-[3px] text-[9px] font-extrabold uppercase tracking-wider"
                    style={{ background: lighten(hex), color: darken(hex) }}
                  >
                    {label}
                  </span>
                ))}
              </div>
              <div className="text-[13px] font-bold" style={{ color: ideaPalette.ink }}>
                George Wang, MSEL &rsquo;22
              </div>
              <div className="text-[11px]" style={{ color: lighten(ideaPalette.ink, 0.42) }}>
                Founder · Amptra Charging
              </div>
              <div
                className="mt-1 rounded-lg px-3 py-1.5 text-center text-[11px] font-bold"
                style={{
                  background: ideaPalette.ideas.voice,
                  color: textOn(ideaPalette.ideas.voice),
                }}
              >
                Draft a message
              </div>
            </div>
            <p className="mt-3 text-[11px] leading-relaxed" style={{ color: lighten(ideaPalette.ink, 0.45) }}>
              Five colours on one screen, and every one of them is saying what
              something is.
            </p>
          </div>
        </div>
      </section>

      {/* ---------------- Playground ---------------- */}
      <section>
        <h2 className="text-lg font-bold text-ink">Try a design</h2>
        <p className="mt-1 max-w-[62ch] text-sm leading-relaxed text-body/70">
          Colors, corners, spacing, type, icon sizes: describe a change or edit
          the tokens and the preview re-renders live. Nothing here touches the
          real app; when it feels right, Implement copies the exact brief.
        </p>
        {/* Prompt a change: describe it, preview it, then hand it over. */}
        <div className="mt-4 rounded-2xl border border-warm-border bg-surface p-4">
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={designPrompt}
              onChange={(e) => setDesignPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") runDesignPrompt();
              }}
              placeholder={'Describe a change and press Enter, e.g. "warmer and softer, terracotta accent" or "make it feel like a bank"'}
              className="min-w-[260px] flex-1 rounded-xl border border-warm-border bg-surface px-3.5 py-2.5 text-sm text-ink outline-none transition focus:border-brown"
            />
            <button
              onClick={runDesignPrompt}
              disabled={promptBusy || !designPrompt.trim()}
              className="rounded-xl bg-brand-gradient px-4 py-2.5 text-sm font-bold text-white shadow-soft transition hover:opacity-95 disabled:opacity-50"
            >
              {promptBusy ? "Designing…" : "Preview it"}
            </button>
            <button
              onClick={copyImplementationBrief}
              className="rounded-xl border border-warm-border px-4 py-2.5 text-sm font-semibold text-body transition hover:bg-warm-bg"
              title="Copies the instruction and the exact tokens as a ready-to-implement brief"
            >
              {briefCopied ? "Brief copied" : "Implement: copy the brief"}
            </button>
          </div>
          {promptSummary && (
            <p className="mt-2 text-xs leading-relaxed text-body/70">{promptSummary}</p>
          )}
          {designNotes.length > 0 && (
            <ul className="mt-1.5 space-y-1 text-xs leading-relaxed text-body/70">
              {designNotes.map((n, i) => (
                <li key={i} className="flex gap-2">
                  <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-brown" />
                  <span>
                    <b className="text-ink">Needs a hand:</b> {n}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Start from anywhere: a preset, a photo, or a pasted list. */}
        <div className="mt-4">
          <PalettePicker current={sourceNote} onPick={(pp) => applyColors(pp.colors, pp.name)} />
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
            <div style={{ background: s("Stage brown"), color: s("Cream"), padding: pad }}>
              {/* Nav strip: menu icons at the token size, so "make the symbols
                  bigger" is a change you can SEE here. */}
              <div className="mb-4 flex items-center gap-4">
                {["Dashboard", "Scout", "Finds", "Projects"].map((n, i) => (
                  <span key={n} className={`flex items-center gap-1.5 text-xs font-semibold ${i === 1 ? "opacity-100" : "opacity-55"}`}>
                    <svg width={style.navIconPx} height={style.navIconPx} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      {i === 0 ? (
                        <>
                          <rect x="3" y="3" width="7" height="9" rx="1.5" />
                          <rect x="14" y="3" width="7" height="5" rx="1.5" />
                          <rect x="14" y="12" width="7" height="9" rx="1.5" />
                          <rect x="3" y="16" width="7" height="5" rx="1.5" />
                        </>
                      ) : i === 1 ? (
                        <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4L3 21l1.1-3.3A8.4 8.4 0 1 1 21 11.5Z" />
                      ) : i === 2 ? (
                        <path d="M20 6 9 17l-5-5" />
                      ) : (
                        <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.2l1.8 2.2h8A2.5 2.5 0 0 1 21 9.7v7.8A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5z" />
                      )}
                    </svg>
                    {n}
                  </span>
                ))}
              </div>
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
                className="mt-4 inline-block px-6 py-2 text-sm"
                style={{
                  background: s("Cream"),
                  color: s("Stage brown"),
                  borderRadius: btnRadius,
                  fontWeight: style.displayWeight,
                }}
              >
                Scout
              </span>
            </div>
            <div style={{ background: s("Work area"), padding: pad }}>
              <div
                className="max-w-sm p-4"
                style={{ background: s("Canvas"), color: s("Ink"), borderRadius: cardRadius, boxShadow: shadowCss }}
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

            {/* The rest of the site, same tokens: landing, dashboard, finds grid. */}
            <div style={{ background: s("Canvas"), color: s("Ink"), padding: pad }} className="border-t">
              <div className="text-[10px] font-bold uppercase tracking-[0.14em] opacity-50">
                Landing
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-4">
                <div>
                  <div className="font-display text-2xl leading-tight" style={{ fontWeight: style.displayWeight }}>
                    Find your people.
                  </div>
                  <div className="mt-0.5 text-xs opacity-60">
                    Scout finds who to reach and writes the first note in your voice.
                  </div>
                </div>
                <span
                  className="px-4 py-2 text-sm font-bold"
                  style={{ background: s("Stage brown"), color: s("Cream"), borderRadius: btnRadius }}
                >
                  Start free
                </span>
                <span
                  className="border px-4 py-2 text-sm font-semibold"
                  style={{ borderColor: `${s("Ink")}33`, borderRadius: btnRadius }}
                >
                  See how it works
                </span>
              </div>

              <div className="mt-5 text-[10px] font-bold uppercase tracking-[0.14em] opacity-50">
                Dashboard
              </div>
              <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-6">
                {[["45", "Finds"], ["12", "Sent"], ["18%", "Replies"], ["50%", "On-target"], ["21", "Searches"], ["4", "Hours saved"]].map(([v, l]) => (
                  <div
                    key={l}
                    className="border p-2.5"
                    style={{ background: "#ffffff", borderColor: `${s("Ink")}1a`, borderRadius: Math.min(cardRadius, 14), boxShadow: shadowCss }}
                  >
                    <div className="font-display text-lg font-bold leading-none">{v}</div>
                    <div className="mt-1 text-[10px] opacity-60">{l}</div>
                  </div>
                ))}
              </div>

              <div className="mt-5 text-[10px] font-bold uppercase tracking-[0.14em] opacity-50">
                Finds grid
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
                {["Slevin & Hart", "Kinkead", "McKay Law"].map((n, i) => (
                  <div
                    key={n}
                    className="overflow-hidden border"
                    style={{ background: "#ffffff", borderColor: `${s("Ink")}1a`, borderRadius: Math.min(cardRadius, 14), boxShadow: shadowCss }}
                  >
                    <div
                      className="grid h-14 place-items-center"
                      style={{ background: rainbow[i % rainbow.length] }}
                    >
                      <span
                        className="grid h-6 w-6 place-items-center rounded bg-white/85 text-[10px] font-bold"
                        style={{ color: rainbow[i % rainbow.length] }}
                      >
                        {n[0]}
                      </span>
                    </div>
                    <div className="p-2 text-[11px] font-bold">{n}</div>
                  </div>
                ))}
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
      </>
      )}
    </div>
  );
}


/* A dropdown where every row SHOWS its palette: a native <select> paints only
 * text, which made picking colors blind. Grouped, keyboard-escapable, closes
 * on outside click. */
function PalettePicker({
  current,
  onPick,
}: {
  current: string;
  onPick: (pp: { name: string; colors: string[] }) => void;
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const selected = PRESET_PALETTES.find((pp) => pp.name === current);
  return (
    <div ref={boxRef} className="relative inline-block">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex items-center gap-3 rounded-xl border border-warm-border bg-surface px-3.5 py-2.5 text-sm font-semibold text-ink transition hover:border-brown/50"
      >
        {selected ? (
          <>
            <span className="flex overflow-hidden rounded-md">
              {selected.colors.map((c) => (
                <span key={c} className="h-5 w-5" style={{ background: c }} />
              ))}
            </span>
            {selected.name}
          </>
        ) : (
          "Pick a palette…"
        )}
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className={`text-body/50 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div
          role="listbox"
          className="absolute left-0 z-40 mt-1.5 max-h-[420px] w-[340px] overflow-auto rounded-2xl border border-warm-border bg-surface p-2 shadow-xl"
        >
          {Array.from(new Set(PRESET_PALETTES.map((pp) => pp.group))).map((g) => (
            <div key={g}>
              <div className="px-2 pb-1 pt-2 text-[10px] font-bold uppercase tracking-wider text-body/50">
                {g}
              </div>
              {PRESET_PALETTES.filter((pp) => pp.group === g).map((pp) => (
                <button
                  key={pp.name}
                  role="option"
                  aria-selected={pp.name === current}
                  onClick={() => {
                    onPick(pp);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center gap-3 rounded-xl px-2 py-1.5 text-left text-sm transition ${
                    pp.name === current
                      ? "bg-brown-tint/60 font-bold text-brown-deep"
                      : "font-medium text-body hover:bg-warm-bg"
                  }`}
                >
                  <span className="flex shrink-0 overflow-hidden rounded-md">
                    {pp.colors.map((c) => (
                      <span key={c} className="h-5 w-5" style={{ background: c }} />
                    ))}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{pp.name}</span>
                  {pp.name === current && (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-brown" aria-hidden><path d="M20 6 9 17l-5-5" /></svg>
                  )}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


/* ---------------- In-place live editor ----------------
 * Edits the REAL page in the preview iframe, right where you are. Same-origin,
 * so the parent can reach the document: hover outlines anything, click selects
 * it, drag moves it (a transform, so layout math stays honest), and the panel
 * edits its text and styles inline. Every change is recorded as
 * selector + property + value and copies out as a brief; a reload of the
 * frame discards the preview, which is the point, the live site is never
 * written from here. */
interface LiveChange {
  selector: string;
  prop: string;
  value: string;
  label: string;
}

function cssPath(el: Element): string {
  if ((el as HTMLElement).id) return `#${(el as HTMLElement).id}`;
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur.tagName.toLowerCase() !== "body" && parts.length < 6) {
    const tag = cur.tagName.toLowerCase();
    const parent: Element | null = cur.parentElement;
    if (!parent) break;
    const sibs = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName);
    parts.unshift(sibs.length > 1 ? `${tag}:nth-of-type(${sibs.indexOf(cur) + 1})` : tag);
    cur = parent;
  }
  return `body > ${parts.join(" > ")}`;
}

export function LiveEditPanel({
  frameRef,
  changes,
  setChanges,
}: {
  frameRef: React.RefObject<HTMLIFrameElement | null>;
  changes: LiveChange[];
  setChanges: React.Dispatch<React.SetStateAction<LiveChange[]>>;
}) {
  // Shift-click builds a multi-selection; every edit applies to all of it.
  const [sels, setSels] = useState<HTMLElement[]>([]);
  const sel = sels[0] || null; // the panel reads the first as representative
  const [, bump] = useState(0);
  const [copied, setCopied] = useState(false);
  const selRef = useRef<HTMLElement[]>([]);
  selRef.current = sels;
  // Undo/redo: each action stores how to put things back. Text and style edits
  // both flow through here, so cmd+Z walks everything.
  // Steps carry a gesture id so one cmd+Z reverses a whole group action
  // (dragging five selected cards is one undo, not five).
  const undoRef = useRef<{ el: HTMLElement; prop: string; prev: string; next: string; g: number }[]>([]);
  const redoRef = useRef<{ el: HTMLElement; prop: string; prev: string; next: string; g: number }[]>([]);
  const gestureRef = useRef(0);

  const record = (el: HTMLElement, prop: string, value: string) => {
    const selector = cssPath(el);
    const label = (el.innerText || el.tagName).trim().slice(0, 40);
    setChanges((prev) => [
      ...prev.filter((c) => !(c.selector === selector && c.prop === prop)),
      { selector, prop, value, label },
    ]);
  };
  const pushUndo = (el: HTMLElement, prop: string, prev: string, next: string, g?: number) => {
    undoRef.current.push({ el, prop, prev, next, g: g ?? ++gestureRef.current });
    if (undoRef.current.length > 200) undoRef.current.shift();
    redoRef.current = [];
  };
  const applyRaw = (el: HTMLElement, prop: string, value: string) => {
    if (prop === "text") el.innerText = value;
    else (el.style as any)[prop] = value;
    record(el, prop, value);
  };
  const undo = () => {
    liveEditRef.current = null;
    const last = undoRef.current[undoRef.current.length - 1];
    if (!last) return;
    while (undoRef.current.length && undoRef.current[undoRef.current.length - 1].g === last.g) {
      const step = undoRef.current.pop()!;
      redoRef.current.push(step);
      applyRaw(step.el, step.prop, step.prev);
    }
    bump((n) => n + 1);
  };
  const redo = () => {
    liveEditRef.current = null;
    const last = redoRef.current[redoRef.current.length - 1];
    if (!last) return;
    while (redoRef.current.length && redoRef.current[redoRef.current.length - 1].g === last.g) {
      const step = redoRef.current.pop()!;
      undoRef.current.push(step);
      applyRaw(step.el, step.prop, step.next);
    }
    bump((n) => n + 1);
  };

  // Snap to grid: drags land on an 8px grid unless free-drag is on.
  const [snap, setSnap] = useState(true);
  const snapRef = useRef(true);
  snapRef.current = snap;

  // Wire the iframe document: outline on hover, click selects (shift-click
  // adds), drag moves the whole selection (snapped or free), keyboard runs
  // the usual commands.
  useEffect(() => {
    const frame = frameRef.current;
    const doc0 = frame?.contentDocument;
    if (!doc0) return;
    const doc: Document = doc0;
    const OUTLINE = "2px solid #377ec0";
    const SELECTED = "3px solid #f7891f";
    let hovered: HTMLElement | null = null;
    let drag:
      | {
          els: { el: HTMLElement; ox: number; oy: number }[];
          sx: number;
          sy: number;
          moved: boolean;
          axis?: boolean;
        }
      | null = null;
    // Alignment guides, Canva-style: while one element drags, its edges and
    // center snap to nearby elements' edges and centers, with pink guide
    // lines while the snap holds. Rects are cached at drag start.
    let guideRects: { l: number; r: number; t: number; b: number; cx: number; cy: number }[] = [];
    let guideEls: HTMLDivElement[] = [];
    const clearGuides = () => {
      for (const g of guideEls) g.remove();
      guideEls = [];
    };
    const drawGuide = (vertical: boolean, pos: number) => {
      const g = doc.createElement("div");
      g.style.cssText = `position:fixed;z-index:2147483646;background:#e0699e;pointer-events:none;${
        vertical ? `left:${pos}px;top:0;width:1px;height:100vh` : `top:${pos}px;left:0;height:1px;width:100vw`
      }`;
      doc.body.appendChild(g);
      guideEls.push(g);
    };

    const readOffset = (el: HTMLElement): [number, number] => {
      const m = /translate\((-?\d+(?:\.\d+)?)px,\s*(-?\d+(?:\.\d+)?)px\)/.exec(
        el.style.transform || ""
      );
      return m ? [parseFloat(m[1]), parseFloat(m[2])] : [0, 0];
    };
    const setOffset = (el: HTMLElement, x: number, y: number) => {
      el.style.transform = `translate(${x}px, ${y}px)`;
    };
    const grid = (v: number) => (snapRef.current ? Math.round(v / 8) * 8 : v);
    const paint = (list: HTMLElement[]) => {
      for (const el of list) el.style.outline = SELECTED;
    };
    const clearPaint = (list: HTMLElement[]) => {
      for (const el of list) el.style.outline = "";
    };

    const over = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t || t === doc.body || t === hovered) return;
      if (hovered && !selRef.current.includes(hovered)) hovered.style.outline = "";
      hovered = t;
      if (!selRef.current.includes(t)) t.style.outline = OUTLINE;
    };
    const out = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t && !selRef.current.includes(t)) t.style.outline = "";
      if (hovered === t) hovered = null;
    };
    // Shift-drag rubber band: everything the rectangle touches joins the
    // selection. A shift-press that never moves stays a plain toggle click.
    let marquee: { sx: number; sy: number; box: HTMLDivElement; moved: boolean } | null = null;
    const startMarquee = (e: MouseEvent) => {
      const box = doc.createElement("div");
      box.style.cssText =
        "position:fixed;z-index:2147483647;border:1.5px solid #377ec0;background:rgba(55,126,192,.12);pointer-events:none;left:0;top:0;width:0;height:0";
      doc.body.appendChild(box);
      marquee = { sx: e.clientX, sy: e.clientY, box, moved: false };
    };
    const marqueeRect = (e: MouseEvent) => {
      const x = Math.min(marquee!.sx, e.clientX);
      const y = Math.min(marquee!.sy, e.clientY);
      const w = Math.abs(e.clientX - marquee!.sx);
      const h = Math.abs(e.clientY - marquee!.sy);
      return { x, y, w, h };
    };
    function finishMarquee(e: MouseEvent) {
      if (!marquee) return;
      const { x, y, w, h } = marqueeRect(e);
      marquee.box.remove();
      const wasDrag = marquee.moved && w + h > 8;
      marquee = null;
      if (!wasDrag) {
        // No real rectangle: plain shift-click toggle on the target.
        const t = e.target as HTMLElement;
        if (t && t !== doc.body) {
          const next = selRef.current.includes(t)
            ? selRef.current.filter((el) => el !== t)
            : [...selRef.current, t];
          clearPaint(selRef.current);
          setSels(next);
          paint(next);
        }
        return;
      }
      const vw = doc.documentElement.clientWidth;
      const vh = doc.documentElement.clientHeight;
      const hits: HTMLElement[] = [];
      for (const el of Array.from(doc.body.querySelectorAll("*")) as HTMLElement[]) {
        if (el === marqueeBoxGuard) continue;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        // Skip page-scale containers; a marquee means discrete pieces.
        if (r.width * r.height > vw * vh * 0.5) continue;
        const intersects = r.left < x + w && r.right > x && r.top < y + h && r.bottom > y;
        if (intersects) hits.push(el);
      }
      // Keep only elements with NO ANCESTOR in the hit set, so a card counts
      // once and its children never move separately (a parent-only check let
      // nested spans double-move and scatter the layout on group drags).
      const hitSet = new Set(hits);
      const keep = hits.filter((el) => {
        let a = el.parentElement;
        while (a && a !== doc.body) {
          if (hitSet.has(a)) return false;
          a = a.parentElement;
        }
        return true;
      });
      const next = Array.from(new Set([...selRef.current, ...keep])).slice(0, 80);
      clearPaint(selRef.current);
      setSels(next);
      paint(next);
    }
    const marqueeBoxGuard: HTMLElement | null = null;

    const down = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      e.preventDefault();
      e.stopPropagation();
      // Canva rules: dragging from empty space draws the marquee (no modifier
      // needed); shift also forces a marquee from anywhere.
      // "Empty" includes page-scale wrappers: clicking a section's background
      // between items reads as clicking off, so it deselects and can start a
      // marquee, exactly like the canvas in Canva.
      const vw2 = doc.documentElement.clientWidth;
      const vh2 = doc.documentElement.clientHeight;
      const tr = t && t !== doc.body ? t.getBoundingClientRect() : null;
      const isHuge = !!tr && tr.width * tr.height > vw2 * vh2 * 0.45;
      const onEmpty = !t || t === doc.body || t === doc.documentElement || isHuge;
      if (onEmpty || (e.shiftKey && !selRef.current.includes(t))) {
        if (e.shiftKey || onEmpty) {
          startMarquee(e);
          if (onEmpty && !e.shiftKey) {
            clearPaint(selRef.current);
            setSels([]);
          }
          return;
        }
      }
      let next: HTMLElement[];
      if (selRef.current.includes(t)) {
        next = selRef.current; // dragging an already-selected group keeps it
      } else {
        clearPaint(selRef.current);
        next = [t];
      }
      setSels(next);
      paint(next);
      const nextSet = new Set(next);
      const outermost = next.filter((el) => {
        let a = el.parentElement;
        while (a && a !== doc.body) {
          if (nextSet.has(a)) return false;
          a = a.parentElement;
        }
        return true;
      });
      drag = {
        els: outermost.map((el) => {
          const [ox, oy] = readOffset(el);
          return { el, ox, oy };
        }),
        sx: e.clientX,
        sy: e.clientY,
        moved: false,
        axis: e.shiftKey, // Canva: shift-drag on an element moves in a straight line
      };
      guideRects = [];
      if (next.length === 1) {
        const self = next[0];
        for (const el of Array.from(doc.body.querySelectorAll("*")) as HTMLElement[]) {
          if (el === self || self.contains(el) || el.contains(self)) continue;
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height || r.width * r.height > 300000) continue;
          guideRects.push({ l: r.left, r: r.right, t: r.top, b: r.bottom, cx: r.left + r.width / 2, cy: r.top + r.height / 2 });
          if (guideRects.length >= 150) break;
        }
      }
    };
    const move = (e: MouseEvent) => {
      // A release outside the iframe never sends this document a mouseup, which
      // left the marquee (or a drag) stuck to the cursor. No buttons held on a
      // move means the press ended elsewhere: finish now.
      if (e.buttons === 0 && (marquee || drag)) {
        if (marquee) finishMarquee(e);
        else up(e);
        return;
      }
      if (marquee) {
        marquee.moved = true;
        const { x, y, w, h } = marqueeRect(e);
        marquee.box.style.left = `${x}px`;
        marquee.box.style.top = `${y}px`;
        marquee.box.style.width = `${w}px`;
        marquee.box.style.height = `${h}px`;
        return;
      }
      if (!drag) return;
      const dx = e.clientX - drag.sx;
      const dy = e.clientY - drag.sy;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
      drag.moved = true;
      let ddx = dx;
      let ddy = dy;
      if (drag.axis) {
        // straight-line move: the dominant axis wins
        if (Math.abs(ddx) >= Math.abs(ddy)) ddy = 0;
        else ddx = 0;
      }
      clearGuides();
      if (drag.els.length === 1 && guideRects.length) {
        const el = drag.els[0].el;
        // Where the element WOULD land
        const base = el.getBoundingClientRect();
        const [curX, curY] = readOffset(el);
        const nx = drag.els[0].ox + ddx;
        const ny = drag.els[0].oy + ddy;
        const left = base.left + (nx - curX);
        const top = base.top + (ny - curY);
        const right = left + base.width;
        const bottom = top + base.height;
        const cx = left + base.width / 2;
        const cy = top + base.height / 2;
        const T = 6;
        let sx: number | null = null;
        let sy: number | null = null;
        for (const g of guideRects) {
          for (const [mine, theirs] of [
            [cx, g.cx],
            [left, g.l],
            [right, g.r],
          ] as const) {
            if (sx === null && Math.abs(mine - theirs) <= T) {
              sx = theirs - (mine - (nx - curX) - curX) - (curX - nx) + nx + (theirs - mine);
              sx = nx + (theirs - mine);
              drawGuide(true, theirs);
              break;
            }
          }
          for (const [mine, theirs] of [
            [cy, g.cy],
            [top, g.t],
            [bottom, g.b],
          ] as const) {
            if (sy === null && Math.abs(mine - theirs) <= T) {
              sy = ny + (theirs - mine);
              drawGuide(false, theirs);
              break;
            }
          }
          if (sx !== null && sy !== null) break;
        }
        setOffset(el, sx !== null ? sx : grid(nx), sy !== null ? sy : grid(ny));
        return;
      }
      for (const d of drag.els) setOffset(d.el, grid(d.ox + ddx), grid(d.oy + ddy));
    };
    function up(e: MouseEvent) {
      clearGuides();
      if (marquee) {
        finishMarquee(e);
        drag = null;
        return;
      }
      if (drag?.moved) {
        const g = ++gestureRef.current;
        for (const d of drag.els) {
          const [x, y] = readOffset(d.el);
          pushUndo(d.el, "transform", `translate(${d.ox}px, ${d.oy}px)`, `translate(${x}px, ${y}px)`, g);
          record(d.el, "transform", `translate(${x}px, ${y}px)`);
        }
        bump((n) => n + 1);
      }
      drag = null;
    }
    const kill = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
    };
    const key = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      // cmd+Z / cmd+shift+Z
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      // cmd+A: select everything LIKE the current selection (same tag +
      // classes), the useful reading of select-all on a page.
      if (mod && e.key.toLowerCase() === "a") {
        e.preventDefault();
        const cur = selRef.current[0];
        if (!cur) return;
        const likeSel = cur.className
          ? `${cur.tagName.toLowerCase()}.${String(cur.className).trim().split(/\s+/).slice(0, 3).join(".")}`
          : cur.tagName.toLowerCase();
        let matches: HTMLElement[] = [];
        try {
          matches = Array.from(doc.querySelectorAll(likeSel)) as HTMLElement[];
        } catch {
          matches = Array.from(doc.getElementsByTagName(cur.tagName)) as HTMLElement[];
        }
        clearPaint(selRef.current);
        const next = matches.slice(0, 60);
        setSels(next);
        paint(next);
        return;
      }
      if (e.key === "Escape") {
        clearPaint(selRef.current);
        setSels([]);
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selRef.current.length) {
        e.preventDefault();
        const gHide = ++gestureRef.current;
        for (const el of selRef.current) {
          pushUndo(el, "display", el.style.display || "", "none", gHide);
          el.style.display = "none";
          record(el, "display", "none");
        }
        bump((n) => n + 1);
        return;
      }
      // Arrow nudge: 1px, or 10px with shift (grid stays out of nudges, they
      // ARE the fine control).
      const arrows: Record<string, [number, number]> = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
      };
      if (arrows[e.key] && selRef.current.length) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const gN = ++gestureRef.current;
        for (const el of selRef.current) {
          const [x, y] = readOffset(el);
          const nx = x + arrows[e.key][0] * step;
          const ny = y + arrows[e.key][1] * step;
          pushUndo(el, "transform", `translate(${x}px, ${y}px)`, `translate(${nx}px, ${ny}px)`, gN);
          setOffset(el, nx, ny);
          record(el, "transform", `translate(${nx}px, ${ny}px)`);
        }
        bump((n) => n + 1);
      }
    };
    doc.addEventListener("mouseover", over, true);
    doc.addEventListener("mouseout", out, true);
    doc.addEventListener("mousedown", down, true);
    doc.addEventListener("mousemove", move, true);
    doc.addEventListener("mouseup", up, true);
    doc.addEventListener("click", kill, true);
    doc.addEventListener("submit", kill, true);
    const leave = (e: MouseEvent) => {
      if (marquee) finishMarquee(e);
      else if (drag) up(e);
    };
    doc.addEventListener("mouseleave", leave, true);
    doc.addEventListener("keydown", key, true);
    window.addEventListener("keydown", key, true);
    return () => {
      doc.removeEventListener("mouseover", over, true);
      doc.removeEventListener("mouseout", out, true);
      doc.removeEventListener("mousedown", down, true);
      doc.removeEventListener("mousemove", move, true);
      doc.removeEventListener("mouseup", up, true);
      doc.removeEventListener("click", kill, true);
      doc.removeEventListener("submit", kill, true);
      doc.removeEventListener("mouseleave", leave, true);
      doc.removeEventListener("keydown", key, true);
      window.removeEventListener("keydown", key, true);
      if (hovered) hovered.style.outline = "";
      clearGuides();
      clearPaint(selRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameRef, frameRef.current?.contentDocument]);

  const style = sel ? (frameRef.current?.contentWindow?.getComputedStyle(sel) as CSSStyleDeclaration | undefined) : undefined;
  // Continuous inputs (a color wheel, a slider) fire dozens of changes per
  // drag. Coalesce a run of edits to the same property on the same selection
  // into ONE undo step per element, updating its end value in place, so cmd+Z
  // jumps back to before the drag instead of replaying every hue.
  const liveEditRef = useRef<{ key: string; g: number } | null>(null);
  useEffect(() => {
    liveEditRef.current = null; // new selection = new gesture
  }, [sels]);
  const apply = (prop: string, value: string) => {
    const key = prop + "|" + sels.map((el) => cssPath(el)).join(",");
    const cont = liveEditRef.current?.key === key ? liveEditRef.current : null;
    if (cont) {
      for (const el of sels) {
        const step = undoRef.current.find(
          (u) => u.g === cont.g && u.el === el && u.prop === prop
        );
        if (step) step.next = value;
        applyRaw(el, prop, value);
      }
    } else {
      const g = ++gestureRef.current;
      for (const el of sels) {
        const prev = prop === "text" ? el.innerText : (el.style as any)[prop] || "";
        pushUndo(el, prop, prev, value, g);
        applyRaw(el, prop, value);
      }
      liveEditRef.current = { key, g };
    }
    bump((n) => n + 1);
  };
  // Canva-style arrange tools. "Center in page" moves the whole selection as
  // one unit so stacked pieces keep their relationship; the align buttons line
  // the selected items up against each other. Every arrange is one undo.
  const arrange = (kind: string) => {
    const doc = frameRef.current?.contentDocument;
    if (!doc || !sels.length) return;
    const readOffset = (el: HTMLElement): [number, number] => {
      const m = /translate\((-?\d+(?:\.\d+)?)px,\s*(-?\d+(?:\.\d+)?)px\)/.exec(el.style.transform || "");
      return m ? [parseFloat(m[1]), parseFloat(m[2])] : [0, 0];
    };
    const rects = sels.map((el) => ({ el, r: el.getBoundingClientRect(), o: readOffset(el) }));
    const union = {
      l: Math.min(...rects.map((x) => x.r.left)),
      r: Math.max(...rects.map((x) => x.r.right)),
      t: Math.min(...rects.map((x) => x.r.top)),
      b: Math.max(...rects.map((x) => x.r.bottom)),
    };
    const vw = doc.documentElement.clientWidth;
    const vh = doc.documentElement.clientHeight;
    const g = ++gestureRef.current;
    const moveBy = (x: { el: HTMLElement; o: [number, number] }, dx: number, dy: number) => {
      if (!dx && !dy) return;
      const nx = x.o[0] + dx;
      const ny = x.o[1] + dy;
      pushUndo(x.el, "transform", `translate(${x.o[0]}px, ${x.o[1]}px)`, `translate(${nx}px, ${ny}px)`, g);
      x.el.style.transform = `translate(${nx}px, ${ny}px)`;
      record(x.el, "transform", `translate(${nx}px, ${ny}px)`);
    };
    if (kind === "page-h") {
      const dx = vw / 2 - (union.l + union.r) / 2;
      for (const x of rects) moveBy(x, dx, 0);
    } else if (kind === "page-v") {
      const dy = vh / 2 - (union.t + union.b) / 2;
      for (const x of rects) moveBy(x, 0, dy);
    } else if (kind === "left") {
      for (const x of rects) moveBy(x, union.l - x.r.left, 0);
    } else if (kind === "center") {
      const cx = (union.l + union.r) / 2;
      for (const x of rects) moveBy(x, cx - (x.r.left + x.r.width / 2), 0);
    } else if (kind === "right") {
      for (const x of rects) moveBy(x, union.r - x.r.right, 0);
    } else if (kind === "top") {
      for (const x of rects) moveBy(x, 0, union.t - x.r.top);
    } else if (kind === "middle") {
      const cy = (union.t + union.b) / 2;
      for (const x of rects) moveBy(x, 0, cy - (x.r.top + x.r.height / 2));
    } else if (kind === "bottom") {
      for (const x of rects) moveBy(x, 0, union.b - x.r.bottom);
    }
    bump((n) => n + 1);
  };

  const toHex = (rgb: string): string => {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgb || "");
    if (!m) return "#000000";
    return (
      "#" + [m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, "0")).join("")
    );
  };

  return (
    <div className="flex w-[300px] shrink-0 flex-col overflow-y-auto border-l border-warm-border bg-surface p-4">
      {!sel ? (
        <p className="text-sm leading-relaxed text-body/70">
          Click selects, shift-click adds, shift-drag sweeps up everything the rectangle touches, drag moves
          (snapped to an 8px grid, toggleable). Cmd+Z undoes, cmd+shift+Z
          redoes, cmd+A selects everything like the selection, arrows nudge
          (shift for 10px), delete hides, esc deselects.
        </p>
      ) : (
        <>
          <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-body/60">
            Selected{sels.length > 1 ? ` (${sels.length})` : ""}
            <label className="ml-auto flex cursor-pointer items-center gap-1 font-semibold normal-case tracking-normal">
              <input
                type="checkbox"
                checked={snap}
                onChange={(e) => setSnap(e.target.checked)}
                className="h-3 w-3 accent-brown"
              />
              Snap to grid
            </label>
          </div>
          <div className="mt-1 truncate rounded-lg bg-warm-bg px-2.5 py-1.5 text-xs font-semibold text-ink">
            {(sel.innerText || sel.tagName).trim().slice(0, 46) || sel.tagName}
          </div>

          {sel.children.length === 0 && (
            <>
              <div className="mt-4 text-[11px] font-bold uppercase tracking-wider text-body/60">Text</div>
              <textarea
                defaultValue={sel.innerText}
                key={cssPath(sel)}
                onBlur={(e) => {
                  if (!sel || sels.length !== 1) return;
                  pushUndo(sel, "text", sel.innerText, e.target.value);
                  applyRaw(sel, "text", e.target.value);
                }}
                rows={3}
                className="mt-1 w-full resize-y rounded-lg border border-warm-border px-2.5 py-2 text-sm text-ink outline-none focus:border-brown"
              />
            </>
          )}

          <div className="mt-4">
            <div className="text-[11px] font-bold uppercase tracking-wider text-body/60">Arrange</div>
            <div className="mt-1.5 grid grid-cols-2 gap-1.5">
              <button onClick={() => arrange("page-h")} className="rounded-lg border border-warm-border px-2 py-1.5 text-[11px] font-semibold text-body transition hover:bg-warm-bg">
                Center in page
              </button>
              <button onClick={() => arrange("page-v")} className="rounded-lg border border-warm-border px-2 py-1.5 text-[11px] font-semibold text-body transition hover:bg-warm-bg">
                Middle of page
              </button>
            </div>
            {sels.length > 1 && (
              <div className="mt-1.5 grid grid-cols-3 gap-1.5">
                {(
                  [
                    ["left", "Left"],
                    ["center", "Center"],
                    ["right", "Right"],
                    ["top", "Top"],
                    ["middle", "Middle"],
                    ["bottom", "Bottom"],
                  ] as const
                ).map(([k, label]) => (
                  <button
                    key={k}
                    onClick={() => arrange(k)}
                    className="rounded-lg border border-warm-border px-2 py-1.5 text-[11px] font-semibold text-body transition hover:bg-warm-bg"
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {(
            [
              ["Text color", "color"],
              ["Background", "backgroundColor"],
            ] as const
          ).map(([label, prop]) => (
            <div key={prop} className="mt-4">
              <div className="text-[11px] font-bold uppercase tracking-wider text-body/60">{label}</div>
              <input
                type="color"
                value={toHex(style?.[prop as any] as string)}
                onChange={(e) => apply(prop, e.target.value)}
                className="mt-1 h-9 w-full cursor-pointer rounded-lg border border-warm-border bg-transparent"
              />
            </div>
          ))}

          <div className="mt-4">
            <div className="text-[11px] font-bold uppercase tracking-wider text-body/60">
              Font size: {parseInt(String(style?.fontSize || "16"), 10)}px
            </div>
            <input
              type="range"
              min={9}
              max={72}
              value={parseInt(String(style?.fontSize || "16"), 10)}
              onChange={(e) => apply("fontSize", `${e.target.value}px`)}
              className="mt-1 w-full accent-brown"
            />
          </div>
          <div className="mt-3">
            <div className="text-[11px] font-bold uppercase tracking-wider text-body/60">
              Corner radius: {parseInt(String(style?.borderRadius || "0"), 10)}px
            </div>
            <input
              type="range"
              min={0}
              max={40}
              value={parseInt(String(style?.borderRadius || "0"), 10)}
              onChange={(e) => apply("borderRadius", `${e.target.value}px`)}
              className="mt-1 w-full accent-brown"
            />
          </div>
          <button
            onClick={() => apply("display", "none")}
            className="mt-4 rounded-lg border border-warm-border px-3 py-1.5 text-xs font-semibold text-body transition hover:bg-danger/10 hover:text-danger"
          >
            Hide this element
          </button>
        </>
      )}

      <div className="mt-auto border-t border-warm-border pt-3">
        <div className="text-[11px] font-bold uppercase tracking-wider text-body/60">
          Changes ({changes.length})
        </div>
        <ul className="mt-1 max-h-32 space-y-1 overflow-y-auto text-[11px] text-body/70">
          {changes.slice(-8).map((c, i) => (
            <li key={i} className="truncate">
              {c.label || c.selector}: {c.prop}
            </li>
          ))}
        </ul>
        <div className="mt-2 flex gap-2">
          <button
            onClick={() => {
              const brief = [
                "Scout live-preview edits",
                ...changes.map((c) => `${c.selector}\n  ${c.prop}: ${c.value}`),
              ].join("\n");
              try {
                navigator.clipboard.writeText(brief);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              } catch {}
            }}
            disabled={!changes.length}
            className="rounded-lg bg-brand-gradient px-3 py-1.5 text-xs font-bold text-white transition hover:opacity-95 disabled:opacity-50"
          >
            {copied ? "Copied" : "Copy brief"}
          </button>
          <button
            onClick={() => {
              setChanges([]);
              setSels([]);
              undoRef.current = [];
              redoRef.current = [];
              frameRef.current?.contentWindow?.location.reload();
            }}
            className="rounded-lg border border-warm-border px-3 py-1.5 text-xs font-semibold text-body transition hover:bg-warm-bg"
          >
            Reset page
          </button>
        </div>
      </div>
    </div>
  );
}
