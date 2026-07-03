import { NextRequest, NextResponse } from "next/server";
import { draftApplication } from "@/lib/application";
import { ApiCreditError } from "@/lib/apiErrors";

export const runtime = "nodejs";
export const maxDuration = 60; // reading pages + two Claude passes

// Read a specific internship/job posting and draft every written application
// component (cover letter, essays, short answers) from the applicant's profile.
export async function POST(req: NextRequest) {
  try {
    const { url, name, outlet, about, useCase, coaching, editPairs } = await req.json();
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
