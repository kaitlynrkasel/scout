// Tavily web-search wrapper, ported from tavilySearch() in 07_Discovery.gs.

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
  try {
    const res = await fetch("https://api.tavily.com/search", {
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
    if (!res.ok) return [];
    const data = await res.json();
    return (data?.results || []) as TavilyResult[];
  } catch {
    return [];
  }
}
