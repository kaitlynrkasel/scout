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
  {
    key: "connect",
    name: "Connection",
    blurb: "The conversation itself: outreach out the door and replies coming back.",
  },
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
    connect: "#6f7a5b",
    shared: "#5c4634",
  },
};

/** The proposal: white ground, five accents, one per idea. */
export const SIX_ON_WHITE: Palette = {
  label: "Five on white",
  ground: "#ffffff",
  surface: "#ffffff",
  ink: "#10293a",
  ideas: {
    search: "#5e69ff", // cobalt
    person: "#4e9c9c", // aquamarine
    voice: "#aa2377", // hot pink
    connect: "#f87c47", // naranja — the conversation, out and back
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

  set("--c-success", p.ideas.connect);
  set("--c-success-deep", darken(p.ideas.connect));

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
export function applyPalette(
  p: Palette | null,
  whole: boolean,
  /** Where to paint. Defaults to this page; the lab passes its preview frame's
   *  document so the real site recolours without a reload. */
  target?: Document
): void {
  const doc = target ?? (typeof document === "undefined" ? null : document);
  if (!doc) return;
  const root = doc.documentElement;
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

/* ---- Palette generator --------------------------------------------------
 *
 * Building one of these by hand is deceptively hard. The Grove palette took
 * several passes because yellow and green sit next to each other on the wheel,
 * and two of the six landed close enough to read as the same colour at pill
 * size — which is fatal in a system where colour carries meaning.
 *
 * So the generator works in HSL and fixes the problem structurally: each idea
 * gets its own band of lightness. Even six colours cut from one narrow slice of
 * hue stay apart, because "a reply" is always the brightest thing on screen and
 * "shared" is always the darkest. Hue supplies the character; lightness does
 * the work of keeping them legible.
 */

export type Recipe = {
  /** Seed hue, 0–360. */
  hue: number;
  /** How far around the wheel the six spread. ~30 is one family, 180 is wide. */
  spread: number;
  /** 0–1, drives saturation. Low is dusty, high is vivid. */
  energy: number;
  /** Changes the arrangement without changing the character. */
  seed: number;
};

export const DEFAULT_RECIPE: Recipe = { hue: 96, spread: 70, energy: 0.72, seed: 1 };

/* Each idea's place in the value order — the whole trick. Fixed lightness bands
 * mean no two ideas can collapse into each other however close their hues are,
 * and the order carries meaning too: the payoff is the brightest thing on the
 * page, the institutional anchor the darkest. */
const VALUE_ORDER: IdeaKey[] = ["shared", "voice", "person", "search", "connect"];

/* Where each idea sits in the hue fan. Deliberately NOT the value order:
 * roles that are neighbours in lightness are pushed to opposite ends of the
 * hue spread, so the two forces that separate colours never line up and cancel.
 * Getting this wrong is what made the first version fail — person and voice
 * came out one step apart in both value and hue and measured 25 apart. */
const HUE_SLOT: Record<IdeaKey, number> = {
  shared: 0,
  voice: 3,
  person: 1,
  search: 4,
  connect: 2,
};

function hslToHex(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
    return Math.round(255 * c)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** Deterministic 0–1 from an integer, so a given seed always rebuilds the same. */
function rand(n: number): number {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/** Straight-line distance in RGB. Under ~60 and two colours start to merge. */
export function colourDistance(a: string, b: string): number {
  const x = toRgb(a);
  const y = toRgb(b);
  if (!x || !y) return 999;
  return Math.round(Math.sqrt(x.reduce((sum, v, i) => sum + (v - y[i]) ** 2, 0)));
}

export type Score = {
  /** The two closest colours in the set, and how far apart they are. */
  closest: number;
  closestPair: [IdeaKey, IdeaKey];
  /** How many clear 4.5:1 on white, i.e. can carry small text. */
  inkSafe: number;
  /** Every pair far enough apart, and at least two usable as ink. */
  ok: boolean;
};

export function scorePalette(p: Palette): Score {
  const keys = IDEAS.map((i) => i.key);
  let closest = 999;
  let closestPair: [IdeaKey, IdeaKey] = [keys[0], keys[1]];
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const d = colourDistance(p.ideas[keys[i]], p.ideas[keys[j]]);
      if (d < closest) {
        closest = d;
        closestPair = [keys[i], keys[j]];
      }
    }
  }
  const inkSafe = keys.filter((k) => contrastOnWhite(p.ideas[k]) >= 4.5).length;
  return { closest, closestPair, inkSafe, ok: closest >= 60 && inkSafe >= 2 };
}

/**
 * Build a palette from a recipe. Anything in `locked` is kept exactly as given,
 * so a colour worth keeping survives a reshuffle.
 *
 * The value ladder starts tight and is widened until every pair is far enough
 * apart to tell apart. Six colours cut from a narrow hue slice genuinely may
 * not fit — when that happens the palette comes back scoring `ok: false` rather
 * than pretending, and the lab tells you to widen the spread.
 */
export function generatePalette(
  r: Recipe,
  locked: Partial<Record<IdeaKey, string>> = {}
): Palette {
  const build = (gap: number): Palette => {
    const ideas = {} as Record<IdeaKey, string>;
    VALUE_ORDER.forEach((key, rank) => {
      if (locked[key] && isHex(locked[key]!)) {
        ideas[key] = locked[key]!;
        return;
      }
      const slot = HUE_SLOT[key];
      const step = slot / (VALUE_ORDER.length - 1) - 0.5;
      const jitter = (rand(r.seed * 31 + slot) - 0.5) * (r.spread / 10);
      const hue = (r.hue + step * r.spread + jitter + 360) % 360;

      // Uneven rungs on purpose: at the dark end a given step in lightness
      // moves the colour far less in RGB than the same step does up in the
      // highlights, so the bottom of the ladder gets more room.
      const RUNG = [0, 1.5, 2.9, 4.2, 5.5];
      const l = 0.14 + RUNG[rank] * gap;
      // Dark colours need more saturation to stay coloured rather than muddy;
      // light ones need less or they glow.
      const satBase = 0.34 + r.energy * 0.5;
      const sat = Math.max(0.18, Math.min(0.95, satBase + (0.5 - l) * 0.35));
      ideas[key] = hslToHex(hue, sat, l);
    });
    // A palette needs at least two colours that can carry small text. Yellows
    // stay luminous even at a low lightness, so the two darkest roles get
    // pushed down until they actually clear 4.5:1 rather than merely looking
    // dark on the swatch.
    for (const key of ["shared", "voice"] as IdeaKey[]) {
      if (locked[key]) continue;
      let guard = 0;
      while (contrastOnWhite(ideas[key]) < 4.5 && guard++ < 8) {
        ideas[key] = darken(ideas[key], 0.12);
      }
    }
    const ground = hslToHex(r.hue, Math.min(0.5, r.energy * 0.5), 0.985);
    const ink = hslToHex(r.hue, 0.3, 0.12);
    return { label: "Custom", ground, surface: "#ffffff", ink, ideas };
  };

  let best = build(0.115);
  let bestScore = scorePalette(best);
  // Widen the ladder a step at a time and keep the first arrangement that
  // clears the bar; failing that, keep whichever got furthest.
  for (let gap = 0.12; gap <= 0.145; gap += 0.005) {
    if (bestScore.ok) break;
    const cand = build(gap);
    const score = scorePalette(cand);
    if (score.closest > bestScore.closest || (score.ok && !bestScore.ok)) {
      best = cand;
      bestScore = score;
    }
  }
  return best;
}

/* ---- Saved palettes ----------------------------------------------------- */

const SAVED_KEY = "scout_design_saved";

export function loadPalettes(): Palette[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = JSON.parse(localStorage.getItem(SAVED_KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (p: any) =>
        p && typeof p.label === "string" && isHex(p.ground) && isHex(p.ink) &&
        IDEAS.every(({ key }) => isHex(p.ideas?.[key]))
    );
  } catch {
    return [];
  }
}

export function savePalettes(list: Palette[]): void {
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify(list.slice(0, 24)));
  } catch {
    /* storage blocked — saved palettes just won't survive a reload */
  }
}
