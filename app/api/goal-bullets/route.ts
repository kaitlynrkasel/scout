import { NextRequest, NextResponse } from "next/server";
import { withinRateLimit, requestIp } from "@/lib/rateLimit";
import { claudeJson, parseJsonLoose, noDash } from "@/lib/claude";
import { ApiCreditError } from "@/lib/apiErrors";

export const runtime = "nodejs";
export const maxDuration = 20;

// Distill a category goal written as prose into the few points it actually
// makes, for the bullet view on the Scout stage. Splitting on punctuation just
// reprints the user's paragraph with a dot in front of it; this writes the
// points. The joined bullets REPLACE the goal, so they must carry every
// requirement the prose carried; losing one would silently change the search.
export async function POST(req: NextRequest) {
  // Open to pre-login flows by design, so the guard is per-IP rate
  // limiting: without it this endpoint spends our API money for anyone
  // who curls it in a loop.
  if (!withinRateLimit(`goalbul:${requestIp(req.headers)}`, 30, 10 * 60 * 1000)) {
    return NextResponse.json({ error: "Slow down a moment." }, { status: 429 });
  }
  try {
    const { goal } = await req.json();
    const g = String(goal || "").trim().slice(0, 1200);
    if (!g) return NextResponse.json({ bullets: [] });
    if (!process.env.ANTHROPIC_API_KEY) return NextResponse.json({ bullets: [] });

    const sys =
      "You rewrite a people-search goal as its distinct points, for a bulleted display " +
      "that will REPLACE the original text as the search input.\n" +
      'Return ONLY JSON: {"bullets": [string, ...]}.\n\n' +
      "Rules:\n" +
      "- 2 to 4 bullets. Each is a short noun-led phrase, 3 to 8 words, no trailing period.\n" +
      "- Together they must preserve EVERY requirement, preference, and exclusion in the " +
      "goal. Nothing may be dropped, softened, or added; a lost point silently changes the search.\n" +
      "- Deduplicate: if the goal says the same thing twice (\"any industry... I want a wide " +
      "variety\"), it becomes one bullet.\n" +
      "- Strip filler (\"I want\", \"we are looking for\", exclamation marks); keep the meaning.\n" +
      "- Plain words, sentence case, never an em dash.\n" +
      'Example: "Companies from any industry and in any location. They can be on the smaller ' +
      'side. We are pitching our product to them. Any industry, I want a wide variety!" -> ' +
      '{"bullets":["Companies across a wide variety of industries","Any location","Smaller companies preferred","Prospects to pitch our product to"]}';

    const parsed: any = parseJsonLoose(await claudeJson(sys, `GOAL:\n${g}`, 400));
    const bullets = (Array.isArray(parsed?.bullets) ? parsed.bullets : [])
      .map((b: any) => noDash(String(b || "")).trim().replace(/\.$/, ""))
      .filter(Boolean)
      .slice(0, 4);
    // One bullet is not a summary, and zero is a failure; either way the
    // caller keeps the prose rather than losing meaning.
    return NextResponse.json({ bullets: bullets.length >= 2 ? bullets : [] });
  } catch (e: any) {
    if (e instanceof ApiCreditError) {
      return NextResponse.json({ bullets: [] });
    }
    return NextResponse.json({ bullets: [] });
  }
}
