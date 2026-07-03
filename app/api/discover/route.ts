import { NextRequest, NextResponse } from "next/server";
import { discover } from "@/lib/discover";
import { ApiCreditError } from "@/lib/apiErrors";

export const maxDuration = 60; // Vercel Hobby caps at 60s; Pro lifts to 300s

export async function POST(req: NextRequest) {
  try {
    const { goal, about, useCase, template, feedback } = await req.json();
    if (!goal || !String(goal).trim()) {
      return NextResponse.json({ error: "Please enter a goal." }, { status: 400 });
    }
    if (!process.env.TAVILY_API_KEY || !process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json(
        {
          error:
            "Missing API keys. Copy .env.local.example to .env.local and add TAVILY_API_KEY and ANTHROPIC_API_KEY, then restart.",
        },
        { status: 500 }
      );
    }
    const result = await discover(
      String(goal),
      String(about || ""),
      String(useCase || template || "networking"),
      10,
      feedback && typeof feedback === "object" ? feedback : undefined
    );
    return NextResponse.json(result);
  } catch (e: any) {
    if (e instanceof ApiCreditError) {
      return NextResponse.json(
        { error: e.userMessage(), credit: true, provider: e.provider, reason: e.reason },
        { status: 402 }
      );
    }
    return NextResponse.json(
      { error: e?.message || "Discovery failed." },
      { status: 500 }
    );
  }
}
