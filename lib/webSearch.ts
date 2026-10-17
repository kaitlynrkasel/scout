// Multi-provider retrieval. Tavily stays the primary net; when a query comes
// back thin, Exa and Brave (whichever keys are set) cast second nets and the
// merged pool is deduped by canonical URL. Providers are strictly additive:
// with no extra keys configured this behaves exactly like tavilySearch.

import { tavilySearch, type TavilyResult, type TavilyOpts } from "./tavily";

const THIN = 3; // fewer surviving results than this = run the fallback nets

function host(u: string): string {
  const m = /^https?:\/\/([^\/?#]+)/i.exec(u || "");
  return (m?.[1] || "").toLowerCase().replace(/^www\./, "");
}
function dedupeKey(u: string): string {
  try {
    const url = new URL(u);
    return (url.host.replace(/^www\./, "") + url.pathname).toLowerCase().replace(/\/+$/, "");
  } catch {
    return (u || "").toLowerCase();
  }
}

async function exaSearch(query: string, maxResults: number): Promise<TavilyResult[]> {
  const key = process.env.EXA_API_KEY;
  if (!key) return [];
  try {
    const res = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key },
      body: JSON.stringify({
        // Per Exa's build-with-exa skill: the recommended request is query +
        // token-efficient highlights, nothing else; numResults is a
        // deliberate cap here, not boilerplate.
        query,
        numResults: Math.min(10, maxResults),
        type: "auto",
        contents: { highlights: true },
      }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return ((data?.results || []) as any[]).map((r) => ({
      title: String(r.title || ""),
      url: String(r.url || ""),
      content: Array.isArray(r.highlights) ? r.highlights.join(" ") : String(r.text || ""),
    }));
  } catch {
    return [];
  }
}

// "More like this find you kept": taste data turned into retrieval. Exa's
// /findSimilar is deprecated per its docs, so this derives a /search query
// from the seed's title and excludes the seed's own domain (an intentional
// blocklist of one, so the lookalikes are NEW places).
export async function exaFindSimilar(
  seedTitle: string,
  seedUrl: string,
  maxResults = 6
): Promise<TavilyResult[]> {
  const key = process.env.EXA_API_KEY;
  const title = (seedTitle || "").trim();
  if (!key || !title) return [];
  let hostX = "";
  try {
    hostX = new URL(seedUrl || "").hostname.replace(/^www\./, "");
  } catch {}
  try {
    const res = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key },
      body: JSON.stringify({
        query: `pages similar to: ${title}`,
        numResults: Math.min(10, maxResults),
        type: "auto",
        contents: { highlights: true },
        ...(hostX ? { excludeDomains: [hostX] } : {}),
      }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return ((data?.results || []) as any[]).map((r) => ({
      title: String(r.title || ""),
      url: String(r.url || ""),
      content: Array.isArray(r.highlights) ? r.highlights.join(" ") : "",
    }));
  } catch {
    return [];
  }
}

async function braveSearch(query: string, maxResults: number): Promise<TavilyResult[]> {
  const key = process.env.BRAVE_SEARCH_API_KEY;
  if (!key) return [];
  try {
    const res = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(
        10,
        maxResults
      )}`,
      { headers: { Accept: "application/json", "X-Subscription-Token": key } }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return ((data?.web?.results || []) as any[]).map((r) => ({
      title: String(r.title || ""),
      url: String(r.url || ""),
      content: String(r.description || ""),
    }));
  } catch {
    return [];
  }
}

export function fallbackProvidersConfigured(): boolean {
  return !!(process.env.EXA_API_KEY || process.env.BRAVE_SEARCH_API_KEY);
}

/** Drop-in replacement for tavilySearch with fallback nets on thin results.
 *  Tavily's credit/auth errors still throw through untouched. */
export async function webSearch(
  query: string,
  maxResults = 8,
  opts: TavilyOpts = {}
): Promise<TavilyResult[]> {
  const primary = await tavilySearch(query, maxResults, opts);
  // Domain-scoped sweeps stay single-provider: the other engines don't take
  // Tavily's include_domains contract and unscoped fallbacks would pollute
  // a deliberately narrow pass.
  if (primary.length >= THIN || opts.includeDomains?.length || !fallbackProvidersConfigured()) {
    return primary;
  }
  const [exa, brave] = await Promise.all([
    exaSearch(query, maxResults),
    braveSearch(query, maxResults),
  ]);
  const seen = new Set(primary.map((r) => dedupeKey(r.url)));
  const merged = [...primary];
  // Interleave the two fallback nets so neither dominates the tail.
  const extras = [exa, brave];
  for (let i = 0; merged.length < maxResults * 2; i++) {
    let added = false;
    for (const list of extras) {
      const r = list[i];
      if (!r || !r.url || !host(r.url)) continue;
      const k = dedupeKey(r.url);
      if (seen.has(k)) continue;
      seen.add(k);
      merged.push(r);
      added = true;
    }
    if (!added && i >= Math.max(exa.length, brave.length)) break;
  }
  return merged;
}
