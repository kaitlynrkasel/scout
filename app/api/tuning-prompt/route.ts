import { NextRequest, NextResponse } from "next/server";
import { claudeJson } from "@/lib/claude";
import { ApiCreditError } from "@/lib/apiErrors";

export const runtime = "nodejs";
export const maxDuration = 30;

// Turns real usage data (deny rate, fit-score gap, WHY people pass, channel
// performance) into a ready-to-paste engineering prompt for recalibrating
// lib/discover.ts's search/extraction prompts. This is a dev tool: the output
// is meant to be handed directly to Claude Code in a future session, not
// shown as user-facing copy.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      useCase,
      decided,
      denyRate,
      keptFit,
      deniedFit,
      deniedReasons,
      keptChannels,
      deniedChannels,
      replyRate,
      repliedCount,
      sentCount,
    } = body || {};

    if (!decided || decided < 5) {
      return NextResponse.json(
        { error: "Not enough decided finds yet to ground a tuning prompt in real data." },
        { status: 400 }
      );
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json(
        { error: "Missing ANTHROPIC_API_KEY in .env.local." },
        { status: 500 }
      );
    }

    const pct = (v: number) => `${Math.round((v || 0) * 100)}%`;
    const fmtPairs = (arr: any[]) =>
      Array.isArray(arr) && arr.length
        ? arr.slice(0, 6).map(([k, v]: [string, number]) => `${k}: ${v}`).join(", ")
        : "(none)";

    const dataBlock =
      `USE CASE: ${useCase || "(unspecified)"}\n` +
      `DECIDED FINDS: ${decided}\n` +
      `DENY RATE: ${pct(denyRate)}\n` +
      `AVG FIT, kept: ${keptFit != null ? pct(keptFit) : "n/a"}, denied: ${deniedFit != null ? pct(deniedFit) : "n/a"}\n` +
      `DENY REASONS (bucketed, most common first): ${fmtPairs(deniedReasons)}\n` +
      `CHANNELS, kept: ${fmtPairs(keptChannels)} | denied: ${fmtPairs(deniedChannels)}\n` +
      `REPLY RATE: ${replyRate != null ? `${pct(replyRate)} (${repliedCount}/${sentCount} tracked)` : "not enough tracked sends yet"}`;

    const sys =
      `You write a ready-to-paste ENGINEERING PROMPT for Claude Code, an AI coding agent, to recalibrate an outreach ` +
      `discovery engine's search/extraction prompts based on REAL usage data from one account. The engine lives in ` +
      `lib/discover.ts: planQueries() builds web-search queries from the goal + user profile, and extract()'s fitRules ` +
      `judge is_relevant/fit_score for each search result. Your job is to translate the DATA below into 2 to 4 concrete, ` +
      `specific directives referencing the actual numbers, e.g. "34% of denials cite wrong location; tighten the ` +
      `LOCATION ALIGNMENT clause in extract()'s fitRules to penalize fit_score below 0.25, not just deprioritize, when ` +
      `the result's location clearly conflicts with the user's stated location." Ground every directive in a specific ` +
      `number from the data, never generic advice like "improve relevance." If kept-vs-denied fit scores are close ` +
      `together (a small gap), call that out explicitly as evidence fit_score isn't discriminating well and needs a ` +
      `sharper rubric. If a channel is denied far more than kept, flag it. If reply rate is available and low, note ` +
      `that outreach volume isn't the bottleneck, targeting quality is. Write it as an instruction addressed to Claude ` +
      `Code ("Open lib/discover.ts and..."), a developer will paste this directly into a coding session. Keep it under ` +
      `200 words, no preamble, no markdown headers, just the directives as short paragraphs or a tight list.`;

    const prompt = await claudeJson(sys, dataBlock);
    return NextResponse.json({ prompt: String(prompt || "").trim() });
  } catch (e: any) {
    if (e instanceof ApiCreditError) {
      return NextResponse.json(
        { error: e.userMessage(), credit: true, provider: e.provider, reason: e.reason },
        { status: 402 }
      );
    }
    return NextResponse.json(
      { error: e?.message || "Couldn't generate a tuning prompt." },
      { status: 500 }
    );
  }
}
