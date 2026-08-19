import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { withinRateLimit, requestIp } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Shared state for the /readiness checklist. Gated by a link secret
// (READINESS_KEY) rather than accounts, so a collaborator without a Scout
// login can still tick boxes; the secret only guards THIS table.
function authorized(req: NextRequest): boolean {
  const want = process.env.READINESS_KEY || "";
  if (!want) return false; // unset = feature off
  const got = req.nextUrl.searchParams.get("k") || req.headers.get("x-readiness-key") || "";
  return got === want;
}

// GET ?k=... -> every saved verdict, keyed by item.
export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "Not authorized." }, { status: 403 });
  if (!supabaseAdmin) return NextResponse.json({ error: "Not configured." }, { status: 500 });
  const { data, error } = await supabaseAdmin
    .from("readiness_checks")
    .select("key, verdict, owner_name, note, updated_at");
  if (error) return NextResponse.json({ notReady: true, message: error.message });
  return NextResponse.json({ checks: data || [] });
}

// POST ?k=... {key, verdict, owner, note} -> upsert one item's state.
export async function POST(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "Not authorized." }, { status: 403 });
  if (!supabaseAdmin) return NextResponse.json({ error: "Not configured." }, { status: 500 });
  if (!withinRateLimit(`ready:${requestIp(req.headers)}`, 240, 10 * 60 * 1000)) {
    return NextResponse.json({ error: "Slow down a moment." }, { status: 429 });
  }
  const body = await req.json().catch(() => ({}));
  const key = String(body.key || "").slice(0, 160);
  const verdict = ["", "ok", "warn", "bad"].includes(body.verdict) ? body.verdict : "";
  const owner = String(body.owner || "").slice(0, 60);
  const note = String(body.note || "").slice(0, 1000);
  if (!key) return NextResponse.json({ error: "Missing item key." }, { status: 400 });
  const { error } = await supabaseAdmin.from("readiness_checks").upsert(
    { key, verdict, owner_name: owner, note, updated_at: new Date().toISOString() },
    { onConflict: "key" }
  );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
