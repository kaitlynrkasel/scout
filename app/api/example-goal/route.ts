import { NextRequest, NextResponse } from "next/server";
import { claudeJson, parseJsonLoose, noDash } from "@/lib/claude";
import { ApiCreditError } from "@/lib/apiErrors";

export const runtime = "nodejs";
export const maxDuration = 20;

// Generate a SHORT, personalized EXAMPLE search phrase to show as the greyed-out
// placeholder under "Who are you looking for?". It's tailored to the user's own
// industry/field (inferred from ABOUT) and the CATEGORY they're about to search,
// and it varies per person via the salt, so no two people see the same example.
// This is an inviting sample the user could type verbatim, not the actual search.
export async function POST(req: NextRequest) {
  try {
    const { category, useCase, about, salt } = await req.json();
    const cat = String(category || "").trim();
    const uc = String(useCase || "").trim();
    const aboutStr = String(about || "").trim();

    // Nothing to personalize from, let the client keep its static placeholder.
    if (!aboutStr) {
      return NextResponse.json({ example: "" });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json({ example: "" });
    }

    const sys =
      `You write ONE short example search phrase for an outreach tool's input placeholder. ` +
      `It shows greyed-out as "e.g. <phrase>" to inspire the user, so it must read like something THEY would plausibly type. ` +
      `Requirements: ` +
      `(1) It is specific to the USER'S OWN industry/field/city, infer these from ABOUT THE USER; never generic. ` +
      `(2) It matches the CATEGORY of search they're about to run (the kind of contact/target that category names). ` +
      `(3) It is concrete and reachable: name the target type + a sharpening detail (sub-niche, company size/stage, ` +
      `a city, or a needed contact channel), the kind of specifics that make discovery work well. ` +
      `(4) 6 to 14 words, lowercase, no trailing period, no "e.g." prefix (that's added by the UI), no quotes. ` +
      `(5) NEVER use em-dashes. ` +
      `Return ONLY JSON {"example": string}. ` +
      `Examples of the STYLE (do not copy, tailor to THIS user): "indie folk spotify playlist curators accepting submissions", ` +
      `"boutique fitness studios in austin we could sell our booking software to", "seed-stage fintech founders open to a quick intro call". ` +
      (salt
        ? `Variation seed "${String(salt).slice(0, 40)}": pick a DIFFERENT valid angle/segment than a generic run would, so two similar users get different examples. `
        : "");
    const user =
      `CATEGORY OF SEARCH: ${cat || "(none / custom)"}\n` +
      `USE CASE: ${uc}\n` +
      `ABOUT THE USER (their industry, sub-field, city are in here): ${aboutStr.slice(0, 800)}`;

    let example = "";
    try {
      const parsed: any = parseJsonLoose(await claudeJson(sys, user));
      example = noDash(String(parsed?.example || "").trim())
        .replace(/^e\.g\.?\s*/i, "")
        .replace(/^["']|["']$/g, "")
        .replace(/\.$/, "")
        .trim();
    } catch (e) {
      if (e instanceof ApiCreditError) throw e;
      example = "";
    }
    return NextResponse.json({ example });
  } catch (e: any) {
    if (e instanceof ApiCreditError) {
      return NextResponse.json(
        { error: e.userMessage(), credit: true, provider: e.provider, reason: e.reason },
        { status: 402 }
      );
    }
    // Never block the form on a placeholder failure.
    return NextResponse.json({ example: "" });
  }
}
