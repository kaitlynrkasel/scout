import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 20;

// Strip a page down to readable text.
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

// Fetch a company website and return its readable text, so a company can fill
// their profile from their site instead of a resume.
export async function POST(req: NextRequest) {
  try {
    let raw = String((await req.json())?.url || "").trim();
    if (!raw) {
      return NextResponse.json({ error: "Enter your website address." }, { status: 400 });
    }
    if (!/^https?:\/\//i.test(raw)) raw = "https://" + raw;

    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return NextResponse.json({ error: "That doesn't look like a valid website." }, { status: 400 });
    }
    // Basic guard against pointing this at internal/local addresses.
    if (
      !/^https?:$/.test(u.protocol) ||
      /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|\[)/i.test(u.hostname)
    ) {
      return NextResponse.json({ error: "That address isn't allowed." }, { status: 400 });
    }

    const r = await fetch(u.toString(), {
      headers: { "user-agent": "Mozilla/5.0 (compatible; ScoutBot/1.0)" },
      redirect: "follow",
    });
    if (!r.ok) {
      return NextResponse.json(
        { error: `Couldn't reach that site (${r.status}).` },
        { status: 400 }
      );
    }
    const html = await r.text();
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? stripHtml(titleMatch[1]) : "";
    const text = stripHtml(html).slice(0, 8000);
    if (!text) {
      return NextResponse.json(
        { error: "That page had no readable text. Try pasting your info instead." },
        { status: 400 }
      );
    }
    return NextResponse.json({ title, text, url: u.toString() });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || "Couldn't read that site." },
      { status: 500 }
    );
  }
}
