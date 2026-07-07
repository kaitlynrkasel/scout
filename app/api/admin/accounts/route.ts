import { NextResponse } from "next/server";
import { supabaseAdmin, userFromReq } from "@/lib/supabaseAdmin";
import { isOwnerEmail } from "@/lib/owner";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

// GET /api/admin/accounts — owner-only. Lists every account (email, name,
// use case, a few engagement counts) so the concierge picker can target one.
// Also folds in how many concierge finds are already queued per email (whether
// or not that email has an account yet), so the operator can see pending work.
export async function GET(req: Request) {
  const me = await userFromReq(req);
  if (!me || !isOwnerEmail(me.email)) {
    return NextResponse.json({ error: "Not authorized." }, { status: 403 });
  }
  if (!supabaseAdmin) {
    return NextResponse.json(
      { error: "Supabase service role key not configured." },
      { status: 500 }
    );
  }

  const [authRes, profilesRes, statesRes, seedsRes] = await Promise.all([
    supabaseAdmin.auth.admin.listUsers({ perPage: 1000 }),
    supabaseAdmin.from("profiles").select("id, name, use_case, bio"),
    supabaseAdmin.from("user_state").select("user_id, data, updated_at"),
    supabaseAdmin
      .from("admin_seeded_finds")
      .select("email, consumed_at"),
  ]);

  const profById = new Map<string, any>();
  for (const p of profilesRes.data || []) profById.set((p as any).id, p);
  const stateById = new Map<string, any>();
  for (const s of statesRes.data || []) stateById.set((s as any).user_id, s);

  // Pending (un-consumed) concierge seeds per email — includes emails with no
  // account yet, so those still surface below via the seed-only pass.
  const pendingByEmail = new Map<string, number>();
  const seededEmails = new Set<string>();
  for (const row of seedsRes.data || []) {
    const email = String((row as any).email || "").toLowerCase();
    if (!email) continue;
    seededEmails.add(email);
    if (!(row as any).consumed_at) {
      pendingByEmail.set(email, (pendingByEmail.get(email) || 0) + 1);
    }
  }

  type Account = {
    email: string;
    name: string;
    useCase: string;
    hasAccount: boolean;
    finds: number;
    sent: number;
    replied: number;
    searches: number;
    pendingSeeds: number;
    updatedAt: string;
  };
  const accounts: Account[] = [];
  const seenEmails = new Set<string>();

  for (const u of authRes?.data?.users || []) {
    const email = String(u.email || "").toLowerCase();
    if (!email) continue;
    seenEmails.add(email);
    const prof = profById.get(u.id) || {};
    const state = stateById.get(u.id);
    const data = (state?.data || {}) as any;
    const finds: any[] = Array.isArray(data.finds) ? data.finds : [];
    let sent = 0;
    let replied = 0;
    for (const f of finds) {
      const st = String(f?.status || "").toLowerCase();
      if (st === "sent") sent++;
      else if (st === "replied") replied++;
    }
    accounts.push({
      email,
      name: String(prof.name || data?.profileExtras?.companyName || ""),
      useCase: String(prof.use_case || ""),
      hasAccount: true,
      finds: finds.length,
      sent,
      replied,
      searches: Number(data?.activity?.searches || 0),
      pendingSeeds: pendingByEmail.get(email) || 0,
      updatedAt: String(state?.updated_at || ""),
    });
  }

  // Emails that only exist as concierge seeds (invited/prepped before signup).
  for (const email of seededEmails) {
    if (seenEmails.has(email)) continue;
    accounts.push({
      email,
      name: "",
      useCase: "",
      hasAccount: false,
      finds: 0,
      sent: 0,
      replied: 0,
      searches: 0,
      pendingSeeds: pendingByEmail.get(email) || 0,
      updatedAt: "",
    });
  }

  // Most-recently-active first; pre-signup (no account) rows sink to the bottom.
  accounts.sort(
    (a, b) =>
      Number(b.hasAccount) - Number(a.hasAccount) ||
      (b.updatedAt > a.updatedAt ? 1 : b.updatedAt < a.updatedAt ? -1 : 0)
  );

  return NextResponse.json({ accounts, generatedAt: new Date().toISOString() });
}
