// Tavily web-search wrapper, ported from tavilySearch() in 07_Discovery.gs.
// Throws ApiCreditError on credit/auth/limit problems so the UI can report them;
// returns [] for ordinary transient failures (a single flaky query).

import { classifyApiError } from "./apiErrors";

export interface TavilyResult {
  title: string;
  url: string;
  content: string;
}

export async function tavilySearch(
  query: string,
  maxResults = 8
): Promise<TavilyResult[]> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) throw new Error("TAVILY_API_KEY is not set");

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
    return (data?.results || []) as TavilyResult[];
  } catch {
    return [];
  }
}
