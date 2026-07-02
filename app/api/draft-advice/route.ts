import { NextRequest, NextResponse } from "next/server";
import { claudeJson, parseJsonLoose } from "@/lib/claude";
import { ApiCreditError } from "@/lib/apiErrors";

export const runtime = "nodejs";
export const maxDuration = 30;

// Read the user's own recent drafts and coach them on their actual writing —
// specific observations about THESE messages, not generic outreach tips.
export async function POST(req: NextRequest) {
  try {
    const { drafts } = await req.json();
    const list = (Array.isArray(drafts) ? drafts : [])
      .slice(0, 8)
      .map((d: any) => ({
        channel: String(d?.channel || "email"),
        outcome: d?.outcome === "sent" ? "sent" : "drafted, not sent yet",
        subject: String(d?.subject || "").slice(0, 200),
        body: String(d?.body || "").slice(0, 1500),
      }))
      .filter((d) => d.body.trim());
    if (!list.length) {
      return NextResponse.json(
        { error: "No drafts to review yet. Draft a few messages first." },
        { status: 400 }
      );
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json(
        { error: "Missing ANTHROPIC_API_KEY in .env.local." },
        { status: 500 }
      );
    }

    const sys =
      "You are a warm, sharp outreach coach reviewing someone's real messages. " +
      "Return ONLY a JSON object {\"tips\": [{\"title\": string, \"advice\": string}]} with 3 to 5 tips. " +
      "Every tip must come from patterns you actually see in THESE drafts — quote or reference " +
      "short phrases from them so the person can see exactly what you mean. Point out what's working, " +
      "not just problems. Skip generic advice (be personal, keep it short, soft ask) UNLESS a draft " +
      "actually violates it, and then show where. Never use em-dashes. Keep each tip to 2-3 sentences.";

    const user =
      "Here are my recent outreach drafts (with whether I ended up sending them). What should I know about my writing?\n\n" +
      list
        .map(
          (d, i) =>
            `--- Draft ${i + 1} [${d.channel}, ${d.outcome}] ---\n` +
            (d.subject ? `Subject: ${d.subject}\n` : "") +
            d.body
        )
        .join("\n\n");

    const parsed: any = parseJsonLoose(await claudeJson(sys, user));
    const tips = (Array.isArray(parsed?.tips) ? parsed.tips : [])
      .slice(0, 5)
      .map((t: any) => ({
        title: String(t?.title || "").slice(0, 120),
        advice: String(t?.advice || "").slice(0, 600),
      }))
      .filter((t: any) => t.title && t.advice);
    if (!tips.length) {
      return NextResponse.json(
        { error: "Couldn't produce advice this time. Try again." },
        { status: 502 }
      );
    }
    return NextResponse.json({ tips, reviewed: list.length });
  } catch (e: any) {
    if (e instanceof ApiCreditError) {
      return NextResponse.json(
        { error: e.userMessage(), credit: true, provider: e.provider, reason: e.reason },
        { status: 402 }
      );
    }
    return NextResponse.json(
      { error: e?.message || "Couldn't review the drafts." },
      { status: 500 }
    );
  }
}
