import { NextRequest, NextResponse } from "next/server";
import { userIdFromReq, supabaseAdmin } from "@/lib/supabaseAdmin";
import { claudeJson, parseJsonLoose } from "@/lib/claude";

export const runtime = "nodejs";
export const maxDuration = 30;

// Read an imported spreadsheet and gauge how completely Scout understands it —
// what it is, who's been reached out to, what the columns/statuses mean, what's
// done vs pending. Returns an HONEST 0-100 understanding + at most 3 clarifying
// questions. Answers fold back in on the next call to raise understanding.
const SYSTEM =
  "You are Scout, analyzing a spreadsheet a user has been using to track their outreach " +
  "(people/companies they've contacted or plan to). You are given the column headers, a sample " +
  "of rows, and the total row count. Work out what this sheet IS: what each column means, who " +
  "they've been reaching out to, what the status/outcome values signify, and what has been done " +
  "vs. what is pending. Reply with ONLY a JSON object, no prose:\n" +
  '{"summary":"", "understanding":0, "questions":[{"question":"","options":[]}]}\n' +
  "summary = 1-2 sentences on what this sheet is and what it tracks.\n" +
  "understanding = an HONEST integer 0-100 for how completely you understand this sheet well " +
  "enough to import it and learn from it. Base it on real evidence: clear headers + readable " +
  "values + an obvious outcome/status column = HIGH (85-100). Ambiguous columns, cryptic status " +
  "codes, or unclear what success means = LOWER. Do NOT inflate it.\n" +
  "questions = ONLY genuinely ambiguous, decision-CHANGING things: what a cryptic column or " +
  "status value means, which outcomes count as a success/reply, what the goal of this outreach " +
  "was, or whether a column is the person vs. the company. At most 3, each DISTINCT. Each has 2-5 " +
  "short concrete `options` the user can pick from (plus they can type their own). If the sheet " +
  "is already clear, return an empty questions array and a HIGH understanding.";

export async function POST(req: NextRequest) {
  if (supabaseAdmin) {
    const uid = await userIdFromReq(req);
    if (!uid) return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  }
  const { headers, sampleRows, rowCount, useCase, answers, asked } = await req
    .json()
    .catch(() => ({}));
  if (!Array.isArray(headers) || !headers.length) {
    return NextResponse.json({ error: "No columns to read." }, { status: 400 });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    // No key to reason with — don't block the import.
    return NextResponse.json({ understanding: 100, summary: "", questions: [] });
  }

  const sample = (Array.isArray(sampleRows) ? sampleRows : []).slice(0, 15);
  const askedList = (Array.isArray(asked) ? asked : []).map((s: any) => String(s || "")).filter(Boolean);

  const user =
    `Use case: ${String(useCase || "outreach")}\n` +
    `Total rows: ${Number(rowCount) || sample.length}\n` +
    `Columns: ${headers.map((h: any) => String(h)).join(" | ")}\n\n` +
    `Sample rows (JSON):\n${JSON.stringify(sample).slice(0, 6000)}\n\n` +
    (answers
      ? `The user has already told you: ${String(answers)}\nRaise understanding accordingly and do NOT ask anything they've answered.\n`
      : "") +
    (askedList.length
      ? `Already asked (do not repeat or overlap): ${askedList.join(" | ")}\n`
      : "");

  try {
    const raw = await claudeJson(SYSTEM, user, 900);
    const parsed = parseJsonLoose<any>(raw) || {};
    const understanding = Math.max(0, Math.min(100, Math.round(Number(parsed.understanding)) || 0));
    const questions = Array.isArray(parsed.questions)
      ? parsed.questions
          .map((q: any) => ({
            question: String(q?.question || "").trim(),
            options: Array.isArray(q?.options)
              ? q.options.map((o: any) => String(o || "").trim()).filter(Boolean).slice(0, 5)
              : [],
          }))
          .filter((q: any) => q.question)
          .slice(0, 3)
      : [];
    return NextResponse.json({
      understanding,
      summary: String(parsed.summary || "").trim(),
      questions,
    });
  } catch (e: any) {
    // On any model error, don't block importing — treat it as understood.
    return NextResponse.json({ understanding: 100, summary: "", questions: [] });
  }
}
