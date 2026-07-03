// Tavily web-search wrapper, ported from tavilySearch() in 07_Discovery.gs.
// Throws ApiCreditError on credit/auth/limit problems so the UI can report them;
// returns [] for ordinary transient failures (a single flaky query).

import { classifyApiError } from "./apiErrors";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export interface TavilyResult {
  title: string;
  url: string;
  content: string;
}

// In dev, cache Tavily responses to disk keyed by query+maxResults. Same query
// → same fixture, so iterating on the extract prompt doesn't re-burn Tavily
// credits and cuts search wall-time roughly in half. Off in production
// (Vercel's serverless FS is read-only outside /tmp, and prod queries should
// always be fresh). Explicit override: SCOUT_TAVILY_CACHE=off | on.
const CACHE_MODE = process.env.SCOUT_TAVILY_CACHE?.toLowerCase();
const CACHE_ENABLED =
  CACHE_MODE === "on" || (CACHE_MODE !== "off" && process.env.NODE_ENV !== "production");
const CACHE_DIR = path.join(process.cwd(), ".scout-cache", "tavily");

function cacheKey(query: string, maxResults: number): string {
  return createHash("sha1")
    .update(`${query}::${maxResults}`)
    .digest("hex")
    .slice(0, 16);
}

async function readCache(key: string): Promise<TavilyResult[] | null> {
  try {
    const raw = await fs.readFile(path.join(CACHE_DIR, `${key}.json`), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.results) ? parsed.results : null;
  } catch {
    return null; // no fixture, unreadable, or corrupt — fall through to a live call
  }
}

async function writeCache(
  key: string,
  query: string,
  results: TavilyResult[]
): Promise<void> {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(
      path.join(CACHE_DIR, `${key}.json`),
      JSON.stringify({ query, cachedAt: new Date().toISOString(), results }, null, 2),
      "utf8"
    );
  } catch {
    // Cache is a nice-to-have; a failed write should never break discovery.
  }
}

export async function tavilySearch(
  query: string,
  maxResults = 8
): Promise<TavilyResult[]> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) throw new Error("TAVILY_API_KEY is not set");

  if (CACHE_ENABLED) {
    const cached = await readCache(cacheKey(query, maxResults));
    if (cached) return cached;
  }

  let res: Response;
  try {
    res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        api_key: key, // kept for back-compat with older Tavily API
        query,
        max_results: maxResults,
        search_depth: "basic",
      }),
    });
  } catch {
    return []; // network blip — transient, just no results for this query
  }

  if (!res.ok) {
    let text = "";
    try {
      text = await res.text();
    } catch {}
    const credit = classifyApiError("Tavily", res.status, text);
    if (credit) throw credit; // out of credits / bad key / limit — surface it
    return []; // other non-200 — treat as no results
  }

  try {
    const data = await res.json();
    const results = (data?.results || []) as TavilyResult[];
    if (CACHE_ENABLED && results.length) {
      await writeCache(cacheKey(query, maxResults), query, results);
    }
    return results;
  } catch {
    return [];
  }
}
