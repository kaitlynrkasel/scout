import { NextRequest, NextResponse } from "next/server";
import { readSite, ReadSiteError } from "@/lib/readSite";
import { claudeJson, parseJsonLoose, noDash } from "@/lib/claude";
import { ApiCreditError } from "@/lib/apiErrors";

export const runtime = "nodejs";
export const maxDuration = 30;


// Read a company's website and pull out what Scout needs for the onboarding
// questionnaire: the company name, what it does, and its industry. Best-effort;
// blanks anything it can't find. A website is never required (some companies
// don't have one) — this just fills the form when there is one.
export async function POST(req: NextRequest) {
  try {
    const raw = String((await req.json())?.url || "").trim();
    let site;
    try {
      site = await readSite(raw);
    } catch (e: any) {
      const status = e instanceof ReadSiteError ? e.status : 500;
      return NextResponse.json({ error: e?.message || "Couldn't read that site." }, { status });
    }
    const title = site.title;
    const metaDesc = "";
    const text = site.text;
    const pageLabel = site.viaSearch
      ? "PUBLIC WEB RESULTS ABOUT THE COMPANY (their own site wasn't readable — these are search results about them; extract only what's clearly about THIS company)"
      : "PAGE TEXT";

    const sys =
      "You read a company's own website and extract a few onboarding fields for an outreach tool. Return ONLY a JSON " +
      "object, no prose. Never invent facts; leave a field as an empty string if the site doesn't support it. Prefer " +
      "filling every field you reasonably can from the page over leaving blanks, but base it on real evidence. No em-dashes.\n\n" +
      "name = the company's name (from the title, logo text, or copyright line). Empty if genuinely unclear.\n" +
      "about = 1 to 2 plain sentences on what the company actually does — who they serve and what they offer — as the " +
      "company would describe itself. Concrete, not marketing fluff.\n" +
      "industry = a short label for the company's industry or category (e.g. 'Music', 'Commercial real estate', " +
      "'Marketing agency', 'Coffee / hospitality'). Empty if unclear.";
    const user =
      `Fields: name (string), about (string), industry (string).\n\n` +
      `URL: ${site.url || raw}\nTitle: ${title}\nMeta description: ${metaDesc}\n\n${pageLabel}:\n${text}`;

    const parsed = parseJsonLoose(await claudeJson(sys, user));
    return NextResponse.json({
      name: noDash(String(parsed?.name || "").trim()),
      about: noDash(String(parsed?.about || "").trim()),
      industry: noDash(String(parsed?.industry || "").trim()),
    });
  } catch (e: any) {
    if (e instanceof ApiCreditError) {
      return NextResponse.json({ error: e.userMessage(), credit: true }, { status: 402 });
    }
    return NextResponse.json(
      { error: e?.message || "Couldn't read that site." },
      { status: 500 }
    );
  }
}
