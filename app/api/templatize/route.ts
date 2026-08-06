import { NextRequest, NextResponse } from "next/server";
import { claudeJson, parseJsonLoose } from "@/lib/claude";
import { ApiCreditError } from "@/lib/apiErrors";

export const runtime = "nodejs";
export const maxDuration = 45; // one Claude pass over a single pasted message

// Turn a real, already-sent message into a reusable template. The sender pastes
// an email/DM they actually wrote to one specific person; Scout strips out every
// detail tied to THAT recipient (their name, company, the specific thing that was
// complimented, dates, one-off shared context) and swaps in bracketed placeholders
// the drafting engine already knows how to fill per recipient, while keeping the
// sender's own voice, structure, greeting, sign-off, and what they say they offer.
const SYS = `You convert a real outreach message into a reusable TEMPLATE.

The user pastes a message they already sent to ONE specific person. Your job is to
strip out everything that was specific to that one recipient and that one moment, so
the result works as a skeleton the sender can reuse for anyone, while sounding exactly
like the same person wrote it.

REMOVE / GENERALIZE (replace with a clear bracketed placeholder):
- The recipient's name -> [first name]
- Their company, band, outlet, team, school, or publication -> [company]
- The specific thing you praised about THEM (a specific song, article, launch, project,
  post, award, event they did) -> [specific detail about their work]
- Any specific date, deadline, city, or one-off event unique to that message -> a
  placeholder like [date], [city], or [event]
- Any other fact true only for that one recipient -> a short bracketed placeholder that
  names what goes there.

KEEP EXACTLY AS-IS:
- The sender's voice, tone, warmth, rhythm, and word choices.
- The overall structure: greeting, the order of the paragraphs, the ask, the sign-off.
- Anything about what the SENDER does, offers, or is asking for that stays the same from
  message to message (that is the sender's identity, not recipient-specific).
- The sender's own name in the sign-off if present.

RULES:
- Do NOT invent new sentences or change the meaning. Only genericize the recipient-specific
  parts; leave everything else word-for-word.
- Use square-bracket placeholders like [first name], [company], [specific detail about their
  work]. Each placeholder should name what belongs there in plain words.
- Keep it roughly the same length. Do not summarize or shorten the writing.
- If the pasted text is already generic (no recipient-specific details), return it essentially
  unchanged.
- Preserve line breaks and paragraph structure.

Return ONLY JSON: {"template": "the reusable template text with placeholders"}`;

export async function POST(req: NextRequest) {
  try {
    const { text, channel } = await req.json();
    const raw = String(text || "").trim();
    if (!raw) {
      return NextResponse.json({ error: "Paste an email or message first." }, { status: 400 });
    }
    if (raw.length < 40) {
      return NextResponse.json(
        { error: "That's too short to templatize. Paste a full message." },
        { status: 400 }
      );
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json(
        { error: "Missing ANTHROPIC_API_KEY in .env.local." },
        { status: 500 }
      );
    }

    const kind = String(channel || "Email").slice(0, 40);
    const user = `Kind of outreach: ${kind}\n\nPasted message to templatize:\n"""\n${raw.slice(
      0,
      6000
    )}\n"""`;

    const out = await claudeJson(SYS, user, 1600);
    const parsed = parseJsonLoose<{ template?: string }>(out);
    const template = (parsed?.template || "").trim();
    if (!template) {
      return NextResponse.json(
        { error: "Couldn't build a template from that. Try again." },
        { status: 502 }
      );
    }
    return NextResponse.json({ template });
  } catch (e: any) {
    if (e instanceof ApiCreditError) {
      return NextResponse.json({ error: e.message }, { status: 402 });
    }
    return NextResponse.json(
      { error: e?.message || "Something went wrong." },
      { status: 500 }
    );
  }
}
