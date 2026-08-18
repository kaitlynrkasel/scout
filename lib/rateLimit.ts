// Minimal in-memory rate limiter for expensive API routes. Serverless-aware
// caveat: the map lives per warm instance, so this is burst protection (stops
// tight curl loops and runaway clients), not a distributed quota, plan-level
// entitlements remain the real budget control. No external service needed.

const buckets = new Map<string, { count: number; resetAt: number }>();

// True when the caller identified by `key` is within `limit` hits per
// `windowMs`. Callers build the key from IP + route.
export function withinRateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now >= b.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    // Opportunistic cleanup so the map can't grow unbounded on a long-lived
    // instance.
    if (buckets.size > 5000) {
      for (const [k, v] of buckets) if (now >= v.resetAt) buckets.delete(k);
    }
    return true;
  }
  b.count += 1;
  return b.count <= limit;
}

// Best-effort caller IP behind Vercel's proxy.
export function requestIp(headers: Headers): string {
  return (
    headers.get("x-real-ip") ||
    headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    "unknown"
  );
}
