import { NextRequest, NextResponse } from "next/server";
import { discover } from "@/lib/discover";
import { ApiCreditError } from "@/lib/apiErrors";
import { supabaseAdmin, userIdFromReq } from "@/lib/supabaseAdmin";
import { getEntitlement, consumeSearch } from "@/lib/billing";
import { computeTuningSignal, buildPersonalOverride, buildTeamOverride } from "@/lib/autotune";

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

    const { goal, about, useCase, template, feedback, salt, cohortHint, teamWorkspaceId, useHistory } =
      await req.json();
    // Per-project "read my profile" off => don't apply any cross-search learning.
    const learn = useHistory !== false;
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
    if (metered && uid && learn) {
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

    // Team calibration: for a user in a company workspace, aggregate the deny/keep
    // signal across EVERYONE on the team and steer with it. Highest priority
    // (team > personal > scout-wide). Best-effort: verifies membership, caps the
    // member fan-out, and silently skips if Teams isn't set up.
    let teamOverride = "";
    if (metered && uid && teamWorkspaceId && learn) {
      try {
        const wsId = String(teamWorkspaceId);
        const { data: mine } = await supabaseAdmin!
          .from("workspace_members")
          .select("user_id")
          .eq("workspace_id", wsId)
          .eq("user_id", uid)
          .maybeSingle();
        if (mine) {
          const { data: members } = await supabaseAdmin!
            .from("workspace_members")
            .select("user_id, weight")
            .eq("workspace_id", wsId);
          const memberList = (members || []).slice(0, 50);
          const memberIds = memberList.map((m: any) => m.user_id);
          // Owner-set weight (default 1 = equal). Replicating a member's finds by
          // their weight makes their decisions count that many times more.
          const weightOf = new Map<string, number>(
            memberList.map((m: any) => [
              m.user_id,
              Math.max(1, Math.min(5, Number(m.weight) || 1)),
            ])
          );
          if (memberIds.length) {
            const { data: states } = await supabaseAdmin!
              .from("user_state")
              .select("user_id, data")
              .in("user_id", memberIds);
            const teamFinds = (states || []).flatMap((s: any) => {
              const finds = Array.isArray(s?.data?.finds) ? s.data.finds : [];
              const w = weightOf.get(s.user_id) || 1;
              const out: any[] = [];
              for (let i = 0; i < w; i++) out.push(...finds);
              return out;
            });
            teamOverride = buildTeamOverride(computeTuningSignal(teamFinds));
          }
        }
      } catch (e) {
        console.warn("team calibration lookup failed (search proceeds without it):", e);
      }
    }

    // Compose the override block: team first (highest priority), then personal.
    // discover() appends this after the scout-wide baseline, and each tier's text
    // states its own precedence, so the model resolves team > personal > scout-wide.
    const combinedOverride = [teamOverride, personalOverride].filter(Boolean).join("\n\n");

    // Stream results as NDJSON so the client can show finds as they're scouted
    // and — if the user cancels mid-run — keep what was already found. Each line
    // is one JSON object: {type:"opp",opp} per find, then {type:"done",result}
    // (or {type:"error",...}). Cancellation aborts req.signal, which stops
    // discover() early so no further Tavily/Claude calls are spent, and we skip
    // metering (an abandoned search shouldn't cost the user a credit).
    const enc = new TextEncoder();
    const send = (ctrl: ReadableStreamDefaultController, obj: unknown) =>
      ctrl.enqueue(enc.encode(JSON.stringify(obj) + "\n"));

    const stream = new ReadableStream({
      async start(controller) {
        try {
          const result = await discover(
            String(goal),
            String(about || ""),
            String(useCase || template || "networking"),
            10,
            feedback && typeof feedback === "object" ? feedback : undefined,
            salt ? String(salt).slice(0, 64) : undefined,
            cohortHint ? String(cohortHint).slice(0, 400) : undefined,
            combinedOverride || undefined,
            {
              signal: req.signal,
              onOpp: (o) => {
                try {
                  send(controller, { type: "opp", opp: o });
                } catch {
                  /* controller may be closed if the client left */
                }
              },
            }
          );
          if (req.signal.aborted) return; // client cancelled; don't meter
          send(controller, { type: "done", result });
          if (metered && uid) {
            try {
              await consumeSearch(uid);
            } catch (e: any) {
              console.warn("consumeSearch failed (search already returned):", e?.message);
            }
          }
        } catch (e: any) {
          if (req.signal.aborted) return;
          const payload =
            e instanceof ApiCreditError
              ? { type: "error", error: e.userMessage(), credit: true, provider: e.provider, reason: e.reason }
              : { type: "error", error: e?.message || "Discovery failed." };
          try {
            send(controller, payload);
          } catch {
            /* ignore */
          }
        } finally {
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
      },
    });
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
