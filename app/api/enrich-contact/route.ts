import { NextRequest, NextResponse } from "next/server";
import { tavilySearch } from "@/lib/tavily";
import { claudeJson, parseJsonLoose, noDash } from "@/lib/claude";
import { ApiCreditError } from "@/lib/apiErrors";
import { withinRateLimit, requestIp } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const maxDuration = 45;

// Autofill for the Add-a-contact form: given whatever the user has typed
// (usually just a name, maybe an email or org), search the public web and
// pull out the REST — role, organization, profile link, website, location.
// Facts only: anything the evidence doesn't show comes back empty, and the
// client only fills fields the user left blank.
export async function POST(req: NextRequest) {
  try {
    if (!withinRateLimit(`enrich:${requestIp(req.headers)}`, 30, 10 * 60 * 1000)) {
      return NextResponse.json({ error: "Slow down a moment." }, { status: 429 });
    }
    const { name, email, outlet } = await req.json();
    const nm = String(name || "").trim();
    if (!nm) return NextResponse.json({ error: "Give them at least a name." }, { status: 400 });
    if (!process.env.ANTHROPIC_API_KEY || !process.env.TAVILY_API_KEY) {
      return NextResponse.json({ error: "Missing API keys." }, { status: 500 });
    }
    const org = String(outlet || "").trim();
    const em = String(email || "").trim();
    // The email's domain is a strong disambiguator for common names.
    const domain = em.includes("@") ? em.split("@")[1] : "";
    const freemail = /^(gmail|yahoo|outlook|hotmail|icloud|aol|proton)\./i.test(domain);

    const q1 = [`"${nm}"`, org, !freemail && domain ? domain : "", "about OR bio OR role"]
      .filter(Boolean)
      .join(" ");
    const q2 = `"${nm}" ${org} linkedin OR instagram OR site`;
    const [h1, h2] = await Promise.all([
      tavilySearch(q1, 5).catch(() => []),
      tavilySearch(q2, 4).catch(() => []),
    ]);
    const evidence = [...h1, ...h2]
      .map((h: any) => `- ${h.title}\n  ${h.url}\n  ${String(h.content || "").slice(0, 350)}`)
      .join("\n");
    if (!evidence) return NextResponse.json({ fields: {} });

    const sys =
      `Fill in a contact card from web evidence about one specific person or organization. Return ONLY JSON ` +
      `{"outlet","role","handle","website","location","note"}. Copy facts the EVIDENCE shows about the person the ` +
      `user means (match the name; when an email domain or organization is given, it must agree); empty string for ` +
      `anything unsupported or ambiguous — never guess, never merge two different people. handle: their public ` +
      `profile URL or @handle (LinkedIn/Instagram). website: their own or their organization's site. note: ONE short ` +
      `factual line worth working into outreach (a recent project, what they do), or empty. No em-dashes.`;
    const user =
      `NAME: ${nm}\n` +
      (org ? `ORGANIZATION (user-typed): ${org}\n` : "") +
      (em ? `EMAIL: ${em}\n` : "") +
      `\nEVIDENCE:\n${evidence}`;
    const out: any = parseJsonLoose(await claudeJson(sys, user)) || {};
    return NextResponse.json({
      fields: {
        outlet: noDash(String(out.outlet || "")).slice(0, 120),
        role: noDash(String(out.role || "")).slice(0, 120),
        handle: String(out.handle || "").slice(0, 200),
        website: String(out.website || "").slice(0, 200),
        location: noDash(String(out.location || "")).slice(0, 120),
        note: noDash(String(out.note || "")).slice(0, 300),
      },
    });
  } catch (e: any) {
    if (e instanceof ApiCreditError)
      return NextResponse.json({ error: e.message, reason: e.reason }, { status: 402 });
    return NextResponse.json({ error: e?.message || "Autofill failed." }, { status: 500 });
  }
}
