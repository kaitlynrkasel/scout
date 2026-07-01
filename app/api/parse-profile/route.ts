import { NextRequest, NextResponse } from "next/server";
import { claudeJson, parseJsonLoose } from "@/lib/claude";
import { ApiCreditError } from "@/lib/apiErrors";

export const maxDuration = 30;

// Read an uploaded resume / bio / company doc and pull out the couple of profile
// fields we can prefill (name + a likely use case). Never fabricates: blanks a
// field it can't find. The full text still becomes the bio on the client.
export async function POST(req: NextRequest) {
  try {
    const { text } = await req.json();
    const t = String(text || "").slice(0, 12000);
    if (!t.trim()) {
      return NextResponse.json({ error: "No text to read." }, { status: 400 });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json(
        { error: "Missing ANTHROPIC_API_KEY in .env.local." },
        { status: 500 }
      );
    }
    const sys =
      "You read a resume, bio, or company description and extract a few profile fields " +
      "for a personal outreach tool. Return ONLY a JSON object, no prose. Never invent facts, " +
      "leave a field as an empty string if it is not clearly present. " +
      "name = the person's full name (or the company name if this is a company document); empty if unclear. " +
      "use_case = a short phrase (2 to 5 words) for what this person would most likely use an outreach tool for, " +
      "e.g. 'Job / Internship search', 'Networking', 'Music PR / Playlisting', 'Sales / lead generation', " +
      "'Recruiting / hiring', 'Fundraising / investors', 'Press & media outreach'. Choose the single best fit.";
    const user = `Fields: name (string), use_case (string).\n\nDOCUMENT:\n${t}`;
    const parsed = parseJsonLoose(await claudeJson(sys, user));
    return NextResponse.json({
      name: String(parsed?.name || "").trim(),
      useCase: String(parsed?.use_case || parsed?.useCase || "").trim(),
    });
  } catch (e: any) {
    if (e instanceof ApiCreditError) {
      return NextResponse.json(
        { error: e.userMessage(), credit: true, provider: e.provider, reason: e.reason },
        { status: 402 }
      );
    }
    return NextResponse.json(
      { error: e?.message || "Could not read that document." },
      { status: 500 }
    );
  }
}
