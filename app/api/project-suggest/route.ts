import { NextRequest, NextResponse } from "next/server";
import { claudeJson, parseJsonLoose, noDash } from "@/lib/claude";
import { ApiCreditError } from "@/lib/apiErrors";
import { userFromReq } from "@/lib/supabaseAdmin";
import { withinRateLimit } from "@/lib/rateLimit";
import { USE_CASE_SUGGESTIONS } from "@/lib/templates";

export const runtime = "nodejs";
export const maxDuration = 30;

// Infer what a project is FOR from its name + description, and propose search
// categories that fit it. Fixes the "Grad School project seeded with Sync &
// Licensing" mismatch: new projects used to inherit whatever use case the
// PREVIOUS project had, so their starter categories often described the wrong
// world entirely.
const SYS = `You retune a cold-outreach project's starter setup to match what the project is actually for.

Given a project's NAME and optional DESCRIPTION, return JSON:
{
  "use_case": "<the best-fit use case>",
  "categories": [ { "name": "<2-4 word category>", "goal": "<one specific sentence describing who to find>" }, x3 ]
}

use_case: pick the closest from this list when one fits: ${USE_CASE_SUGGESTIONS.join(", ")}. Otherwise write a concise custom one (2-5 words).

categories: three DIFFERENT angles on the project, each a concrete kind of person/organization to find. Goals are written as "who are you looking for" answers, specific enough to search on (e.g. for a grad-school project: "admissions officers at MBA programs with rolling admissions", "current students or recent alumni of target programs open to a quick chat", "scholarship and fellowship programs for entrepreneurship students").

Rules: ground everything in the given name/description, never invent a different topic. Plain language. No em dashes anywhere.`;

export async function POST(req: NextRequest) {
  try {
    const u = await userFromReq(req);
    if (!u) return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
    if (!withinRateLimit(`psg:${u.id}`, 30, 60 * 60 * 1000)) {
      return NextResponse.json({ error: "Too many retunes this hour." }, { status: 429 });
    }
    const { name, context } = await req.json();
    const nm = String(name || "").slice(0, 120).trim();
    const ctx = String(context || "").slice(0, 1500).trim();
    if (!nm && !ctx) {
      return NextResponse.json({ error: "Nothing to infer from yet." }, { status: 400 });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json({ error: "Missing ANTHROPIC_API_KEY." }, { status: 500 });
    }
    const out = await claudeJson(
      SYS,
      `PROJECT NAME: ${nm || "(unnamed)"}\nDESCRIPTION: ${ctx || "(none given)"}`,
      700
    );
    const parsed = parseJsonLoose<{
      use_case?: string;
      categories?: { name?: string; goal?: string }[];
    }>(out);
    const useCase = noDash(String(parsed?.use_case || "").trim()).slice(0, 60);
    const categories = (Array.isArray(parsed?.categories) ? parsed!.categories! : [])
      .map((c) => ({
        name: noDash(String(c?.name || "").trim()).slice(0, 60),
        goal: noDash(String(c?.goal || "").trim()).slice(0, 300),
      }))
      .filter((c) => c.name && c.goal)
      .slice(0, 3);
    if (!useCase || !categories.length) {
      return NextResponse.json({ error: "Couldn't infer this project." }, { status: 502 });
    }
    return NextResponse.json({ useCase, categories });
  } catch (e: any) {
    if (e instanceof ApiCreditError) {
      return NextResponse.json({ error: e.message }, { status: 402 });
    }
    return NextResponse.json({ error: e?.message || "Something went wrong." }, { status: 500 });
  }
}
