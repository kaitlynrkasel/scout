import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { claudeJson } from "@/lib/claude";
import { githubConfigured, getFile, putFile } from "@/lib/github";
import { gmailSendOrDraft } from "@/lib/gmail";
import { outlookSendOrDraft } from "@/lib/outlook";
import {
  computeTuningSignal,
  meetsThreshold,
  slotForSignal,
  extractSlotValue,
  replaceSlotValue,
  sanityCheck,
  tuningThresholds,
  type TuningThresholds,
} from "@/lib/autotune";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const DISCOVER_PATH = "lib/discover.ts";

// Fully autonomous algorithm tuning: checks the owner account's real search
// outcomes against a confidence gate (lib/autotune.ts), and, only when it
// clears that gate and the cooldown has elapsed, edits ONE named tunable
// clause in lib/discover.ts and commits it to main, no human review. Vercel's
// existing git integration deploys it from there. See the chat that requested
// this ("fully autonomous, no review") for the reasoning. The confidence gate
// SCALES with platform size (tuningThresholds): more sensitive while there are
// few users (as low as 8 decided / 25% bucket / 2-day cooldown), tightening to
// the conservative ceiling (20 / 0.3 / 7d) as the user base grows.
//
// Every applied edit is (a) logged to the auto_tune_log table, the
// before/after clause text, the data that triggered it, and the GitHub commit
// link, surfaced in-app as the algorithm change log, and (b) emailed to the
// owner's connected mailbox as a best-effort notification. The log write is
// the source of truth; email failing never blocks it.
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

  // Find the owner's user id(s), auto-tune only ever reads the account(s)
  // that are actually driving this decision, never other users' data.
  const { data: userList, error: userErr } = await supabaseAdmin.auth.admin.listUsers({
    perPage: 200,
  });
  if (userErr) {
    return NextResponse.json({ error: `Couldn't list users: ${userErr.message}` }, { status: 500 });
  }
  const owners = (userList?.users || []).filter((u) =>
    ownerEmails.includes((u.email || "").toLowerCase())
  );
  if (!owners.length) {
    return NextResponse.json({ skipped: true, reason: "No owner account found." });
  }

  // Sensitivity scales with platform size: fewer users -> lower bar so
  // improvements actually happen while data is scarce. (perPage caps at 200; a
  // full page is treated as "large", which just means the conservative ceiling.)
  const totalUsers = userList?.users?.length || 0;
  const thresholds = tuningThresholds(totalUsers);

  const results: any[] = [];
  for (const u of owners) {
    try {
      results.push(await runForUser(u.id, u.email || "", thresholds));
    } catch (e: any) {
      results.push({ userId: u.id, error: e?.message || "unknown error" });
    }
  }
  return NextResponse.json({ totalUsers, thresholds, results });
}

async function runForUser(userId: string, ownerEmail: string, thresholds: TuningThresholds) {
  // Cooldown lives in the audit log itself (most recent row's timestamp), 
  // single source of truth, no separate state field that could drift from it.
  const { data: lastEntry } = await supabaseAdmin!
    .from("auto_tune_log")
    .select("created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const cooldownMs = thresholds.cooldownDays * 86400000;
  if (lastEntry?.created_at) {
    const elapsed = Date.now() - new Date(lastEntry.created_at).getTime();
    if (elapsed < cooldownMs) {
      return {
        userId,
        applied: false,
        reason: `cooldown active, ${Math.ceil((cooldownMs - elapsed) / 86400000)}d remaining`,
      };
    }
  }

  const { data: row } = await supabaseAdmin!
    .from("user_state")
    .select("data")
    .eq("user_id", userId)
    .maybeSingle();
  const finds = Array.isArray(row?.data?.finds) ? row!.data.finds : [];

  const signal = computeTuningSignal(finds);
  if (!meetsThreshold(signal, thresholds)) {
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
    `data. Return ONLY the revised clause text, no backticks, no code, no markdown, no preamble, one paragraph, same ` +
    `ALL-CAPS label prefix style as the original (e.g. "LOCATION ALIGNMENT: ..."). Make it more specific and stricter ` +
    `about the failure mode the data shows, without changing what it's fundamentally judging. Keep it roughly the same ` +
    `length as the original.`;
  const user =
    `CURRENT CLAUSE:\n${currentClause}\n\n` +
    `DATA: of ${signal.decided} decided finds, ${signal.denied} were denied. The dominant deny reason is ` +
    `"${signal.topBucket!.label}" at ${signal.topBucket!.count} of the bucketed denials (${Math.round(signal.topBucket!.share * 100)}% share). ` +
    (signal.keptFit != null && signal.deniedFit != null
      ? `Avg fit score: kept ${Math.round(signal.keptFit * 100)}%, denied ${Math.round(signal.deniedFit * 100)}%, ` +
        `a gap under 10 points means fit_score isn't discriminating well; push denied cases in this failure mode lower. `
      : "") +
    `Revise the clause so it penalizes this failure mode more decisively.`;

  let newClause = (await claudeJson(sys, user)).trim();
  if (newClause.includes("`")) {
    return { userId, applied: false, reason: "generated clause contained a backtick, refused to risk a broken template literal" };
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

  const commitMessage =
    `Auto-tune: ${slot.label}\n\n` +
    `${signal.decided} decided finds, ${signal.topBucket!.label} is ${Math.round(signal.topBucket!.share * 100)}% ` +
    `of denials (${signal.topBucket!.count} instances). Kept/denied avg fit: ` +
    `${signal.keptFit != null ? Math.round(signal.keptFit * 100) : "n/a"}% / ` +
    `${signal.deniedFit != null ? Math.round(signal.deniedFit * 100) : "n/a"}%.\n\n` +
    `Autonomous edit, no human review, see lib/autotune.ts.`;
  const { commitUrl } = await putFile(DISCOVER_PATH, revised, sha, commitMessage);

  await supabaseAdmin!.from("auto_tune_log").insert({
    user_id: userId,
    slot: slot.constName,
    label: slot.label,
    old_clause: currentClause,
    new_clause: newClause,
    commit_url: commitUrl,
    signal,
  });

  await notifyOwner(userId, ownerEmail, slot.label, currentClause, newClause, signal, commitUrl);

  return { userId, applied: true, slot: slot.constName, signal, newClause, commitUrl };
}

// Best-effort email through whichever mailbox the owner has connected. Never
// throws, the log entry above is the actual record; this is just the alert.
async function notifyOwner(
  userId: string,
  ownerEmail: string,
  label: string,
  oldClause: string,
  newClause: string,
  signal: ReturnType<typeof computeTuningSignal>,
  commitUrl: string
) {
  if (!ownerEmail) return;
  // Plain-English email: lead with what this means for the user's results, keep
  // the raw before/after clauses as fine print at the bottom for the curious.
  const denyPct = Math.round((signal.topBucket?.share || 0) * 100);
  const reason = signal.topBucket?.label || "a recurring pattern";
  const subject = `Scout learned from your feedback: stricter on "${reason.toLowerCase()}"`;
  const body =
    `Hi!\n\n` +
    `Scout noticed a pattern in the finds you've been passing on and adjusted itself to match.\n\n` +
    `WHAT IT LEARNED\n` +
    `Out of your last ${signal.decided} decisions, "${reason}" was the reason behind ${denyPct}% of the finds you said no to` +
    ` (${signal.topBucket?.count} of them). So Scout tightened how it scores that — matches with that problem will now rank much lower, ` +
    `and you should see fewer of them in your results.${
      signal.keptFit != null && signal.deniedFit != null
        ? `\n\n(For the curious: finds you kept were averaging ${Math.round(signal.keptFit * 100)}% fit vs ${Math.round(
            signal.deniedFit * 100
          )}% for ones you denied — too close together, which is what this fixes.)`
        : ""
    }\n\n` +
    `NOTHING YOU NEED TO DO\n` +
    `This is automatic — just keep approving and passing on finds and Scout keeps calibrating to your taste. ` +
    `If results ever feel too strict or too loose, tell us and we'll adjust.\n\n` +
    `See every change Scout has made: open Scout → Dashboard → "Tune the search algorithm" → Change log.\n` +
    `Technical commit: ${commitUrl}\n\n` +
    `— Scout\n\n` +
    `----------------------------------------\n` +
    `FINE PRINT (the exact rule that changed: ${label})\n\n` +
    `Before:\n${oldClause}\n\n` +
    `After:\n${newClause}`;

  try {
    const gmail = await supabaseAdmin!
      .from("gmail_connections")
      .select("email, refresh_token")
      .eq("user_id", userId)
      .maybeSingle();
    if (gmail.data?.refresh_token) {
      await gmailSendOrDraft({
        refreshToken: gmail.data.refresh_token,
        from: gmail.data.email || ownerEmail,
        to: ownerEmail,
        subject,
        body,
        mode: "send",
      });
      return;
    }
    const outlook = await supabaseAdmin!
      .from("outlook_connections")
      .select("email, refresh_token")
      .eq("user_id", userId)
      .maybeSingle();
    if (outlook.data?.refresh_token) {
      await outlookSendOrDraft({
        refreshToken: outlook.data.refresh_token,
        to: ownerEmail,
        subject,
        body,
        mode: "send",
      });
    }
  } catch (e) {
    console.warn("auto-tune notification email failed (log entry still saved):", e);
  }
}
