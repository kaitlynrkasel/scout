import { NextRequest, NextResponse } from "next/server";
import { claudeJson, noDash } from "@/lib/claude";
import { ApiCreditError } from "@/lib/apiErrors";

export const runtime = "nodejs";
export const maxDuration = 60; // fetch the page + one Claude pass

// Ask a question about ONE find, answered from that find's own page and the
// evidence Scout already collected — so "does this internship need football
// experience?" gets answered here instead of sending the user off to read the
// posting themselves.
//
// The whole point is that the answer is grounded. The model is given the page
// text and the find record and nothing else, and is told to say plainly when
// the source doesn't cover it rather than reasoning from what postings like
// this usually say.

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

// Block internal/local addresses before fetching a stored URL (same guard the
// deep scan uses — the URL came from a model and a page, not from us).
function safeUrl(raw: string): URL | null {
  let s = String(raw || "").trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (
    !/^https?:$/.test(u.protocol) ||
    /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|\[)/i.test(u.hostname)
  )
    return null;
  return u;
}

async function readPage(u: URL): Promise<string> {
  try {
    const r = await fetch(u.toString(), {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) return "";
    return stripHtml(await r.text()).slice(0, 12000);
  } catch {
    return "";
  }
}

const SYS =
  "You answer questions about ONE specific opportunity a job-seeker or outreach user is looking at, using only the " +
  "evidence given to you: the page text and the record Scout already holds. You are reading the posting so they " +
  "don't have to.\n\n" +
  "RULES:\n" +
  "1. Answer ONLY from the evidence. Never fill a gap with what postings like this usually say, what a role like " +
  "this normally requires, or anything you know about the organization from elsewhere.\n" +
  "2. When the evidence doesn't answer the question, say so in the first sentence — plainly, e.g. \"The posting " +
  "doesn't say.\" Then, and only then, you may add what it DOES say that's closest, clearly marked as adjacent " +
  "rather than an answer. A confident-sounding guess is the worst thing you can return: it's the reason they " +
  "asked you instead of reading it themselves.\n" +
  "3. Quote or closely paraphrase the wording that supports your answer, so it can be checked.\n" +
  "4. Two to four sentences. Plain language, no preamble, no bullet lists unless the answer is genuinely a list.\n" +
  "5. If the question is about whether to apply or how to approach them, answer from the evidence about fit, and " +
  "say what the posting leaves unstated.\n" +
  "Return JSON: {\"answer\":\"...\",\"grounded\":true|false} where grounded is false when the evidence did not " +
  "cover the question.";

export async function POST(req: NextRequest) {
  try {
    const { opp, question, history, about, useCase } = await req.json();
    const q = String(question || "").trim();
    if (!q) return NextResponse.json({ error: "Ask a question first." }, { status: 400 });
    if (!opp?.name) return NextResponse.json({ error: "Missing find data." }, { status: 400 });
    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json(
        { error: "Scout can't answer right now — no API key configured." },
        { status: 500 }
      );
    }

    const u = safeUrl(opp.url || "");
    const page = u ? await readPage(u) : "";

    // Everything Scout already knows about this find, so the answer can lean on
    // the discovery evidence when the live page is thin or blocks the fetch.
    const known = [
      `NAME: ${opp.name}`,
      opp.outlet ? `ORGANIZATION: ${opp.outlet}` : "",
      opp.contactRole ? `ROLE: ${opp.contactRole}` : "",
      opp.location ? `LOCATION: ${opp.location}` : "",
      opp.url ? `URL: ${opp.url}` : "",
      opp.whyItFits ? `WHY SCOUT SURFACED IT: ${opp.whyItFits}` : "",
      opp.requirements ? `REQUIREMENTS SCOUT READ EARLIER: ${opp.requirements}` : "",
      Array.isArray(opp.sources) && opp.sources.length
        ? "EVIDENCE SCOUT COLLECTED:\n" +
          opp.sources
            .slice(0, 4)
            .map((s: any) => `- ${s.title || s.url}: ${String(s.snippet || "").slice(0, 400)}`)
            .join("\n")
        : opp.sourceSnippet
          ? `EVIDENCE SCOUT COLLECTED: ${String(opp.sourceSnippet).slice(0, 600)}`
          : "",
    ]
      .filter(Boolean)
      .join("\n");

    const priorTurns = Array.isArray(history)
      ? history
          .slice(-6)
          .map((m: any) => `${m.role === "user" ? "THEY ASKED" : "YOU ANSWERED"}: ${String(m.text || "").slice(0, 600)}`)
          .join("\n")
      : "";

    const user =
      `WHAT SCOUT KNOWS ABOUT THIS FIND:\n${known}\n\n` +
      (page
        ? `PAGE TEXT (fetched just now):\n${page}\n\n`
        : `PAGE TEXT: could not be fetched (the site blocked it or is down). Answer from the record above, and say when something simply isn't covered by it.\n\n`) +
      (about ? `ABOUT THE PERSON ASKING: ${String(about).slice(0, 800)}\n\n` : "") +
      (useCase ? `THEIR USE CASE: ${useCase}\n\n` : "") +
      (priorTurns ? `EARLIER IN THIS CONVERSATION:\n${priorTurns}\n\n` : "") +
      `THEIR QUESTION: ${q}`;

    const raw = await claudeJson(SYS, user, 700);
    let answer = "";
    let grounded = true;
    try {
      const parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
      answer = String(parsed?.answer || "");
      grounded = parsed?.grounded !== false;
    } catch {
      answer = raw.trim();
    }
    if (!answer) {
      return NextResponse.json({ error: "Scout couldn't read enough to answer that." }, { status: 502 });
    }
    return NextResponse.json({ answer: noDash(answer), grounded, readPage: !!page });
  } catch (e: any) {
    if (e instanceof ApiCreditError) {
      return NextResponse.json({ error: e.message }, { status: 402 });
    }
    return NextResponse.json({ error: e?.message || "Couldn't answer that." }, { status: 500 });
  }
}
