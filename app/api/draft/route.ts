import { NextRequest, NextResponse } from "next/server";
import { draftFor } from "@/lib/draft";
import type { Opportunity, OutreachTemplate, TemplateKey } from "@/lib/types";

export const maxDuration = 60; // Vercel Hobby caps at 60s; Pro lifts to 300s

export async function POST(req: NextRequest) {
  try {
    const { opportunities, about, template, templates } = await req.json();
    const opps: Opportunity[] = opportunities || [];
    const myTemplates: OutreachTemplate[] = templates || [];
    if (!opps.length) {
      return NextResponse.json({ error: "No opportunities selected." }, { status: 400 });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json(
        { error: "Missing ANTHROPIC_API_KEY in .env.local." },
        { status: 500 }
      );
    }
    // Draft in parallel (small batch, fine for the spike's cap of a few rows).
    const drafts = await Promise.all(
      opps
        .slice(0, 8)
        .map((o) =>
          draftFor(
            o,
            String(about || ""),
            (template as TemplateKey) || "networking",
            myTemplates
          )
        )
    );
    return NextResponse.json({ drafts });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Drafting failed." }, { status: 500 });
  }
}
