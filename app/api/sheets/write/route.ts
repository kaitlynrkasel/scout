import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, userIdFromReq } from "@/lib/supabaseAdmin";
import { writeBackToSheet } from "@/lib/googleSheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Push a set of finds back to a linked Google Sheet: update the "Scout Status"
// column on matching rows, append the rest. Needs a Google Sheets connection.
export async function POST(req: NextRequest) {
  const uid = await userIdFromReq(req);
  if (!uid || !supabaseAdmin) {
    return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  }
  const { url, finds } = await req.json().catch(() => ({}));
  if (!url || !Array.isArray(finds) || !finds.length) {
    return NextResponse.json({ error: "Nothing to write." }, { status: 400 });
  }
  const { data: conn } = await supabaseAdmin
    .from("sheets_connections")
    .select("refresh_token")
    .eq("user_id", uid)
    .maybeSingle();
  if (!conn?.refresh_token) {
    return NextResponse.json(
      { error: "Connect Google Sheets first (Profile → Connect Google Sheets)." },
      { status: 400 }
    );
  }
  try {
    const result = await writeBackToSheet(
      conn.refresh_token as string,
      String(url),
      finds.map((f: any) => ({
        name: String(f.name || ""),
        email: f.email ? String(f.email) : "",
        status: String(f.status || ""),
        company: f.company ? String(f.company) : "",
        role: f.role ? String(f.role) : "",
      }))
    );
    return NextResponse.json({ ok: true, ...result });
  } catch (e: any) {
    return NextResponse.json(
      { error: `Couldn't write to the sheet: ${String(e?.message || "").slice(0, 200)}` },
      { status: 502 }
    );
  }
}
