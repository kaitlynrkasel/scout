import { NextRequest, NextResponse } from "next/server";
import { draftFor } from "@/lib/draft";
import { ApiCreditError } from "@/lib/apiErrors";
import type { Opportunity, OutreachTemplate } from "@/lib/types";

export const maxDuration = 300; // Pro plan max; batches up to 8 parallel Claude drafts

export async function POST(req: NextRequest) {
  try {
    const {
      opportunities,
      about,
      useCase,
      template,
      templates,
      coaching,
      dismissedAdvice,
      editPairs,
      signature,
      kind,
    } = await req.json();
    const opps: Opportunity[] = opportunities || [];
    const myTemplates: OutreachTemplate[] = templates || [];
    const coach: string[] = Array.isArray(coaching) ? coaching : [];
    const dismissed: string[] = Array.isArray(dismissedAdvice) ? dismissedAdvice : [];
    const edits: { before: string; after: string }[] = Array.isArray(editPairs)
      ? editPairs
      : [];
    const sig = typeof signature === "string" ? signature : "";
    const kindStr = typeof kind === "string" ? kind.slice(0, 60) : "";
    const uc = String(useCase || template || "networking");
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
      opps.slice(0, 8).map((o) =>
        draftFor(o, String(about || ""), uc, {
          templates: myTemplates,
          coaching: coach,
          dismissedAdvice: dismissed,
          editPairs: edits,
          requirements: (o as any).requirements || "",
          signature: sig,
          kind: kindStr,
        })
      )
    );
    return NextResponse.json({ drafts });
  } catch (e: any) {
    if (e instanceof ApiCreditError) {
      return NextResponse.json(
        { error: e.userMessage(), credit: true, provider: e.provider, reason: e.reason },
        { status: 402 }
      );
    }
    return NextResponse.json({ error: e?.message || "Drafting failed." }, { status: 500 });
  }
}
