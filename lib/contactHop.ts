// One-hop contact scan. Search engines rank a site's homepage, but the way to
// actually reach someone (the submit form, the booking email, the contact
// page) usually lives one click deeper. For a find with no contact route,
// read its page, follow up to two same-site links that look like
// contact/submit/booking pages, and pull emails (mailto included, which a
// text-only read loses) and social handles straight from the HTML. No model
// call: pure fetch + parse, so it is cheap enough to run on every strong find.

import { safeUrl } from "./pageText";

const UA = "Mozilla/5.0 (compatible; ScoutBot/1.0)";
const WANT = /(contact|submit|submission|booking|book-?us|press|pitch|demo|reach|get-in-touch|about)/i;
const JUNK_EMAIL =
  /(noreply|no-reply|donotreply|example\.|sentry|wixpress|\.png|\.jpg|\.gif|\.webp|@2x|privacy@|abuse@|postmaster@)/i;

async function fetchHtml(u: URL, ms = 8000): Promise<string> {
  try {
    const r = await fetch(u.toString(), {
      headers: { "user-agent": UA, accept: "text/html" },
      redirect: "follow",
      signal: AbortSignal.timeout(ms),
    });
    if (!r.ok) return "";
    const ct = r.headers.get("content-type") || "";
    if (ct && !/html|xml|text/i.test(ct)) return "";
    return (await r.text()).slice(0, 400000);
  } catch {
    return "";
  }
}

function emailsIn(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/mailto:([^"'?\s>]+)/gi)) out.add(decodeURIComponent(m[1]).toLowerCase());
  for (const m of html.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) out.add(m[0].toLowerCase());
  return [...out].filter((e) => !JUNK_EMAIL.test(e) && e.length < 80);
}

function handleIn(html: string): string {
  const m = /https?:\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9._]{2,30})\/?["'?#]/i.exec(html);
  const h = m?.[1] || "";
  return h && !/^(p|reel|explore|accounts|stories|tv)$/i.test(h) ? `@${h}` : "";
}

export interface HopContact {
  email?: string;
  handle?: string;
  page?: string; // where it was found
}

export async function contactHop(pageUrl: string): Promise<HopContact | null> {
  const u = safeUrl(pageUrl);
  if (!u) return null;
  const home = await fetchHtml(u);
  if (!home) return null;

  const pages: { url: string; html: string }[] = [{ url: u.toString(), html: home }];
  const seen = new Set<string>([u.pathname.toLowerCase()]);
  const follow: URL[] = [];
  for (const m of home.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    if (follow.length >= 2) break;
    const href = m[1];
    const label = (m[2] || "").replace(/<[^>]+>/g, " ");
    if (!WANT.test(href) && !WANT.test(label)) continue;
    let child: URL;
    try {
      child = new URL(href, u.toString());
    } catch {
      continue;
    }
    if (child.hostname !== u.hostname) continue;
    const key = child.pathname.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (safeUrl(child.toString())) follow.push(child);
  }
  const children = await Promise.all(follow.map((c) => fetchHtml(c, 6000)));
  children.forEach((html, i) => html && pages.push({ url: follow[i].toString(), html }));

  // Prefer an address on the site's own domain; a contact page beats the
  // homepage when both have one.
  const siteHost = u.hostname.replace(/^www\./, "");
  let best: HopContact | null = null;
  for (const p of [...pages].reverse()) {
    const emails = emailsIn(p.html);
    const own = emails.find((e) => e.endsWith(`@${siteHost}`)) || emails[0];
    const handle = handleIn(p.html);
    if (own) return { email: own, handle: handle || undefined, page: p.url };
    if (handle && !best) best = { handle, page: p.url };
  }
  return best;
}
