// Shared "read this company's web presence" helper for the autofill flows
// (/api/read-website and /api/read-company). Plain fetch works for real
// websites — but plenty of small businesses only have an Instagram / TikTok /
// Facebook / LinkedIn, and those serve bots a login wall or an empty JS shell.
// For social links (or any page that comes back effectively empty) we fall
// back to a web SEARCH about the handle/company and read what the public web
// says about them instead.

import { tavilySearch } from "./tavily";

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

const SOCIAL_HOSTS: Record<string, string> = {
  "instagram.com": "Instagram",
  "facebook.com": "Facebook",
  "tiktok.com": "TikTok",
  "twitter.com": "X (Twitter)",
  "x.com": "X (Twitter)",
  "linkedin.com": "LinkedIn",
  "youtube.com": "YouTube",
  "threads.net": "Threads",
};

function socialPlatform(hostname: string): string | null {
  const h = hostname.replace(/^www\./i, "").toLowerCase();
  for (const key of Object.keys(SOCIAL_HOSTS)) {
    if (h === key || h.endsWith("." + key)) return SOCIAL_HOSTS[key];
  }
  return null;
}

// Pull a searchable name out of a social URL's path: the @handle or slug
// (instagram.com/cedarco → "cedarco"; linkedin.com/company/cedar-co → "cedar co").
function handleFromPath(u: URL): string {
  const parts = u.pathname.split("/").filter(Boolean);
  const skip = new Set(["company", "in", "pages", "channel", "user", "profile"]);
  const seg = parts.find((p) => !skip.has(p.toLowerCase())) || parts[0] || "";
  return decodeURIComponent(seg).replace(/^@/, "").replace(/[-_.]+/g, " ").trim();
}

export interface SiteRead {
  url: string;
  title: string;
  text: string;
  viaSearch: boolean; // true when we read the public web ABOUT them, not their page
}

export class ReadSiteError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

async function searchAbout(name: string, platform: string | null): Promise<SiteRead | null> {
  if (!name) return null;
  try {
    const q = platform ? `${name} ${platform} about the company` : `${name} company about`;
    const results = await tavilySearch(q, 6);
    const text = results
      .map((r) => `${r.title || ""}. ${String(r.content || "")}`)
      .join("\n")
      .slice(0, 8000);
    if (text.trim().length < 120) return null;
    return { url: "", title: name, text, viaSearch: true };
  } catch {
    return null;
  }
}

export async function readSite(rawUrl: string): Promise<SiteRead> {
  let raw = String(rawUrl || "").trim();
  if (!raw) throw new ReadSiteError("Enter your website or a social link.");
  if (!/^https?:\/\//i.test(raw)) raw = "https://" + raw;

  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ReadSiteError("That doesn't look like a valid link.");
  }
  if (
    !/^https?:$/.test(u.protocol) ||
    /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|\[)/i.test(u.hostname)
  ) {
    throw new ReadSiteError("That address isn't allowed.");
  }

  const platform = socialPlatform(u.hostname);

  // Social profiles: don't even try the direct fetch (login walls) — search the
  // public web about the handle instead.
  if (platform) {
    const viaSearch = await searchAbout(handleFromPath(u), platform);
    if (viaSearch) return { ...viaSearch, url: u.toString() };
    throw new ReadSiteError(
      `Couldn't find public info for that ${platform} page. Try your handle spelled differently, or fill the fields in yourself.`
    );
  }

  // Regular websites: direct fetch, with the search fallback when the page is
  // unreachable or effectively empty (JS-only shells).
  let title = "";
  let text = "";
  try {
    const r = await fetch(u.toString(), {
      headers: { "user-agent": "Mozilla/5.0 (compatible; ScoutBot/1.0)" },
      redirect: "follow",
    });
    if (r.ok) {
      const html = await r.text();
      const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      title = titleMatch ? stripHtml(titleMatch[1]) : "";
      text = stripHtml(html).slice(0, 8000);
    }
  } catch {
    /* fall through to search */
  }
  if (text.length >= 300) return { url: u.toString(), title, text, viaSearch: false };

  const fallbackName =
    title || u.hostname.replace(/^www\./i, "").split(".")[0].replace(/[-_.]+/g, " ");
  const viaSearch = await searchAbout(fallbackName, null);
  if (viaSearch) return { ...viaSearch, url: u.toString(), title: title || viaSearch.title };
  if (text.trim())
    return { url: u.toString(), title, text, viaSearch: false }; // thin but real
  throw new ReadSiteError("Couldn't read that site. Paste your info in manually instead.");
}
