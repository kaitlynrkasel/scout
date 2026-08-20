import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 15;

// The dominant brand color of a site, for the tile that stands in for it in the
// grid. Screenshots of other people's homepages make a poor thumbnail: mostly
// whitespace, cropped at an arbitrary point, and a wall of them reads as noise.
// A flat block of the site's own color does the same job of "this is them" and
// lets the grid stay calm.
//
// Read from what the site declares about itself, in descending order of intent,
// and fall back to a stable color derived from the hostname so every find gets
// one instantly and the same site always looks the same.

const cache = new Map<string, { color: string; at: number }>();
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Deep, saturated tones that carry white artwork. Deliberately not random: the
// hostname picks one, so a site with nothing declared still looks considered
// and never changes between visits.
const FALLBACK = [
  "#3d5a6c", "#6b4a6f", "#2f5d70", "#7a4a3c", "#4a5d3f", "#5a4a7a",
  "#7a6048", "#365a52", "#6d3f52", "#44506b", "#7a5230", "#3f5f4a",
];

function hostOf(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function fallbackFor(host: string): string {
  let h = 0;
  for (let i = 0; i < host.length; i++) h = (h * 31 + host.charCodeAt(i)) >>> 0;
  return FALLBACK[h % FALLBACK.length];
}

// Only accept a color that can carry white artwork. A site whose declared theme
// color is near-white would give us an invisible tile, and pure black reads as
// a hole punched in the grid.
function usable(hex: string): string {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "";
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  if (lum > 0.62 || lum < 0.04) return "";
  return `#${h.toLowerCase()}`;
}

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url") || "";
  const host = hostOf(url);
  if (!host) return NextResponse.json({ color: FALLBACK[0] });

  const hit = cache.get(host);
  if (hit && Date.now() - hit.at < TTL_MS) {
    return NextResponse.json({ color: hit.color, cached: true });
  }

  let color = "";
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
    // "this is our color".
    for (const m of html.matchAll(
      /--(?:brand|primary|accent|main|theme)[a-z-]*\s*:\s*(#[0-9a-f]{3,6})/gi
    )) {
      candidates.push(m[1]);
    }
    for (const c of candidates) {
      const ok = usable(c);
      if (ok) {
        color = ok;
        break;
      }
    }
  } catch {
    /* unreachable, slow, or bot-blocked: the fallback still looks right */
  }

  const final = color || fallbackFor(host);
  cache.set(host, { color: final, at: Date.now() });
  return NextResponse.json({ color: final });
}
