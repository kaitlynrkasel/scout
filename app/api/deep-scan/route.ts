import { NextRequest, NextResponse } from "next/server";
import { claudeJson, parseJsonLoose } from "@/lib/claude";
import { ApiCreditError } from "@/lib/apiErrors";

export const runtime = "nodejs";
export const maxDuration = 60; // fetch pages + one Claude pass; slow sites can hit the low ceiling

// Strip a page down to readable text (same approach as /api/read-website).
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

// Block internal/local addresses before we fetch a user/model-supplied URL.
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
  const r = await fetch(u.toString(), {
    headers: { "user-agent": "Mozilla/5.0 (compatible; ScoutBot/1.0)" },
    redirect: "follow",
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) return "";
  const html = await r.text();
  return stripHtml(html).slice(0, 9000);
}

// Deep-scan one find's site: read the page (and a likely contact/careers page if
// linked) and pull out a SPECIFIC contact plus what they ask submitters/applicants
// for. Never invents anything, only what appears on the page.
export async function POST(req: NextRequest) {
  try {
    const { url, name, outlet, goal, useCase } = await req.json();
    const u = safeUrl(url);
    if (!u) {
      return NextResponse.json({ error: "This find has no page to scan." }, { status: 400 });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json(
        { error: "Missing ANTHROPIC_API_KEY in .env.local." },
        { status: 500 }
      );
    }

    // Read the main page, then look for a contact/careers/submit/about page to
    // read as well (that's where requirements and named contacts usually live).
    const mainHtmlResp = await fetch(u.toString(), {
      headers: { "user-agent": "Mozilla/5.0 (compatible; ScoutBot/1.0)" },
      redirect: "follow",
      signal: AbortSignal.timeout(12000),
    }).catch(() => null);
    if (!mainHtmlResp || !mainHtmlResp.ok) {
      return NextResponse.json(
        { error: `Couldn't reach that site (${mainHtmlResp?.status || "no response"}).` },
        { status: 400 }
      );
    }
    const mainHtml = await mainHtmlResp.text();
    const pages: string[] = [stripHtml(mainHtml).slice(0, 9000)];

    // Find internal links whose text/href hints at contact/careers/submit pages.
    const linkRe = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    const wanted = /(contact|careers?|jobs?|submit|submission|demo|about|team|apply|work-with|write-for)/i;
    const seen = new Set<string>();
    const followUrls: URL[] = [];
    let m: RegExpExecArray | null;
    while ((m = linkRe.exec(mainHtml)) && followUrls.length < 2) {
      const href = m[1];
      const label = stripHtml(m[2] || "");
      if (!wanted.test(href) && !wanted.test(label)) continue;
      let child: URL | null = null;
      try {
        child = new URL(href, u.toString());
      } catch {
        continue;
      }
      if (child.hostname !== u.hostname) continue; // same site only
      const key = child.pathname.toLowerCase();
      if (seen.has(key) || key === u.pathname.toLowerCase()) continue;
      seen.add(key);
      if (safeUrl(child.toString())) followUrls.push(child);
    }
    for (const c of followUrls) {
      const t = await readPage(c).catch(() => "");
      if (t) pages.push(`[from ${c.pathname}] ${t}`);
    }

    const combined = pages.join("\n\n").slice(0, 16000);
    if (!combined.trim()) {
      return NextResponse.json(
        { error: "That page had no readable text." },
        { status: 400 }
      );
    }

    const sys =
      `You read a company/opportunity's own web pages and extract two things for someone reaching out. ` +
      `Return ONLY JSON {contact:{name,role,email,handle}, requirements}. ` +
      `contact = ONE specific, named person to reach (recruiter, hiring manager, editor, partnerships lead, team member) with their ` +
      `real email or LinkedIn/@handle if shown. NEVER invent an email, name, or handle, use only what appears verbatim ` +
      `on the pages. Prefer a named person's real email over a generic inbox (info@, careers@, submit@). If only a generic ` +
      `inbox exists, put it in email and leave name empty. If nothing is present, use empty strings. ` +
      `requirements = a short, plain-language summary of what THEY ask a person reaching out to provide or do: submission ` +
      `guidelines, required materials (resume, portfolio, cover letter, links), application steps, formats, "no attachments", ` +
      `where/how to send, deadlines, or what they say they want. If the pages state none, return an empty string. ` +
      `Do not pad it, do not guess, keep it under 80 words.`;
    const user =
      `TARGET: ${String(name || "").trim()}${outlet ? ` at ${outlet}` : ""}\n` +
      `WHY THEY'RE BEING CONTACTED (goal): ${String(goal || "").trim()}\n` +
      `USE CASE: ${String(useCase || "").trim()}\n\nPAGE TEXT:\n${combined}`;

    let parsed: any = null;
    try {
      parsed = parseJsonLoose(await claudeJson(sys, user));
    } catch (e) {
      if (e instanceof ApiCreditError) throw e;
      parsed = null;
    }

    const contact = {
      name: String(parsed?.contact?.name || "").trim(),
      role: String(parsed?.contact?.role || "").trim(),
      email: String(parsed?.contact?.email || "").trim(),
      handle: String(parsed?.contact?.handle || "").trim(),
    };
    const requirements = String(parsed?.requirements || "").trim();

    return NextResponse.json({
      contact,
      requirements,
      scannedPages: pages.length,
    });
  } catch (e: any) {
    if (e instanceof ApiCreditError) {
      return NextResponse.json(
        { error: e.userMessage(), credit: true, provider: e.provider, reason: e.reason },
        { status: 402 }
      );
    }
    return NextResponse.json(
      { error: e?.message || "Couldn't scan that site." },
      { status: 500 }
    );
  }
}
