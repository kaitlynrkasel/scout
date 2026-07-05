// A typed error for when an API can't be used because of credits, a bad key, or
// rate limits, so the UI can tell the user exactly what's wrong instead of
// silently returning nothing.

export type ApiProvider = "Anthropic" | "Tavily";
export type ApiReason = "credits" | "auth" | "rate";

export class ApiCreditError extends Error {
  provider: ApiProvider;
  reason: ApiReason;
  constructor(provider: ApiProvider, reason: ApiReason, message?: string) {
    super(message || `${provider} ${reason}`);
    this.name = "ApiCreditError";
    this.provider = provider;
    this.reason = reason;
  }
  userMessage(): string {
    const who = this.provider;
    const topUp =
      who === "Anthropic"
        ? "Top up at console.anthropic.com → Billing"
        : "Check your plan at app.tavily.com";
    if (this.reason === "credits")
      return `Your ${who} credits have run out. ${topUp}, then try again.`;
    if (this.reason === "auth")
      return `Your ${who} API key looks invalid or unauthorized. Double-check the ${who} key in your settings.`;
    return `Your ${who} account hit a rate limit. Wait a moment and try again.`;
  }
}

// Decide whether an HTTP error from a provider is a credit/auth/limit problem.
export function classifyApiError(
  provider: ApiProvider,
  status: number,
  bodyText: string
): ApiCreditError | null {
  const t = (bodyText || "").toLowerCase();
  const creditish =
    t.includes("credit") ||
    t.includes("balance") ||
    t.includes("quota") ||
    t.includes("insufficient") ||
    t.includes("usage limit") ||
    t.includes("plan limit") ||
    t.includes("limit exceeded") ||
    t.includes("out of") ||
    t.includes("payment");

  if (status === 402 || status === 432)
    return new ApiCreditError(provider, "credits", `${provider} ${status}: ${t.slice(0, 140)}`);
  if (status === 401 || status === 403)
    return new ApiCreditError(provider, creditish ? "credits" : "auth", `${provider} ${status}`);
  if (status === 429)
    return new ApiCreditError(provider, creditish ? "credits" : "rate", `${provider} ${status}`);
  // Anthropic returns 400 with a "credit balance is too low" message.
  if (creditish)
    return new ApiCreditError(provider, "credits", `${provider} ${status}: ${t.slice(0, 140)}`);
  return null;
}
