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
    const { prompt, scheme, rainbow, style } = await req.json();
    const p = String(prompt || "").trim().slice(0, 600);
    if (!p) return NextResponse.json({ error: "Say what should change." }, { status: 400 });
    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json({ error: "Missing ANTHROPIC_API_KEY." }, { status: 500 });
    }

    const sys =
      "You are the design lead for Scout, a warm, editorial outreach tool. Given its current " +
      "design tokens and one instruction, propose changes. The instruction may be about ANY part " +
      "of design: color, type, spacing, size, shape, layout.\n" +
      'Return ONLY JSON: {"scheme": {<same keys as given, hex>}, "rainbow": [6 hex], ' +
      '"style": {"radiusPx": number 4-24, "spacing": "compact"|"cozy"|"roomy", "navIconPx": number 16-30, ' +
      '"displayWeight": 600|700|800, "buttonShape": "pill"|"rounded", "shadow": "none"|"soft"|"strong"}, ' +
      '"notes": [strings], "summary": string}.\n' +
      "Rules: change only what the instruction calls for; return scheme/rainbow/style keys even when " +
      "unchanged (echo the current values). Colors: keep contrast (the stage token carries light text, " +
      "the canvas dark text), nothing neon unless asked, work area a darker relative of the stage. " +
      "notes = every part of the instruction the tokens above CANNOT express (a moved section, a new " +
      "element, wording), phrased as concrete engineering instructions; empty array when the tokens " +
      "cover it fully. summary = one plain sentence of what changed. Never use an em dash.";
    const user = `CURRENT SCHEME: ${JSON.stringify(scheme)}\nCURRENT RAINBOW: ${JSON.stringify(
      rainbow
    )}\nCURRENT STYLE: ${JSON.stringify(style || {})}\nINSTRUCTION: ${p}`;
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
    // Style tokens, validated to the preview's vocabulary.
    const st = parsed?.style || {};
    const clampN = (v: any, lo: number, hi: number, dflt: number) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt;
    };
    const outStyle = {
      radiusPx: clampN(st.radiusPx, 4, 24, 16),
      spacing: ["compact", "cozy", "roomy"].includes(st.spacing) ? st.spacing : "cozy",
      navIconPx: clampN(st.navIconPx, 16, 30, 21),
      displayWeight: [600, 700, 800].includes(Number(st.displayWeight))
        ? Number(st.displayWeight)
        : 700,
      buttonShape: ["pill", "rounded"].includes(st.buttonShape) ? st.buttonShape : "pill",
      shadow: ["none", "soft", "strong"].includes(st.shadow) ? st.shadow : "soft",
    };
    const notes = (Array.isArray(parsed?.notes) ? parsed.notes : [])
      .map((n: any) => noDash(String(n || "")).trim())
      .filter(Boolean)
      .slice(0, 6);
    return NextResponse.json({
      scheme: Object.keys(outScheme).length >= 3 ? outScheme : null,
      rainbow: outRainbow.length === 6 ? outRainbow : null,
      style: outStyle,
      notes,
      summary: noDash(String(parsed?.summary || "")).slice(0, 300),
    });
  } catch (e: any) {
    if (e instanceof ApiCreditError) {
      return NextResponse.json({ error: e.userMessage() }, { status: 402 });
    }
    return NextResponse.json({ error: e?.message || "Failed." }, { status: 500 });
  }
}
