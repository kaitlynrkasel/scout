import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 15;

// What a find's tile looks like: a colour from OUR palette, and whether the
// site has a real logo to draw on it.
//
// Screenshots of other people's homepages make poor thumbnails: mostly
// whitespace, cropped at an arbitrary scroll point, and forty of them read as
// noise. A flat block of colour does the same job of "this is them" and lets
// the grid stay calm.
//
// The site's own colour is a VOTE, never the answer. Used raw it produced a
// pure #0000FF card sitting beside a warm brown one and the grid stopped
// reading as one product, so every colour is snapped to the nearest entry in
// Scout's palette below.

const cache = new Map<string, { color: string; on: string; logo: boolean; at: number }>();
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Scout's tile palette, from Kaitlyn's swatch: confident, warm, never neon.
// Each entry carries the ink to draw its artwork in, because the two pale ones
// (sky, yellow) cannot hold white and take the deep navy instead.
const PALETTE: { hex: string; on: string }[] = [
  { hex: "#377ec0", on: "#ffffff" }, // blue
  { hex: "#5460ac", on: "#ffffff" }, // indigo
  { hex: "#7a5aa8", on: "#ffffff" }, // purple
  { hex: "#12baaa", on: "#ffffff" }, // teal
  { hex: "#9fd2d6", on: "#2f4356" }, // sky
  { hex: "#fbdf54", on: "#2f4356" }, // yellow
  { hex: "#f7891f", on: "#ffffff" }, // orange
  { hex: "#f04f52", on: "#ffffff" }, // red
];

function hostOf(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

// Weighted euclidean distance, the standard cheap approximation of how far
// apart two colours LOOK rather than how far apart their numbers are. Plain RGB
// distance puts a saturated blue nearer to black than to our denim.
function nearestInPalette(hex: string): { hex: string; on: string } | null {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const [r1, g1, b1] = rgb;
  let best: { hex: string; on: string } | null = null;
  let bestD = Infinity;
  for (const cand of PALETTE) {
    const c = hexToRgb(cand.hex)!;
    const rm = (r1 + c[0]) / 2;
    const dr = r1 - c[0];
    const dg = g1 - c[1];
    const db = b1 - c[2];
    const d =
      (2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db;
    if (d < bestD) {
      bestD = d;
      best = cand;
    }
  }
  return best;
}

function fallbackFor(host: string): { hex: string; on: string } {
  let h = 0;
  for (let i = 0; i < host.length; i++) h = (h * 31 + host.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

// The direct endpoint, NOT /s2/favicons: that one answers with a 301, and a CSS
// mask renders nothing at all when its image is a redirect. That is why every
// tile came back as an empty block of colour.
function faviconUrl(host: string): string {
  return `https://t1.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&size=128&url=${encodeURIComponent(
    `https://${host}`
  )}`;
}

// Google serves a generic globe for a site with no favicon, and returns it with
// a 404 status even though the body is a valid image, so the browser's own
// onError never fires and every logo-less site would show the same globe. Ask
// here instead, and only claim a logo on a clean 200.
async function hasFavicon(host: string): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(faviconUrl(host), { signal: ctrl.signal });
    clearTimeout(t);
    return r.status === 200;
  } catch {
    return false;
  }
}

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url") || "";
  const host = hostOf(url);
  if (!host)
    return NextResponse.json({ color: PALETTE[0].hex, on: PALETTE[0].on, logo: false });

  const hit = cache.get(host);
  if (hit && Date.now() - hit.at < TTL_MS) {
    return NextResponse.json({ color: hit.color, on: hit.on, logo: hit.logo, cached: true });
  }

  let color: { hex: string; on: string } | null = null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(`https://${host}/`, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "user-agent": "Mozilla/5.0 (compatible; ScoutBot/1.0)" },
    });
    clearTimeout(t);
    const html = (await res.text()).slice(0, 200000);
    const candidates: string[] = [];
    const theme = html.match(
      /<meta[^>]+name=["']theme-color["'][^>]+content=["']([^"']+)["']/i
    );
    if (theme) candidates.push(theme[1]);
    const themeRev = html.match(
      /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']theme-color["']/i
    );
    if (themeRev) candidates.push(themeRev[1]);
    // A brand's own CSS variables are the next most deliberate statement of
    // "this is our colour".
    for (const m of html.matchAll(
      /--(?:brand|primary|accent|main|theme)[a-z-]*\s*:\s*(#[0-9a-f]{3,6})/gi
    )) {
      candidates.push(m[1]);
    }
    for (const c of candidates) {
      const snapped = nearestInPalette(c);
      if (snapped) {
        color = snapped;
        break;
      }
    }
  } catch {
    /* unreachable, slow, or bot-blocked: the hostname colour still looks right */
  }

  const final = color || fallbackFor(host);
  const logo = await hasFavicon(host);
  cache.set(host, { color: final.hex, on: final.on, logo, at: Date.now() });
  return NextResponse.json({ color: final.hex, on: final.on, logo });
}
