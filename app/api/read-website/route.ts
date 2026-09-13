import { NextRequest, NextResponse } from "next/server";
import { withinRateLimit, requestIp } from "@/lib/rateLimit";
import { readSite, ReadSiteError } from "@/lib/readSite";

export const runtime = "nodejs";
export const maxDuration = 20;

// Fetch a company's web presence and return its readable text, so a company can
// fill their profile from their site. Accepts a real website OR a social link
// (Instagram, TikTok, LinkedIn, Facebook…) — socials serve bots a login wall, so
// for those (and empty JS-shell sites) lib/readSite falls back to searching the
// public web ABOUT the company instead.
export async function POST(req: NextRequest) {
  // Cost-bearing and reachable before login (guest mode), so the guard is
  // per-IP rate limiting, same as the other open-by-design endpoints.
  if (!withinRateLimit(`readwebsite:${requestIp(req.headers)}`, 30, 10 * 60 * 1000)) {
    return NextResponse.json({ error: "Slow down a moment." }, { status: 429 });
  }
  try {
    const raw = String((await req.json())?.url || "").trim();
    const site = await readSite(raw);
    return NextResponse.json({ title: site.title, text: site.text, url: site.url, viaSearch: site.viaSearch });
  } catch (e: any) {
    const status = e instanceof ReadSiteError ? e.status : 500;
    return NextResponse.json(
      { error: e?.message || "Couldn't read that site." },
      { status }
    );
  }
}
