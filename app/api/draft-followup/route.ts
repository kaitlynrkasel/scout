import { NextRequest, NextResponse } from "next/server";
import { claudeJson, parseJsonLoose, noDash } from "@/lib/claude";
import { ApiCreditError } from "@/lib/apiErrors";
import type { Opportunity } from "@/lib/types";

export const maxDuration = 30;

// Write a short, kind follow-up nudge for a message that got no reply. When the
// original went out over email, this is phrased as an in-thread reply.
export async function POST(req: NextRequest) {
  try {
    const { opp, about, useCase, firstMessage, inThread } = await req.json();
    const o: Opportunity = opp || {};
    if (!o.name) {
      return NextResponse.json({ error: "Nothing to follow up on." }, { status: 400 });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json(
        { error: "Missing ANTHROPIC_API_KEY in .env.local." },
        { status: 500 }
      );
    }

    const sys =
      `You write a SINGLE short follow-up nudge to someone who hasn't replied to an earlier outreach message. ` +
      `Voice: warm, genuine, first person, never pushy or guilt-trippy. ` +
      `NEVER use em-dashes or en-dashes; use commas and periods. ` +
      `Rules for a good follow-up: keep it to 2 to 4 sentences, acknowledge they're busy, briefly restate the ask in one line, ` +
      `add a small new reason to reply or make the ask even easier, and give them an easy out. Do NOT repeat the whole first ` +
      `message. Do NOT fabricate anything about the sender or recipient. ` +
      (inThread
        ? `This is a REPLY in the same email thread, so do not reintroduce yourself from scratch; write like a brief nudge on top of the earlier note. `
        : `This is a fresh short message. `) +
      `Return ONLY JSON {subject, body}. ${
        inThread
          ? 'subject should be the original subject prefixed with "Re: " (or empty if none).'
          : "subject = a short, low-key line."
      }`;

    const user =
      `RECIPIENT: ${o.name}` +
      (o.outlet ? ` at ${o.outlet}` : "") +
      `.\nWHY THEY WERE CONTACTED: ${o.whyItFits || "(general outreach)"}\n` +
      `ABOUT THE SENDER: ${String(about || "")}\n` +
      `USE CASE: ${String(useCase || "")}\n\n` +
      `THE FIRST MESSAGE (already sent, do not repeat it, just nudge on top of it):\n` +
      (firstMessage
        ? `Subject: ${firstMessage.subject || ""}\n${firstMessage.body || ""}`
        : "(not available)");

    let gen: any = null;
    try {
      gen = parseJsonLoose(await claudeJson(sys, user));
    } catch (e) {
      if (e instanceof ApiCreditError) throw e;
      gen = null;
    }

    const subject = noDash(gen?.subject || "");
    const body = noDash(gen?.body || "");
    if (!body) {
      return NextResponse.json(
        { error: "Couldn't write a follow-up. Try again." },
        { status: 502 }
      );
    }
    return NextResponse.json({ subject, body });
  } catch (e: any) {
    if (e instanceof ApiCreditError) {
      return NextResponse.json(
        { error: e.userMessage(), credit: true, provider: e.provider, reason: e.reason },
        { status: 402 }
      );
    }
    return NextResponse.json(
      { error: e?.message || "Follow-up drafting failed." },
      { status: 500 }
    );
  }
}
