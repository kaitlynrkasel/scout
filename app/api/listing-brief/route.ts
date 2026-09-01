import { NextRequest, NextResponse } from "next/server";
import { withinRateLimit, requestIp } from "@/lib/rateLimit";
import { claudeJson, parseJsonLoose, noDash } from "@/lib/claude";
import { ApiCreditError } from "@/lib/apiErrors";
import { todayLine } from "@/lib/today";

export const runtime = "nodejs";
export const maxDuration = 30;

// Read a job listing the user is HIRING for and turn it into a search for the
// people who could fill it.
//
// The inversion is the whole job. A listing describes a ROLE — responsibilities,
// requirements, what the company offers — and Scout searches for PEOPLE. Handing
// the listing to the planner unchanged returns other companies' job ads, because
// every word in it is posting-shaped. So the model reads the role and writes the
// candidate: "5+ years React, fintech, Seattle hybrid" becomes "software
// engineers with senior React experience", "currently in fintech or adjacent",
// "in or near Seattle".
//
// Two outputs, and they are not the same thing. `bullets` REPLACE the goal on
// the stage, so they are short and few. `brief` is everything else the listing
// said that still matters — it rides along with the search as context, because a
// real listing carries twenty requirements and four bullets cannot hold them.
export async function POST(req: NextRequest) {
  // A listing is a big input and this route is open pre-login like the rest of
  // the composing endpoints, so the per-IP limit is tighter than theirs.
  if (!withinRateLimit(`listing:${requestIp(req.headers)}`, 12, 10 * 60 * 1000)) {
    return NextResponse.json({ error: "Slow down a moment." }, { status: 429 });
  }
  try {
    const { listing } = await req.json();
    // Long enough for a real posting, short enough that one paste can't become
    // an expensive prompt. Most listings land well under this.
    const text = String(listing || "").trim().slice(0, 12000);
    if (text.length < 40)
      return NextResponse.json(
        { error: "Paste a bit more of the listing so Scout has something to read." },
        { status: 400 }
      );
    if (!process.env.ANTHROPIC_API_KEY)
      return NextResponse.json({ error: "Scout can't read listings right now." }, { status: 503 });

    const sys =
      "You read a JOB LISTING that the user is hiring for, and describe the PEOPLE who could fill it " +
      "so a people-search engine can go find them.\n" +
      `${todayLine()}\n` +
      'Return ONLY JSON: {"role": string, "bullets": [string, ...], "brief": string}.\n\n' +
      "THE INVERSION, which is the point of this task: the listing describes an OPENING. The search " +
      "must describe CANDIDATES. Never write a bullet that would find other job postings. Write who " +
      "the person is, not what the job is — 'software engineers with senior React experience', not " +
      "'React developer role'. Avoid the words opening, posting, position, vacancy, apply, hiring and " +
      "job in the bullets entirely; they flip the search into looking for adverts.\n\n" +
      "role: the job title as posted, plain, no company name. Empty string if the text names none.\n\n" +
      "bullets: 3 to 5 short noun-led phrases, 3 to 9 words, no trailing period, each describing the " +
      "candidate. Cover, in this order of importance and only where the listing states them: what they " +
      "do and at what seniority; the experience or credentials that are genuinely required; where they " +
      "need to be, or that it is remote; the industry or kind of employer they'd be coming from. " +
      "Requirements the listing calls preferred or nice-to-have are NOT bullets — they belong in brief.\n\n" +
      "brief: a compact plain-text paragraph of everything else that would change WHO fits — the " +
      "preferred qualifications, the tools or domains named, seniority signals, team and reporting " +
      "context, the employment type, and anything disqualifying. No comp, no benefits, no company " +
      "boilerplate, no application instructions: none of that changes who the right person is. Under " +
      "120 words. Empty string if the listing carries nothing beyond the bullets.\n\n" +
      "Plain words, sentence case, never an em dash. Invent nothing the listing does not say.";

    const parsed: any = parseJsonLoose(await claudeJson(sys, `JOB LISTING:\n${text}`, 900));
    const bullets: string[] = (Array.isArray(parsed?.bullets) ? parsed.bullets : [])
      .map((b: any) => noDash(String(b || "")).trim().replace(/\.$/, ""))
      .filter(Boolean)
      .slice(0, 5);
    // Fewer than two points is not a reading of a listing, it's a failure —
    // and silently accepting it would replace the user's search with one line.
    if (bullets.length < 2)
      return NextResponse.json(
        { error: "Scout couldn't make a search out of that. Is the whole listing there?" },
        { status: 422 }
      );
    return NextResponse.json({
      role: noDash(String(parsed?.role || "")).trim().slice(0, 80),
      bullets,
      brief: noDash(String(parsed?.brief || "")).trim().slice(0, 900),
    });
  } catch (e: any) {
    if (e instanceof ApiCreditError)
      return NextResponse.json({ error: "Scout is out of API credit right now." }, { status: 503 });
    return NextResponse.json({ error: "Couldn't read that listing." }, { status: 500 });
  }
}
