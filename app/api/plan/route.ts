import { NextRequest, NextResponse } from "next/server";
import { decomposeGoal } from "@/lib/discover";
import { ApiCreditError } from "@/lib/apiErrors";
import { userIdFromReq, supabaseAdmin } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";
export const maxDuration = 30;

// The pre-search "understanding" pass: decompose the goal only (no searching, no
// metering), so the UI can show how well Scout understands the inquiry and,
// when there are real gaps, offer the confidence questions before running.
export async function POST(req: NextRequest) {
  try {
    // Only require sign-in when auth is configured (mirrors /api/discover).
    if (supabaseAdmin) {
      const uid = await userIdFromReq(req);
      if (!uid) return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
    }
    const { goal, about, useCase } = await req.json();
    if (!goal || !String(goal).trim()) {
      return NextResponse.json({ error: "Please enter a goal." }, { status: 400 });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      // No key to reason with — let the search run without the gate.
      return NextResponse.json({ understanding: 100, questions: [], plan: null });
    }
    const plan = await decomposeGoal(
      String(goal),
      String(about || ""),
      String(useCase || "networking")
    );
    if (!plan) return NextResponse.json({ understanding: 100, questions: [], plan: null });
    return NextResponse.json({
      understanding: plan.understanding,
      questions: plan.confidence_questions.slice(0, 5),
      objective: plan.goal,
      plan,
    });
  } catch (e: any) {
    if (e instanceof ApiCreditError) {
      // Don't block the search over the planning step; let it proceed.
      return NextResponse.json({ understanding: 100, questions: [], plan: null });
    }
    return NextResponse.json({ understanding: 100, questions: [], plan: null });
  }
}
