import { NextRequest, NextResponse } from "next/server";
import { claudeJson, parseJsonLoose, noDash } from "@/lib/claude";
import { ApiCreditError } from "@/lib/apiErrors";
import { withinRateLimit, requestIp } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const maxDuration = 60;

// Cover-letter tailoring with a hard minimal-change doctrine. The user's
// letter is THEIR writing; the model's job is to find the smallest set of
// spot edits that point it at a specific job description, plus flag the
// places that are truly incompatible for the USER to rewrite — never to
// compose new prose wholesale. Returns edit suggestions; the client walks
// the user through accepting, adjusting, or skipping each one.
export async function POST(req: NextRequest) {
  try {
    if (!withinRateLimit(`coverletter:${requestIp(req.headers)}`, 30, 10 * 60 * 1000)) {
      return NextResponse.json({ error: "Slow down a moment." }, { status: 429 });
    }
    const { letter, job, about } = await req.json();
    const letterStr = String(letter || "").trim().slice(0, 12000);
    const jobStr = String(job || "").trim().slice(0, 12000);
    if (!letterStr) return NextResponse.json({ error: "No cover letter." }, { status: 400 });
    if (!jobStr)
      return NextResponse.json({ error: "No job description." }, { status: 400 });
    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json(
        { error: "Missing ANTHROPIC_API_KEY in .env.local." },
        { status: 500 }
      );
    }

    const sys =
      `You tailor a person's existing cover letter to a specific job description with the SMALLEST possible set of ` +
      `edits. Their letter is THEIR OWN writing and voice; you never rewrite it, never add new sentences, never ` +
      `"improve" prose that already works. Return ONLY JSON {"edits": [...], "note": string}.\n` +
      `Each edit: {"original", "suggestion", "why", "severity"}.\n` +
      `- original: an EXACT substring copied character-for-character from the letter (long enough to be unique, short ` +
      `enough to be one focused change — a phrase or one sentence, never a paragraph).\n` +
      `- suggestion: the minimal replacement, reusing the person's own wording wherever possible (swap the company ` +
      `name, the role title, the one skill word — not the sentence around it). For severity "mismatch" where you ` +
      `cannot honestly write the replacement (it depends on facts only they know), make suggestion a bracketed fill-in ` +
      `scaffold in their style, e.g. "[one line: your experience with X from the posting]".\n` +
      `- why: one short plain sentence tying the change to the job description.\n` +
      `- severity: "mismatch" when the original is truly incompatible with this job (names another company or role, ` +
      `claims an interest or skill that contradicts the posting) — these are the ones the person must resolve; ` +
      `"polish" for optional targeted swaps that sharpen fit.\n` +
      `Rules: at most 8 edits total; prefer 3-6. If a passage is generic but fine, LEAVE IT. Never touch greetings or ` +
      `sign-offs unless they name the wrong company or person. Never use em-dashes. note: one sentence on how well the ` +
      `letter already fits (honest, no flattery).`;
    const user =
      `THE PERSON'S COVER LETTER (their writing, change as little as possible):\n${letterStr}\n\n` +
      `THE JOB DESCRIPTION to tailor it to:\n${jobStr}\n\n` +
      (about ? `ABOUT THE PERSON (context only, never invent facts): ${String(about).slice(0, 800)}\n` : "");

    const parsed: any = parseJsonLoose(await claudeJson(sys, user));
    const rawEdits: any[] = Array.isArray(parsed?.edits) ? parsed.edits : [];
    // Only keep edits whose `original` really appears in the letter — a
    // hallucinated span would make the walkthrough point at nothing.
    const edits = rawEdits
      .map((e) => ({
        original: String(e?.original || ""),
        suggestion: noDash(String(e?.suggestion || "")),
        why: noDash(String(e?.why || "")),
        severity: e?.severity === "mismatch" ? "mismatch" : "polish",
      }))
      .filter((e) => e.original && e.suggestion && letterStr.includes(e.original))
      .slice(0, 8);
    return NextResponse.json({ edits, note: noDash(String(parsed?.note || "")) });
  } catch (e: any) {
    if (e instanceof ApiCreditError)
      return NextResponse.json({ error: e.message, reason: e.reason }, { status: 402 });
    return NextResponse.json(
      { error: e?.message || "Tailoring failed." },
      { status: 500 }
    );
  }
}
