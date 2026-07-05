import { NextRequest, NextResponse } from "next/server";
import { claudeJson, parseJsonLoose, noDash } from "@/lib/claude";
import { ApiCreditError } from "@/lib/apiErrors";

export const runtime = "nodejs";
export const maxDuration = 30;

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

// Read a company's website and pull out what Scout needs for the onboarding
// questionnaire: the company name, what it does, and its industry. Best-effort;
// blanks anything it can't find. A website is never required (some companies
// don't have one) — this just fills the form when there is one.
export async function POST(req: NextRequest) {
  try {
    let raw = String((await req.json())?.url || "").trim();
    if (!raw) return NextResponse.json({ error: "Enter your website address." }, { status: 400 });
    if (!/^https?:\/\//i.test(raw)) raw = "https://" + raw;

    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return NextResponse.json({ error: "That doesn't look like a valid website." }, { status: 400 });
    }
    if (
      !/^https?:$/.test(u.protocol) ||
      /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|\[)/i.test(u.hostname)
    ) {
      return NextResponse.json({ error: "That address isn't allowed." }, { status: 400 });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json({ error: "Missing ANTHROPIC_API_KEY." }, { status: 500 });
    }

    let html: string;
    try {
      const r = await fetch(u.toString(), {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(12000),
      });
      if (!r.ok) {
        return NextResponse.json(
          { error: `Couldn't reach that site (${r.status}). You can fill it in by hand.` },
          { status: 400 }
        );
      }
      html = await r.text();
    } catch {
      return NextResponse.json(
        { error: "Couldn't reach that site. You can fill it in by hand." },
        { status: 400 }
      );
    }

    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? stripHtml(titleMatch[1]) : "";
    const descMatch = html.match(
      /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i
    );
    const metaDesc = descMatch ? stripHtml(descMatch[1]) : "";
    const text = stripHtml(html).slice(0, 8000);
    if (!text) {
      return NextResponse.json(
        { error: "That page had no readable text. You can fill it in by hand." },
        { status: 400 }
      );
    }

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
      `URL: ${u.toString()}\nTitle: ${title}\nMeta description: ${metaDesc}\n\nPAGE TEXT:\n${text}`;

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
