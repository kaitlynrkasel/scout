/* Design lab — a per-device palette preview.
 *
 * Scout's colours are CSS variables on :root, so trying a whole new palette is
 * a matter of writing different values onto the document rather than editing
 * files and redeploying. That's what this does: the /admin Design tab writes a
 * palette here, and every page applies it on load.
 *
 * It is deliberately local-only. The palette lives in this browser's
 * localStorage, never on the server, so nothing an owner tries out is visible
 * to a single real user until it's committed to globals.css for real.
 */

export const DESIGN_KEY = "scout_design_lab";

/** The six ideas colour attaches to, in the order they're shown. */
export const IDEAS = [
  { key: "search", name: "Searching", blurb: "Running a search, the goal field, category presets." },
  { key: "person", name: "A person", blurb: "Every human Scout surfaces. Find cards, contacts, counts." },
  { key: "voice", name: "Your voice", blurb: "Drafts, templates, tone — your writing, not Scout's finding." },
  { key: "sent", name: "Sent", blurb: "Outreach that has left. Sent, scheduled, follow-ups queued." },
  { key: "reply", name: "A reply", blurb: "Someone wrote back. The only colour that means good news." },
  { key: "shared", name: "Shared", blurb: "Belongs to the company, not to you. Teammates, shared projects." },
] as const;

export type IdeaKey = (typeof IDEAS)[number]["key"];

export type Palette = {
  /** Human name, shown on the preset buttons. */
  label: string;
  ground: string; // page canvas
  surface: string; // cards
  ink: string; // headings and body text
  ideas: Record<IdeaKey, string>;
};

/** Scout as it ships today — the warm brown system, mapped onto the six ideas. */
export const SCOUT_TODAY: Palette = {
  label: "Scout today",
  ground: "#f8f7f5",
  surface: "#ffffff",
  ink: "#38322b",
  ideas: {
    search: "#7a6048",
    person: "#7a6048",
    voice: "#7a6048",
    sent: "#7a6048",
    reply: "#6f7a5b",
    shared: "#5c4634",
  },
};

/** The proposal: white ground, six accents, one per idea. */
export const SIX_ON_WHITE: Palette = {
  label: "Six on white",
  ground: "#ffffff",
  surface: "#ffffff",
  ink: "#10293a",
  ideas: {
    search: "#5e69ff", // cobalt
    person: "#4e9c9c", // aquamarine
    voice: "#aa2377", // hot pink
    sent: "#f87c47", // naranja
    reply: "#ffd747", // daffodil
    shared: "#19455e", // denim
  },
};

export const PRESETS: Palette[] = [SCOUT_TODAY, SIX_ON_WHITE];

/* ---- colour maths ------------------------------------------------------ */

const HEX = /^#?([0-9a-f]{6})$/i;

export function isHex(v: string): boolean {
  return HEX.test(String(v || "").trim());
}

/** "#5e69ff" → [94, 105, 255]. Returns null on anything unparseable. */
export function toRgb(hex: string): [number, number, number] | null {
  const m = HEX.exec(String(hex || "").trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Scout's variables hold "r g b" so Tailwind can do rgb(var(--x) / alpha). */
export function toTriplet(hex: string): string | null {
  const rgb = toRgb(hex);
  return rgb ? rgb.join(" ") : null;
}

function mix(hex: string, towards: [number, number, number], amount: number): string {
  const rgb = toRgb(hex);
  if (!rgb) return hex;
  const out = rgb.map((c, i) => Math.round(c + (towards[i] - c) * amount));
  return `#${out.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

export const darken = (hex: string, amount = 0.28) => mix(hex, [0, 0, 0], amount);
export const lighten = (hex: string, amount = 0.86) => mix(hex, [255, 255, 255], amount);

/** Relative luminance, for deciding whether text on a colour should be light. */
export function luminance(hex: string): number {
  const rgb = toRgb(hex);
  if (!rgb) return 1;
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Contrast ratio against white — the number that decides fill vs. ink. */
export function contrastOnWhite(hex: string): number {
  const l = luminance(hex);
  return Math.round(((1.05) / (l + 0.05)) * 10) / 10;
}

/** Legible text colour to sit on top of a given fill. */
export function textOn(hex: string): string {
  return luminance(hex) > 0.45 ? "#1a1a1a" : "#ffffff";
}

/* ---- applying it to the document --------------------------------------- */

/** Variables the whole app already reads. Setting these repaints every screen. */
function groundVars(p: Palette): Record<string, string> {
  const accent = p.ideas.search;
  const vars: Record<string, string> = {};
  const set = (name: string, hex: string) => {
    const t = toTriplet(hex);
    if (t) vars[name] = t;
  };

  set("--c-cream", p.ground);
  set("--c-surface", p.surface);
  set("--c-surface-2", mix(p.ground, [0, 0, 0], 0.04));
  set("--c-warm-bg", mix(p.ground, [0, 0, 0], 0.05));
  set("--c-warm-border", mix(p.ink, [255, 255, 255], 0.86));
  set("--c-ink", p.ink);
  set("--c-body", mix(p.ink, [255, 255, 255], 0.28));
  set("--c-muted", mix(p.ink, [255, 255, 255], 0.48));

  // Every accent alias in the app points at one primary today, so the "search"
  // colour stands in for it until components are wired to the six ideas.
  for (const name of ["--c-brown", "--c-blue", "--c-slate", "--c-sage"]) set(name, accent);
  for (const name of ["--c-brown-deep", "--c-blue-deep", "--c-sage-deep"]) {
    set(name, darken(accent));
  }
  for (const name of ["--c-brown-tint", "--c-blue-tint"]) set(name, lighten(accent));

  set("--c-success", p.ideas.reply);
  set("--c-success-deep", darken(p.ideas.reply));

  return vars;
}

/** The six ideas, exposed for components that get wired to them. */
function ideaVars(p: Palette): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const { key } of IDEAS) {
    const hex = p.ideas[key];
    const t = toTriplet(hex);
    const d = toTriplet(darken(hex));
    const l = toTriplet(lighten(hex));
    if (t) vars[`--idea-${key}`] = t;
    if (d) vars[`--idea-${key}-deep`] = d;
    if (l) vars[`--idea-${key}-tint`] = l;
  }
  return vars;
}

/**
 * Paint a palette onto the document. `whole` false applies only the six idea
 * variables (harmless — nothing reads them yet), so the lab's own preview can
 * use them without recolouring the admin page around it.
 */
export function applyPalette(p: Palette | null, whole: boolean): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const all = { ...groundVars(SCOUT_TODAY), ...ideaVars(SCOUT_TODAY) };
  // Clear anything a previous palette set, so switching never leaves a stray
  // variable behind from the palette before it.
  for (const name of Object.keys(all)) root.style.removeProperty(name);
  if (!p) return;
  const vars = whole ? { ...groundVars(p), ...ideaVars(p) } : ideaVars(p);
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
}

/* ---- storage ------------------------------------------------------------ */

export type Saved = { palette: Palette; whole: boolean };

export function loadSaved(): Saved | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(DESIGN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const p = parsed?.palette;
    if (!p || !isHex(p.ground) || !isHex(p.surface) || !isHex(p.ink)) return null;
    for (const { key } of IDEAS) if (!isHex(p.ideas?.[key])) return null;
    return { palette: p as Palette, whole: !!parsed.whole };
  } catch {
    return null;
  }
}

export function saveSaved(s: Saved | null): void {
  try {
    if (s) localStorage.setItem(DESIGN_KEY, JSON.stringify(s));
    else localStorage.removeItem(DESIGN_KEY);
  } catch {
    /* storage blocked — the palette just won't survive a reload */
  }
}

/** The CSS to paste into globals.css once a palette is worth keeping. */
export function toCss(p: Palette): string {
  const lines = [
    `/* ${p.label} — from the /admin design lab */`,
    ":root {",
    `  --c-cream: ${toTriplet(p.ground)}; /* page canvas */`,
    `  --c-surface: ${toTriplet(p.surface)}; /* cards */`,
    `  --c-ink: ${toTriplet(p.ink)}; /* headings + body */`,
    "",
  ];
  for (const { key, name } of IDEAS) {
    const hex = p.ideas[key];
    lines.push(`  --idea-${key}: ${toTriplet(hex)}; /* ${name} — ${hex} */`);
    lines.push(`  --idea-${key}-deep: ${toTriplet(darken(hex))};`);
    lines.push(`  --idea-${key}-tint: ${toTriplet(lighten(hex))};`);
  }
  lines.push("}");
  return lines.join("\n");
}
