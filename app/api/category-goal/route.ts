import { NextRequest, NextResponse } from "next/server";
import { claudeJson, parseJsonLoose, noDash } from "@/lib/claude";
import { ApiCreditError } from "@/lib/apiErrors";

export const runtime = "nodejs";
export const maxDuration = 20;

// Turn a short category NAME the user typed (e.g. "A&R reps", "Radio DJs") into a
// concrete search goal describing exactly WHO to find, so discovery understands
// the category. Uses the user's use case and profile for context.
export async function POST(req: NextRequest) {
  try {
    const { name, useCase, about } = await req.json();
    const nm = String(name || "").trim();
    if (!nm) return NextResponse.json({ error: "No category name." }, { status: 400 });
    if (!process.env.ANTHROPIC_API_KEY) {
      // Graceful fallback: use the name itself as the goal.
      return NextResponse.json({ goal: nm });
    }
    const sys =
      `You turn a short outreach CATEGORY name into a concrete, specific search goal describing exactly WHO or WHAT to ` +
      `find, so a discovery engine knows what it's looking for. Return ONLY JSON {goal}. goal is ONE clear phrase (not a ` +
      `sentence with fluff), naming the kind of people/organizations, their role, and the relevant field. No preamble. ` +
      `NEVER use em-dashes. Example: name "Recruiters" + use case "Job / Internship search" => goal "recruiters and hiring ` +
      `managers in the user's industry with open roles for their level". If the name is already specific, tighten it; do not invent unrelated constraints.`;
    const user =
      `CATEGORY NAME: ${nm}\nUSE CASE: ${String(useCase || "")}\nABOUT THE USER (for field/context, optional): ${String(about || "").slice(0, 600)}`;

    let goal = nm;
    try {
      const parsed: any = parseJsonLoose(await claudeJson(sys, user));
      goal = noDash(String(parsed?.goal || "").trim()) || nm;
    } catch (e) {
      if (e instanceof ApiCreditError) throw e;
      goal = nm; // fall back to the raw name
    }
    return NextResponse.json({ goal });
  } catch (e: any) {
    if (e instanceof ApiCreditError) {
      return NextResponse.json(
        { error: e.userMessage(), credit: true, provider: e.provider, reason: e.reason },
        { status: 402 }
      );
    }
    return NextResponse.json({ error: e?.message || "Failed." }, { status: 500 });
  }
}
