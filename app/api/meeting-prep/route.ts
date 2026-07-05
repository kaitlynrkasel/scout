import { NextRequest, NextResponse } from "next/server";
import { tavilySearch } from "@/lib/tavily";
import { claudeJson, parseJsonLoose } from "@/lib/claude";
import { ApiCreditError } from "@/lib/apiErrors";

export const runtime = "nodejs";
export const maxDuration = 120; // two Tavily searches + one Claude pass

// Generate factual meeting/interview prep for a specific contact after the
// user's outreach has landed. Runs fresh web searches on the person + their
// outlet so the facts reflect what's happening now, not what was in the
// original discovery snippet.
//
// Returns categorized FACTS about the opportunity, never invented questions
// to ask. If Tavily or Claude fails, degrades to whatever was already in the
// opp record so we still hand back something useful.
export async function POST(req: NextRequest) {
  try {
    const { opp, about, useCase } = await req.json();
    if (!opp?.name) {
      return NextResponse.json(
        { error: "Missing opportunity data." },
        { status: 400 }
      );
    }
    if (!process.env.TAVILY_API_KEY || !process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json(
        { error: "Missing API keys." },
        { status: 500 }
      );
    }

    const name = String(opp.name || "").trim();
    const outlet = String(opp.outlet || "").trim();
    const role = String(opp.contactRole || "").trim();

    // Two lightweight searches: one for the person, one for the company/outlet.
    // Small max_results to keep the Claude context focused.
    const nameQuery = outlet
      ? `"${name}" ${outlet} news OR announcement OR interview`
      : `"${name}" news OR announcement OR interview`;
    const outletQuery = outlet
      ? `"${outlet}" latest news OR launch OR partnership`
      : "";

    const [personHits, outletHits] = await Promise.all([
      tavilySearch(nameQuery, 5).catch(() => []),
      outletQuery ? tavilySearch(outletQuery, 4).catch(() => []) : Promise.resolve([]),
    ]);

    // Compact source list, capped so the prompt stays small.
    const sources = [...personHits, ...outletHits].slice(0, 8).map((r, i) => ({
      idx: i + 1,
      title: r.title || "",
      url: r.url || "",
      content: String(r.content || "").slice(0, 500),
    }));

    const sys =
      "You are prepping the user for a meeting or interview with a specific contact. " +
      "Return ONLY JSON: {facts: [{category, fact, sourceIdx}]}. " +
      "Each element is ONE concrete, TRUE fact about the contact or their outlet drawn from the SEARCH SOURCES below " +
      "OR from the KNOWN CONTEXT. Never invent details. If a claim comes from a source, set sourceIdx to that source's " +
      "number; if it comes from the known context and you have no source, leave sourceIdx null. Never ask questions, " +
      "never give advice, every element is a FACT the user can quietly reference during a meeting to sound informed. " +
      "\n\nCategories to spread across (aim for 6 to 9 total facts, mix and match):\n" +
      "- 'About their work', role, focus areas, recent projects, career highlights\n" +
      "- 'Recent news', announcements, launches, awards, hires, moves in the last ~6 months\n" +
      "- 'Outlet context', what their company / publication is known for, market position, notable clients or reach\n" +
      "- 'Common ground', genuine overlaps between the user's background (see ABOUT THE USER) and this contact\n" +
      "- 'Priorities right now', what they seem focused on lately, based on what they've published or shipped\n" +
      "\nSkip categories if there's no honest fact for them. Do NOT pad with generic filler ('they seem interesting'). " +
      "If the sources are thin, return fewer facts rather than making things up. Facts must be concrete: specific " +
      "project names, real numbers, dated announcements, named collaborators, not vague adjectives.";

    const known =
      `KNOWN CONTEXT (from the original Scout find, treat as verified):\n` +
      `- Contact: ${name}${role ? ` (${role})` : ""}${outlet ? ` at ${outlet}` : ""}\n` +
      `- Location: ${String(opp.location || "").trim() || "unknown"}\n` +
      `- Why this was a fit for the user: ${String(opp.whyItFits || "").trim() || "(none captured)"}\n` +
      `- Original source snippet: ${String(opp.sourceSnippet || "").trim().slice(0, 400) || "(none)"}\n`;

    const userBlock =
      `ABOUT THE USER (draw on this for the "Common ground" category):\n${String(about || "").slice(0, 1200) || "(no user context)"}\n` +
      `USE CASE: ${String(useCase || "").slice(0, 120)}\n\n` +
      known +
      `\nSEARCH SOURCES:\n` +
      (sources.length
        ? sources
            .map(
              (s) =>
                `[${s.idx}] ${s.title}\n${s.url}\n${s.content.replace(/\s+/g, " ").trim()}`
            )
            .join("\n\n")
        : "(no fresh sources found, rely on KNOWN CONTEXT and return only well-supported facts)");

    let facts: Array<{ category: string; fact: string; sourceIdx?: number | null }> = [];
    try {
      const parsed: any = parseJsonLoose(await claudeJson(sys, userBlock));
      if (Array.isArray(parsed?.facts)) {
        facts = parsed.facts
          .map((f: any) => ({
            category: String(f?.category || "").trim().slice(0, 40),
            fact: String(f?.fact || "").trim().slice(0, 400),
            sourceIdx:
              typeof f?.sourceIdx === "number" && f.sourceIdx >= 1
                ? f.sourceIdx
                : null,
          }))
          .filter((f: any) => f.category && f.fact);
      }
    } catch (e) {
      if (e instanceof ApiCreditError) throw e;
    }

    // Resolve source URLs so the client can render inline links per fact.
    const factsWithSources = facts.map((f) => {
      const src = f.sourceIdx && sources[f.sourceIdx - 1];
      return {
        category: f.category,
        fact: f.fact,
        source:
          src && src.url ? { title: src.title, url: src.url } : undefined,
      };
    });

    return NextResponse.json({
      facts: factsWithSources,
      generatedAt: new Date().toISOString(),
      searchedQueries: [nameQuery, outletQuery].filter(Boolean),
      sourceCount: sources.length,
    });
  } catch (e: any) {
    if (e instanceof ApiCreditError) {
      return NextResponse.json(
        { error: e.userMessage(), credit: true, provider: e.provider, reason: e.reason },
        { status: 402 }
      );
    }
    return NextResponse.json(
      { error: e?.message || "Meeting prep failed." },
      { status: 500 }
    );
  }
}
