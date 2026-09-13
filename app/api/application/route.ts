import { NextRequest, NextResponse } from "next/server";
import { withinRateLimit, requestIp } from "@/lib/rateLimit";
import { draftApplication } from "@/lib/application";
import { ApiCreditError } from "@/lib/apiErrors";

export const runtime = "nodejs";
export const maxDuration = 240; // Pro plan headroom for reading pages + two Claude passes

// Read a specific internship/job posting and draft every written application
// component (cover letter, essays, short answers) from the applicant's profile.
export async function POST(req: NextRequest) {
  // Cost-bearing and reachable before login (guest mode), so the guard is
  // per-IP rate limiting, same as the other open-by-design endpoints.
  if (!withinRateLimit(`application:${requestIp(req.headers)}`, 15, 10 * 60 * 1000)) {
    return NextResponse.json({ error: "Slow down a moment." }, { status: 429 });
  }
  try {
    const { url, name, outlet, about, useCase, coaching, dismissedAdvice, editPairs } =
      await req.json();
    if (!url || !String(url).trim()) {
      return NextResponse.json({ error: "This opening has no link to read." }, { status: 400 });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json(
        { error: "Missing ANTHROPIC_API_KEY in .env.local." },
        { status: 500 }
      );
    }
    const result = await draftApplication({
      url: String(url),
      name: String(name || ""),
      outlet: String(outlet || ""),
      about: String(about || ""),
      useCase: String(useCase || ""),
      coaching: Array.isArray(coaching) ? coaching : [],
      dismissedAdvice: Array.isArray(dismissedAdvice) ? dismissedAdvice : [],
      editPairs: Array.isArray(editPairs) ? editPairs : [],
    });
    return NextResponse.json(result);
  } catch (e: any) {
    if (e instanceof ApiCreditError) {
      return NextResponse.json(
        { error: e.userMessage(), credit: true, provider: e.provider, reason: e.reason },
        { status: 402 }
      );
    }
    return NextResponse.json(
      { error: e?.message || "Couldn't read that application." },
      { status: 500 }
    );
  }
}
