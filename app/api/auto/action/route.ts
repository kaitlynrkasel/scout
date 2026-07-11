import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { verifyAction } from "@/lib/autoSearch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Small HTML confirmation page for a tap from the email — no login needed.
function page(title: string, body: string, ok = true): Response {
  const color = ok ? "#5F6247" : "#9E3F1F";
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Scout</title></head>
<body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#F5F2EB;color:#241C13">
  <div style="max-width:460px;margin:12vh auto;padding:32px;background:#fff;border:1px solid #DED6C7;border-radius:16px;text-align:center">
    <div style="font-size:34px;line-height:1">${ok ? "✓" : "•"}</div>
    <h1 style="font-size:20px;margin:14px 0 6px;color:${color}">${title}</h1>
    <p style="font-size:14px;line-height:1.55;color:#57503f;margin:0 0 20px">${body}</p>
    <a href="/app" style="display:inline-block;background:#241C13;color:#F5F2EB;font-weight:700;font-size:14px;text-decoration:none;padding:11px 20px;border-radius:9px">Open Scout</a>
  </div>
</body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("t") || "";
  const parsed = verifyAction(token);
  if (!parsed) {
    return page("Link expired or invalid", "This action link couldn't be verified. Open Scout to review your finds.", false);
  }
  if (!supabaseAdmin) {
    return page("Not available", "Scout isn't fully configured. Try again from the app.", false);
  }
  const { findId, action } = parsed;

  // Load the find (+ the parent search's email for seeding into the pipeline).
  const { data: row } = await supabaseAdmin
    .from("auto_finds")
    .select("id, user_id, status, opp, auto_searches(email)")
    .eq("id", findId)
    .maybeSingle();
  if (!row) {
    return page("Not found", "That find is no longer available. Open Scout to review your pipeline.", false);
  }
  const opp = (row as any).opp || {};
  const name = String(opp?.name || "this find");

  if ((row as any).status && (row as any).status !== "new") {
    const already = (row as any).status;
    return page(
      already === "approved" || already === "drafted" ? "Already approved" : "Already passed",
      `You already recorded a decision on ${name}.`,
    );
  }

  if (action === "deny") {
    await supabaseAdmin
      .from("auto_finds")
      .update({ status: "denied", decided_at: new Date().toISOString() })
      .eq("id", findId);
    return page("Passed", `Scout won't surface ${name} again for this search.`);
  }

  // Approve: mark it, then drop the opportunity into the user's Scout pipeline
  // using the same seeded-finds channel concierge uses, so it appears in Finds.
  await supabaseAdmin
    .from("auto_finds")
    .update({ status: "approved", decided_at: new Date().toISOString() })
    .eq("id", findId);

  const email = String((row as any).auto_searches?.email || "").toLowerCase();
  if (email && opp?.name) {
    await supabaseAdmin.from("admin_seeded_finds").insert({
      email,
      opp,
      note: "Approved from an auto-search email",
      created_by: "auto-search",
    });
  }

  return page("Approved", `${name} is on its way to your Scout pipeline — open Scout to draft your message.`);
}
