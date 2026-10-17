import { NextRequest, NextResponse } from "next/server";
import { claudeJson, parseJsonLoose } from "@/lib/claude";
import { ApiCreditError } from "@/lib/apiErrors";
import { userFromReq } from "@/lib/supabaseAdmin";
import { withinRateLimit } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const maxDuration = 30;

// Preview of a template's «flex spans» for ONE find: returns just the
// replacement for each marked span, so the UI can show the template with the
// swaps highlighted before the user commits to drafting. Unmarked text never
// passes through the model, so it cannot drift.
const SYS = `You fill in the adaptable parts of an outreach template for one recipient.

You get the template's ADAPTABLE SPANS (numbered) and facts about the recipient. For each
span, write the replacement that fits THIS recipient precisely: use their real names
(the playlist's actual title, the outlet's name, the specific show), keep roughly the
same length and grammatical role so it drops into the sentence cleanly, and keep the
sender's casual or formal register. Use only facts given; if nothing specific is known
for a span, return it unchanged.

Return ONLY JSON: {"spans": ["replacement for span 1", "replacement for span 2", ...]}`;

export async function POST(req: NextRequest) {
  try {
    const u = await userFromReq(req);
    if (!u) {
      return NextResponse.json({ error: "Sign in to preview." }, { status: 401 });
    }
    if (!withinRateLimit(`flex:${u.id}`, 60, 60 * 60 * 1000)) {
      return NextResponse.json({ error: "Too many previews this hour." }, { status: 429 });
    }
    const { template, find } = await req.json();
    const text = String(template || "").slice(0, 6000);
    const spans = Array.from(text.matchAll(/«([^»]*)»/g)).map((m) => m[1]).slice(0, 12);
    if (!spans.length) return NextResponse.json({ spans: [] });

    const f = find || {};
    const facts = [
      f.name && `Name: ${f.name}`,
      f.outlet && `Organization: ${f.outlet}`,
      f.role && `Role: ${f.role}`,
      f.why && `Why they fit: ${String(f.why).slice(0, 900)}`,
      Array.isArray(f.criteria) &&
        f.criteria.length &&
        `Details: ${f.criteria
          .slice(0, 6)
          .map((c: any) => `${c.ask} ${c.answer}`)
          .join("; ")}`,
    ]
      .filter(Boolean)
      .join("\n");

    const user =
      `TEMPLATE (for context):\n"""\n${text}\n"""\n\n` +
      `ADAPTABLE SPANS:\n${spans.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n\n` +
      `RECIPIENT:\n${facts || "(no details)"}`;
    const out = await claudeJson(SYS, user, 500);
    const parsed = parseJsonLoose<{ spans?: string[] }>(out);
    const got = Array.isArray(parsed?.spans) ? parsed!.spans : [];
    return NextResponse.json({
      spans: spans.map((s, i) => String(got[i] ?? s).replace(/[«»]/g, "").trim() || s),
    });
  } catch (e: any) {
    if (e instanceof ApiCreditError) {
      return NextResponse.json({ error: e.message }, { status: 402 });
    }
    return NextResponse.json({ error: e?.message || "Preview failed." }, { status: 500 });
  }
}
