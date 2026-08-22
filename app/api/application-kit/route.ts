import { NextRequest, NextResponse } from "next/server";
import { tavilySearch } from "@/lib/tavily";
import { claudeJson, parseJsonLoose, noDash } from "@/lib/claude";
import { ApiCreditError } from "@/lib/apiErrors";
import { withinRateLimit, requestIp } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const maxDuration = 120;

// Everything a person needs to apply WELL, for one application prospect:
// fresh research on the organization, what to know before the interview, and
// (when the target is a school or degree program) scholarship leads as part
// of the same package. With `jobText` alone it also parses a pasted posting
// into the fields a find needs, so "paste a job description" can build the
// whole prospect from nothing.
export async function POST(req: NextRequest) {
  try {
    if (!withinRateLimit(`appkit:${requestIp(req.headers)}`, 20, 10 * 60 * 1000)) {
      return NextResponse.json({ error: "Slow down a moment." }, { status: 429 });
    }
    const { name, outlet, url, about, jobText } = await req.json();
    const org = String(outlet || "").trim();
    const role = String(name || "").trim();
    const posting = String(jobText || "").trim().slice(0, 9000);
    if (!org && !role && !posting) {
      return NextResponse.json({ error: "Nothing to research." }, { status: 400 });
    }
    if (!process.env.ANTHROPIC_API_KEY || !process.env.TAVILY_API_KEY) {
      return NextResponse.json({ error: "Missing API keys." }, { status: 500 });
    }

    // Parse a pasted posting first (when given) so the searches know the org.
    let parsed: any = null;
    if (posting) {
      const psys =
        `Extract the application target from a pasted job/internship/program posting. Return ONLY JSON ` +
        `{"role","org","contact_email","contact_name","url","location"}. Copy facts from the text; empty string when ` +
        `absent; never invent. role is the position or program name; org the company/school. No em-dashes.`;
      parsed = parseJsonLoose(await claudeJson(psys, posting.slice(0, 6000)));
    }
    const theOrg = org || String(parsed?.org || "").trim();
    const theRole = role || String(parsed?.role || "").trim();

    const looksSchool =
      /\b(university|college|school|academy|institute|conservatory|masters?|mba|ph\.?d|undergraduate|graduate program|degree)\b/i.test(
        `${theOrg} ${theRole} ${posting.slice(0, 400)}`
      );

    const [orgHits, schHits] = await Promise.all([
      theOrg
        ? tavilySearch(`"${theOrg}" about OR news OR culture OR interview process`, 5).catch(() => [])
        : Promise.resolve([]),
      looksSchool && theOrg
        ? tavilySearch(`"${theOrg}" scholarships OR financial aid OR fellowship ${theRole}`, 5).catch(
            () => []
          )
        : Promise.resolve([]),
    ]);
    const evidence = [...orgHits, ...schHits]
      .map((h: any) => `- ${h.title}\n  ${h.url}\n  ${String(h.content || "").slice(0, 400)}`)
      .join("\n");

    const sys =
      `You prepare someone to apply WELL to one specific opportunity, from real evidence only. Return ONLY JSON ` +
      `{"companyBrief": [..], "mustKnow": [..], "interviewPrep": [{"q","angle"}], "isSchool": bool, ` +
      `"scholarships": [{"name","why","url"}]}.\n` +
      `- companyBrief: 3-5 short factual lines about the organization (what it does, size/stage, anything recent) drawn ` +
      `from the evidence; skip what you cannot support.\n` +
      `- mustKnow: 2-4 things worth knowing before applying (deadlines, values they repeat, red flags, what they say ` +
      `they look for).\n` +
      `- interviewPrep: 3-5 likely questions for THIS role at THIS org, each with "angle": one line on how the ` +
      `APPLICANT (see ABOUT) can answer from their real background. Never invent facts about them.\n` +
      `- scholarships: ONLY when the target is a school/degree program and the evidence shows real scholarship or aid ` +
      `leads: name + one line why it fits + url. Empty array otherwise, never fabricate.\n` +
      `Plain language, no em-dashes, no flattery.`;
    const user =
      `TARGET: ${theRole || "(unknown role)"} at ${theOrg || "(unknown org)"}\n` +
      (url ? `POSTING URL: ${String(url)}\n` : "") +
      (posting ? `THE POSTING TEXT:\n${posting.slice(0, 4000)}\n` : "") +
      `\nABOUT THE APPLICANT: ${String(about || "").slice(0, 800)}\n` +
      `\nFRESH EVIDENCE FROM THE WEB:\n${evidence || "(no search results; keep everything you cannot support empty)"}`;

    const out: any = parseJsonLoose(await claudeJson(sys, user)) || {};
    const arr = (v: any, n: number) =>
      Array.isArray(v) ? v.map((x: any) => noDash(String(x || ""))).filter(Boolean).slice(0, n) : [];
    return NextResponse.json({
      // Real pages the research actually read: titles + urls, no model in
      // the loop, so every link is a genuine source.
      links: [...orgHits, ...schHits]
        .map((h: any) => ({ title: String(h.title || h.url || ""), url: String(h.url || "") }))
        .filter((l: any) => l.url)
        .slice(0, 5),
      parsed: parsed
        ? {
            role: noDash(String(parsed.role || "")),
            org: noDash(String(parsed.org || "")),
            contact_email: String(parsed.contact_email || ""),
            contact_name: noDash(String(parsed.contact_name || "")),
            url: String(parsed.url || ""),
            location: noDash(String(parsed.location || "")),
          }
        : null,
      companyBrief: arr(out.companyBrief, 5),
      mustKnow: arr(out.mustKnow, 4),
      interviewPrep: Array.isArray(out.interviewPrep)
        ? out.interviewPrep
            .map((p: any) => ({
              q: noDash(String(p?.q || "")),
              angle: noDash(String(p?.angle || "")),
            }))
            .filter((p: any) => p.q)
            .slice(0, 5)
        : [],
      isSchool: !!out.isSchool || looksSchool,
      scholarships: Array.isArray(out.scholarships)
        ? out.scholarships
            .map((sc: any) => ({
              name: noDash(String(sc?.name || "")),
              why: noDash(String(sc?.why || "")),
              url: String(sc?.url || ""),
            }))
            .filter((sc: any) => sc.name)
            .slice(0, 6)
        : [],
    });
  } catch (e: any) {
    if (e instanceof ApiCreditError)
      return NextResponse.json({ error: e.message, reason: e.reason }, { status: 402 });
    return NextResponse.json({ error: e?.message || "Research failed." }, { status: 500 });
  }
}
