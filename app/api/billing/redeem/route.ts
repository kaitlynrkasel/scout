import { NextRequest, NextResponse } from "next/server";
import { userIdFromReq, supabaseAdmin } from "@/lib/supabaseAdmin";
import { redeemComp } from "@/lib/billing";
import { isCompCode, isCompanyCompCode } from "@/lib/stripe";

export const runtime = "nodejs";

// Redeem an access code for free-forever (comp) access. Validates the code
// server-side (the list never ships to the client) and, on success, upgrades
// the user's subscription row to unlimited via the service role.
//
// Accepts BOTH kinds of code so it works wherever you type it: a personal comp
// code (comps this account) OR a company comp code (also comps every company
// this user OWNS, so the whole team goes free). A company code entered here
// still comps the redeemer's own account too.
export async function POST(req: NextRequest) {
  const uid = await userIdFromReq(req);
  if (!uid) {
    return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  }

  let code = "";
  try {
    const body = await req.json();
    code = String(body?.code || "");
  } catch {
    /* empty body → invalid */
  }

  const personal = isCompCode(code);
  const company = isCompanyCompCode(code);
  if (!personal && !company) {
    return NextResponse.json(
      { error: "That code isn't valid. Check for typos and try again." },
      { status: 400 }
    );
  }

  // Always comp the account doing the redeeming.
  const err = await redeemComp(uid, code);
  if (err) {
    return NextResponse.json({ error: err }, { status: 500 });
  }

  // A company code also comps every workspace this user owns (the whole team
  // goes free), matching the Team-tab company-code behavior.
  let companiesComped = 0;
  if (company && supabaseAdmin) {
    const { data } = await supabaseAdmin
      .from("workspaces")
      .update({ comped: true })
      .eq("created_by", uid)
      .select("id");
    companiesComped = (data || []).length;
  }

  return NextResponse.json({
    ok: true,
    tier: "pro",
    comp: true,
    scope: company ? "company" : "personal",
    companiesComped,
  });
}
