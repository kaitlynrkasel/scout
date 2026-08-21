import { NextRequest, NextResponse } from "next/server";
import { withinRateLimit, requestIp } from "@/lib/rateLimit";
import { claudeJson, parseJsonLoose } from "@/lib/claude";
import { ApiCreditError } from "@/lib/apiErrors";

export const runtime = "nodejs";
export const maxDuration = 30;

// Split a resume / CV / LinkedIn dump / bio into the sections it already has,
// so the profile can show one labelled box per section instead of a single wall
// of text. This SPLITS, it never writes: every character of the original has to
// come back out under one heading or another, unchanged. A profile that quietly
// paraphrased someone's resume would feed that paraphrase into every search and
// every draft, so verbatim is a correctness requirement, not a style preference.
export async function POST(req: NextRequest) {
  // Open to pre-login flows by design, so the guard is per-IP rate
  // limiting: without it this endpoint spends our API money for anyone
  // who curls it in a loop.
  if (!withinRateLimit(`resume:${requestIp(req.headers)}`, 20, 10 * 60 * 1000)) {
    return NextResponse.json({ error: "Slow down a moment." }, { status: 429 });
  }
  try {
    const { text } = await req.json();
    const t = String(text || "").slice(0, 20000);
    if (!t.trim()) {
      return NextResponse.json({ error: "No text to split." }, { status: 400 });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json({ sections: [] });
    }

    const sys =
      "You split a resume, CV, LinkedIn export, or personal bio into its sections. " +
      'Return ONLY JSON: {"sections":[{"label":string,"text":string}]}.\n\n' +
      "HARD RULE: copy the text VERBATIM. Do not summarise, reword, reorder, translate, " +
      "fix typos, expand abbreviations, or add anything. Every line of the input must appear " +
      "in exactly one section, in its original order. If you are unsure where a line belongs, " +
      "leave it where it already sits rather than moving it.\n\n" +
      "label = the section's own heading when the document has one, copied as written but in " +
      'Sentence case ("EXPERIENCE" becomes "Experience"). When a block has no heading, give it ' +
      'the plainest accurate one: "Contact" for a name and contact details, "Summary" for an ' +
      'opening paragraph about the person, "Other" only as a last resort. Do not repeat the ' +
      "heading inside that section's text.\n\n" +
      "Keep the document's own sections; do not invent a structure it does not have. A resume " +
      "with Experience, Education, and Skills returns exactly those three (plus Contact if the " +
      "header block is there). Merge nothing; split nothing further than the document does. " +
      "Drop a section that would be empty. Never use em-dashes in a label.";

    const parsed: any = parseJsonLoose(await claudeJson(sys, `DOCUMENT:\n${t}`, 8000));
    const raw = Array.isArray(parsed?.sections) ? parsed.sections : [];
    const sections = raw
      .map((s: any) => ({
        label: String(s?.label || "").trim().slice(0, 60),
        text: String(s?.text || "").replace(/\r/g, "").trim(),
      }))
      .filter((s: any) => s.label && s.text);

    // If the split lost or invented a meaningful amount of the document, the
    // result is worse than the wall it replaced, so return nothing and let the
    // caller keep what it had. Compared on letters and digits only, so
    // whitespace and heading punctuation don't trip it.
    const sig = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const before = sig(t);
    const after = sig(sections.map((s: any) => s.text).join(""));
    const ok =
      sections.length > 1 &&
      before.length > 0 &&
      after.length >= before.length * 0.9 &&
      after.length <= before.length * 1.05;

    return NextResponse.json({ sections: ok ? sections : [] });
  } catch (e: any) {
    if (e instanceof ApiCreditError) {
      return NextResponse.json(
        { error: e.userMessage(), credit: true, provider: e.provider, reason: e.reason },
        { status: 402 }
      );
    }
    return NextResponse.json({ sections: [] });
  }
}
