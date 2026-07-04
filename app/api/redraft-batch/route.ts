import { NextRequest, NextResponse } from "next/server";
import { reviseDraft } from "@/lib/draft";
import { ApiCreditError } from "@/lib/apiErrors";
import type { Draft } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 120;

// Apply ONE free-text instruction ("make it shorter", "more casual", "mention
// I'm a recent grad") across every draft currently shown, in a single pass —
// the chat box above the Messages list. Revises subject/body only; every
// other field on the draft (to, channelType, whyItFits, attachResume) is
// carried through unchanged.
export async function POST(req: NextRequest) {
  try {
    const { drafts, instruction, about } = await req.json();
    const list: Draft[] = Array.isArray(drafts) ? drafts : [];
    const ins = String(instruction || "").trim();
    if (!list.length) {
      return NextResponse.json({ error: "No drafts to revise." }, { status: 400 });
    }
    if (!ins) {
      return NextResponse.json({ error: "Say how you'd like these rewritten." }, { status: 400 });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json(
        { error: "Missing ANTHROPIC_API_KEY in .env.local." },
        { status: 500 }
      );
    }
    const revised = await Promise.all(
      list.slice(0, 8).map(async (d) => {
        const { subject, body } = await reviseDraft(
          d.subject || "",
          d.body || "",
          d.channelType,
          ins,
          String(about || ""),
          d.to || ""
        );
        return { ...d, subject, body };
      })
    );
    return NextResponse.json({ drafts: revised });
  } catch (e: any) {
    if (e instanceof ApiCreditError) {
      return NextResponse.json(
        { error: e.userMessage(), credit: true, provider: e.provider, reason: e.reason },
        { status: 402 }
      );
    }
    return NextResponse.json({ error: e?.message || "Couldn't revise those drafts." }, { status: 500 });
  }
}
