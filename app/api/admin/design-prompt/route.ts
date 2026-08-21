import { NextRequest, NextResponse } from "next/server";
import { userFromReq } from "@/lib/supabaseAdmin";
import { isOwnerEmail } from "@/lib/owner";
import { claudeJson, parseJsonLoose, noDash } from "@/lib/claude";
import { ApiCreditError } from "@/lib/apiErrors";

export const runtime = "nodejs";
export const maxDuration = 30;

// Owner-only: turn a plain-English design instruction ("warmer", "more like a
// bank", "make the accent orange and everything softer") into a concrete
// token proposal the Design page can preview. Returns ONLY values the preview
// knows how to render, so every proposal is visible before anyone implements
// anything.
export async function POST(req: NextRequest) {
  const me = await userFromReq(req);
  if (!me || !isOwnerEmail(me.email)) {
    return NextResponse.json({ error: "Not authorized." }, { status: 403 });
  }
  try {
    const { prompt, scheme, rainbow } = await req.json();
    const p = String(prompt || "").trim().slice(0, 600);
    if (!p) return NextResponse.json({ error: "Say what should change." }, { status: 400 });
    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json({ error: "Missing ANTHROPIC_API_KEY." }, { status: 500 });
    }

    const sys =
      "You are the design lead for Scout, a warm, editorial outreach tool. Given its current " +
      "color tokens and one instruction, propose new tokens.\n" +
      'Return ONLY JSON: {"scheme": {<same keys as given, hex values>}, "rainbow": [6 hex], "summary": string}.\n' +
      "Rules: keep every scheme key that was given, change only what the instruction calls for, " +
      "keep sufficient contrast (the stage token must carry light text, the canvas dark text), " +
      "nothing neon unless asked, and the work-area token stays a slightly darker relative of the " +
      "stage token. summary = one plain sentence of what changed and why, no em dashes.";
    const user = `CURRENT SCHEME: ${JSON.stringify(scheme)}\nCURRENT RAINBOW: ${JSON.stringify(
      rainbow
    )}\nINSTRUCTION: ${p}`;
    const parsed: any = parseJsonLoose(await claudeJson(sys, user, 700));
    const hex = /^#[0-9a-f]{6}$/i;
    const outScheme: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed?.scheme || {})) {
      if (typeof v === "string" && hex.test(v.trim())) outScheme[k] = v.trim().toLowerCase();
    }
    const outRainbow = (Array.isArray(parsed?.rainbow) ? parsed.rainbow : [])
      .filter((c: any) => typeof c === "string" && hex.test(c.trim()))
      .map((c: string) => c.trim().toLowerCase())
      .slice(0, 6);
    if (Object.keys(outScheme).length < 3) {
      return NextResponse.json(
        { error: "Could not turn that into a concrete scheme. Try more specific wording." },
        { status: 422 }
      );
    }
    return NextResponse.json({
      scheme: outScheme,
      rainbow: outRainbow.length === 6 ? outRainbow : null,
      summary: noDash(String(parsed?.summary || "")).slice(0, 300),
    });
  } catch (e: any) {
    if (e instanceof ApiCreditError) {
      return NextResponse.json({ error: e.userMessage() }, { status: 402 });
    }
    return NextResponse.json({ error: e?.message || "Failed." }, { status: 500 });
  }
}
