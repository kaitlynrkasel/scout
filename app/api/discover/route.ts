import { NextRequest, NextResponse } from "next/server";
import { discover } from "@/lib/discover";
import { ApiCreditError } from "@/lib/apiErrors";
import { supabaseAdmin, userIdFromReq } from "@/lib/supabaseAdmin";
import { getEntitlement, consumeSearch } from "@/lib/billing";
import { computeTuningSignal, buildPersonalOverride } from "@/lib/autotune";

export const maxDuration = 300; // Pro plan max; discover chains multiple Tavily + Claude passes

export async function POST(req: NextRequest) {
  try {
    // Metering is only enforced when auth is configured (service-role present).
    // Locally, without Supabase, discovery stays open and unmetered.
    const metered = !!supabaseAdmin;
    let uid: string | null = null;
    if (metered) {
      uid = await userIdFromReq(req);
      if (!uid) {
        return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
      }
      // Pre-check the allowance so we don't run a search the user can't afford.
      // (A failed search shouldn't cost a credit, so we consume only on success.)
      const ent = await getEntitlement(uid);
      const paid = ent.tier === "starter" || ent.tier === "pro";
      if (paid && ent.searchesUsed >= ent.searchLimit) {
        return NextResponse.json(
          {
            error: `You've used all ${ent.searchLimit} searches on your ${ent.tier} plan this month.`,
            code: "quota",
            tier: ent.tier,
          },
          { status: 402 }
        );
      }
      if (!paid && ent.freeUsed >= ent.freeLimit) {
        return NextResponse.json(
          {
            error: `You've used your ${ent.freeLimit} free searches this month.`,
            code: "free_exhausted",
            tier: "free",
          },
          { status: 402 }
        );
      }
    }

    const { goal, about, useCase, template, feedback, salt, cohortHint } = await req.json();
    if (!goal || !String(goal).trim()) {
      return NextResponse.json({ error: "Please enter a goal." }, { status: 400 });
    }
    if (!process.env.TAVILY_API_KEY || !process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json(
        {
          error:
            "Missing API keys. Copy .env.local.example to .env.local and add TAVILY_API_KEY and ANTHROPIC_API_KEY, then restart.",
        },
        { status: 500 }
      );
    }
    // Individual calibration: built fresh from THIS user's own deny data,
    // never committed anywhere, the per-request counterpart to the
    // universal auto-tune cron (which edits shared code for everyone).
    // Best-effort: any failure here just means no personal override, never
    // blocks the search itself.
    let personalOverride = "";
    if (metered && uid) {
      try {
        const { data: row } = await supabaseAdmin!
          .from("user_state")
          .select("data")
          .eq("user_id", uid)
          .maybeSingle();
        const finds = Array.isArray(row?.data?.finds) ? row!.data.finds : [];
        personalOverride = buildPersonalOverride(computeTuningSignal(finds));
      } catch (e) {
        console.warn("personal calibration lookup failed (search proceeds without it):", e);
      }
    }

    const result = await discover(
      String(goal),
      String(about || ""),
      String(useCase || template || "networking"),
      10,
      feedback && typeof feedback === "object" ? feedback : undefined,
      salt ? String(salt).slice(0, 64) : undefined,
      cohortHint ? String(cohortHint).slice(0, 400) : undefined,
      personalOverride || undefined
    );

    // Count this successful search against the user's monthly allowance.
    if (metered && uid) {
      try {
        await consumeSearch(uid);
      } catch (e: any) {
        console.warn("consumeSearch failed (search already returned):", e?.message);
      }
    }

    return NextResponse.json(result);
  } catch (e: any) {
    if (e instanceof ApiCreditError) {
      return NextResponse.json(
        { error: e.userMessage(), credit: true, provider: e.provider, reason: e.reason },
        { status: 402 }
      );
    }
    return NextResponse.json(
      { error: e?.message || "Discovery failed." },
      { status: 500 }
    );
  }
}
