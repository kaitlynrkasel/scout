import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { claudeJson } from "@/lib/claude";
import { githubConfigured, getFile, putFile } from "@/lib/github";
import {
  computeTuningSignal,
  meetsThreshold,
  slotForSignal,
  extractSlotValue,
  replaceSlotValue,
  sanityCheck,
  COOLDOWN_DAYS,
} from "@/lib/autotune";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const DISCOVER_PATH = "lib/discover.ts";

// Fully autonomous algorithm tuning: checks the owner account's real search
// outcomes against a confidence gate (lib/autotune.ts), and — only when it
// clears that gate and the cooldown has elapsed — edits ONE named tunable
// clause in lib/discover.ts and commits it to main, no human review. Vercel's
// existing git integration deploys it from there. See the chat that requested
// this ("fully autonomous, no review") for the reasoning and chosen
// thresholds (MIN_DECIDED=20, MIN_BUCKET_SHARE=0.3, COOLDOWN_DAYS=7).
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") || "";
  const secret = process.env.CRON_SECRET || "";
  if (!secret) return NextResponse.json({ error: "CRON_SECRET not set." }, { status: 500 });
  if (auth !== `Bearer ${secret}`) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  if (!supabaseAdmin) {
    return NextResponse.json({ error: "Supabase service role not configured." }, { status: 500 });
  }
  if (!githubConfigured()) {
    return NextResponse.json({ skipped: true, reason: "GITHUB_AUTOTUNE_TOKEN not set." });
  }
  const ownerEmails = (process.env.SCOUT_OWNER_EMAILS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!ownerEmails.length) {
    return NextResponse.json({ skipped: true, reason: "SCOUT_OWNER_EMAILS not set." });
  }

  // Find the owner's user id(s) — auto-tune only ever reads the account(s)
  // that are actually driving this decision, never other users' data.
  const { data: userList, error: userErr } = await supabaseAdmin.auth.admin.listUsers({
    perPage: 200,
  });
  if (userErr) {
    return NextResponse.json({ error: `Couldn't list users: ${userErr.message}` }, { status: 500 });
  }
  const ownerIds = (userList?.users || [])
    .filter((u) => ownerEmails.includes((u.email || "").toLowerCase()))
    .map((u) => u.id);
  if (!ownerIds.length) {
    return NextResponse.json({ skipped: true, reason: "No owner account found." });
  }

  const results: any[] = [];
  for (const userId of ownerIds) {
    try {
      results.push(await runForUser(userId));
    } catch (e: any) {
      results.push({ userId, error: e?.message || "unknown error" });
    }
  }
  return NextResponse.json({ results });
}

async function runForUser(userId: string) {
  const { data: row } = await supabaseAdmin!
    .from("user_state")
    .select("data")
    .eq("user_id", userId)
    .maybeSingle();
  const state = (row?.data || {}) as any;
  const finds = Array.isArray(state.finds) ? state.finds : [];

  // Cooldown — refuse to fire again until enough time has passed, regardless
  // of how strong the signal looks, so it can't thrash the same clause.
  const lastRun = state.autoTuneLastRunAt ? new Date(state.autoTuneLastRunAt).getTime() : 0;
  const cooldownMs = COOLDOWN_DAYS * 86400000;
  if (lastRun && Date.now() - lastRun < cooldownMs) {
    return {
      userId,
      applied: false,
      reason: `cooldown active, ${Math.ceil((cooldownMs - (Date.now() - lastRun)) / 86400000)}d remaining`,
    };
  }

  const signal = computeTuningSignal(finds);
  if (!meetsThreshold(signal)) {
    return {
      userId,
      applied: false,
      reason: `below threshold (decided=${signal.decided}, topBucketShare=${signal.topBucket?.share ?? 0})`,
      signal,
    };
  }
  const slot = slotForSignal(signal);
  if (!slot) {
    return {
      userId,
      applied: false,
      reason: `dominant bucket "${signal.topBucket?.label}" has no matching tunable slot`,
      signal,
    };
  }

  const { content: fileText, sha } = await getFile(DISCOVER_PATH);
  const currentClause = extractSlotValue(fileText, slot.constName);
  if (!currentClause) {
    return { userId, applied: false, reason: `couldn't locate ${slot.constName} in ${DISCOVER_PATH}` };
  }

  const sys =
    `You tighten ONE instructional clause inside an outreach-discovery engine's fit-scoring prompt, based on real deny ` +
    `data. Return ONLY the revised clause text — no backticks, no code, no markdown, no preamble, one paragraph, same ` +
    `ALL-CAPS label prefix style as the original (e.g. "LOCATION ALIGNMENT: ..."). Make it more specific and stricter ` +
    `about the failure mode the data shows, without changing what it's fundamentally judging. Keep it roughly the same ` +
    `length as the original.`;
  const user =
    `CURRENT CLAUSE:\n${currentClause}\n\n` +
    `DATA: of ${signal.decided} decided finds, ${signal.denied} were denied. The dominant deny reason is ` +
    `"${signal.topBucket!.label}" at ${signal.topBucket!.count} of the bucketed denials (${Math.round(signal.topBucket!.share * 100)}% share). ` +
    (signal.keptFit != null && signal.deniedFit != null
      ? `Avg fit score: kept ${Math.round(signal.keptFit * 100)}%, denied ${Math.round(signal.deniedFit * 100)}% — ` +
        `a gap under 10 points means fit_score isn't discriminating well; push denied cases in this failure mode lower. `
      : "") +
    `Revise the clause so it penalizes this failure mode more decisively.`;

  let newClause = (await claudeJson(sys, user)).trim();
  if (newClause.includes("`")) {
    return { userId, applied: false, reason: "generated clause contained a backtick — refused to risk a broken template literal" };
  }
  if (!newClause) {
    return { userId, applied: false, reason: "model returned an empty clause" };
  }

  const revised = replaceSlotValue(fileText, slot.constName, newClause);
  if (!revised) {
    return { userId, applied: false, reason: `slot replacement failed for ${slot.constName}` };
  }
  const check = sanityCheck(fileText, revised);
  if (!check.ok) {
    return { userId, applied: false, reason: `sanity check failed: ${check.reason}` };
  }

  const message =
    `Auto-tune: ${slot.label}\n\n` +
    `${signal.decided} decided finds, ${signal.topBucket!.label} is ${Math.round(signal.topBucket!.share * 100)}% ` +
    `of denials (${signal.topBucket!.count} instances). Kept/denied avg fit: ` +
    `${signal.keptFit != null ? Math.round(signal.keptFit * 100) : "n/a"}% / ` +
    `${signal.deniedFit != null ? Math.round(signal.deniedFit * 100) : "n/a"}%.\n\n` +
    `Autonomous edit, no human review — see lib/autotune.ts.`;
  await putFile(DISCOVER_PATH, revised, sha, message);

  const nowIso = new Date().toISOString();
  const log = Array.isArray(state.autoTuneLog) ? state.autoTuneLog : [];
  await supabaseAdmin!.from("user_state").upsert({
    user_id: userId,
    data: {
      ...state,
      autoTuneLastRunAt: nowIso,
      autoTuneLog: [
        { at: nowIso, slot: slot.constName, label: slot.label, signal },
        ...log,
      ].slice(0, 20),
    },
  });

  return { userId, applied: true, slot: slot.constName, signal, newClause };
}
