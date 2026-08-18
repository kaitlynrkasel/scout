// Server-only helpers for reading a web page down to plain text, plus following
// a couple of on-page links that look like application / apply / careers pages
// (where the real requirements usually live). Shared by deep-scan and the
// application drafter.

export function stripHtml(html: string): string {
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

// Reject internal/local addresses before fetching a user/model-supplied URL
// (SSRF guard). Blocks the loopback/private/link-local ranges in every dotted
// form, integer/hex-encoded IPs (http://2130706433 is 127.0.0.1), IPv6
// literals, and local-only hostnames. DNS names that RESOLVE to private IPs
// (rebinding) are out of scope for a static check; the deploy platform's
// network is the backstop there.
export function safeUrl(raw: string): URL | null {
  let s = String(raw || "").trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase();
  // IPv6 literals: no legitimate scouting target needs one; ::1 etc. hide here.
  if (host.startsWith("[")) return null;
  // Local-only names.
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".home.arpa")
  )
    return null;
  const quad = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (quad) {
    const o = quad.slice(1).map(Number);
    if (o.some((x) => x > 255)) return null;
    const [a, b] = o;
    if (a === 0 || a === 127 || a === 10) return null; // this-host / loopback / private A
    if (a === 172 && b >= 16 && b <= 31) return null; // private B
    if (a === 192 && b === 168) return null; // private C
    if (a === 169 && b === 254) return null; // link-local / cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return null; // CGNAT
    if (a >= 224) return null; // multicast + reserved
  } else if (/^(0x[0-9a-f]+|\d+)(\.(0x[0-9a-f]+|\d+)){0,3}$/.test(host)) {
    // Not a plain dotted quad but still parseable as an IP: decimal
    // (2130706433), hex (0x7f000001), octal (017700000001), or short dotted
    // (127.1) encodings, every label purely numeric/hex. Real domains always
    // have an alphabetic TLD label, so none are caught by this.
    return null;
  }
  return u;
}

async function fetchHtml(u: URL): Promise<string> {
  const r = await fetch(u.toString(), {
    headers: { "user-agent": "Mozilla/5.0 (compatible; ScoutBot/1.0)" },
    redirect: "follow",
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error(String(r.status));
  return r.text();
}

export async function readPage(u: URL): Promise<string> {
  try {
    return stripHtml(await fetchHtml(u)).slice(0, 9000);
  } catch {
    return "";
  }
}

// Read the main page plus up to `maxFollow` same-site links whose href/text hint
// at an application or requirements page. Returns the combined readable text and
// how many pages were read. Throws only if the main page can't be reached.
export async function gatherPages(
  u: URL,
  opts: { maxFollow?: number; want?: RegExp } = {}
): Promise<{ text: string; pages: number }> {
  const maxFollow = opts.maxFollow ?? 2;
  const want =
    opts.want ||
    /(apply|application|submit|how-to-apply|requirements|eligibility|internship|job|careers?|position|role|posting)/i;

  const mainHtml = await fetchHtml(u); // throws if unreachable
  const parts: string[] = [stripHtml(mainHtml).slice(0, 9000)];

  const linkRe = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const seen = new Set<string>([u.pathname.toLowerCase()]);
  const follow: URL[] = [];
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(mainHtml)) && follow.length < maxFollow) {
    const href = m[1];
    const label = stripHtml(m[2] || "");
    if (!want.test(href) && !want.test(label)) continue;
    let child: URL | null = null;
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
  for (const c of follow) {
    const t = await readPage(c);
    if (t) parts.push(`[from ${c.pathname}] ${t}`);
  }
  return { text: parts.join("\n\n").slice(0, 18000), pages: parts.length };
}
