import { NextRequest, NextResponse } from "next/server";
import { safeUrl } from "@/lib/pageText";

export const runtime = "nodejs";
export const maxDuration = 20;

// Serves a site's HTML back through OUR origin so the find-detail preview
// iframe can embed it. Embedding the target URL directly gets blocked by
// X-Frame-Options / CSP frame-ancestors on most real sites ("refused to
// connect") — that's the browser enforcing headers on the direct cross-origin
// request. Proxying means the browser only ever requests OUR route, which sets
// no such headers, so the iframe loads. A <base> tag keeps every relative
// link/asset resolving against the real site. This is a single-request,
// uncached pass-through for in-app preview, not a cache or republish of the
// page.
export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("url") || "";
  const u = safeUrl(raw);
  if (!u) {
    return htmlResponse(errorPage("That link isn't a valid, reachable web address."));
  }

  let html: string;
  try {
    const r = await fetch(u.toString(), {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) {
      return htmlResponse(
        errorPage(`This site returned an error (${r.status}) when Scout tried to preview it.`, u.toString())
      );
    }
    const ct = r.headers.get("content-type") || "";
    if (!ct.includes("html")) {
      return htmlResponse(errorPage("That link isn't a webpage Scout can preview.", u.toString()));
    }
    html = await r.text();
  } catch {
    return htmlResponse(
      errorPage("Scout couldn't reach this site to preview it.", u.toString())
    );
  }

  // Cap payload size — this is a visual preview, not a full mirror.
  if (html.length > 2_000_000) html = html.slice(0, 2_000_000);

  // Neutralize any framing directives the page sets itself via <meta> tags
  // (belt-and-suspenders; the real blockers are the HTTP response headers,
  // which we never forward since our own response sets none of them).
  html = html.replace(
    /<meta[^>]+http-equiv=["']?(x-frame-options|content-security-policy)["']?[^>]*>/gi,
    ""
  );

  // Inject a <base> so every relative href/src (css, js, images, links)
  // resolves against the real site instead of our proxy route. Must be the
  // very first thing in <head> to take effect for everything after it.
  const base = `<base href="${u.origin}${u.pathname.replace(/[^/]*$/, "")}">`;
  html = /<head[^>]*>/i.test(html)
    ? html.replace(/<head[^>]*>/i, (m) => `${m}${base}`)
    : `${base}${html}`;

  return htmlResponse(html);
}

function htmlResponse(html: string): NextResponse {
  return new NextResponse(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function errorPage(message: string, realUrl?: string): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8"><style>` +
    `body{margin:0;display:flex;align-items:center;justify-content:center;height:100vh;` +
    `font-family:-apple-system,system-ui,sans-serif;background:#f4f2ee;color:#57534c;text-align:center;padding:24px}` +
    `p{max-width:340px;line-height:1.5;font-size:14px}a{color:#7c5837}</style></head><body>` +
    `<p>${message}${realUrl ? ` <br><a href="${realUrl}" target="_blank" rel="noreferrer">Open it directly ↗</a>` : ""}</p>` +
    `</body></html>`
  );
}
