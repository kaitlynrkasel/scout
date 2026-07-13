import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { verifyUnsub } from "@/lib/unsubscribe";

export const runtime = "nodejs";

// Records an opt-out so the sender's future outreach to this recipient is
// suppressed (see the send route's suppression check). Supports both:
//   - GET  (recipient clicks the link in the email)          -> HTML confirmation
//   - POST (RFC 8058 one-click, from the mail client button) -> 200
// The token is HMAC-signed and binds sender+recipient, so opt-outs can't be forged.

async function record(token: string): Promise<boolean> {
  const parsed = verifyUnsub(token);
  if (!parsed || !supabaseAdmin) return false;
  try {
    await supabaseAdmin.from("unsubscribes").upsert(
      { user_id: parsed.userId, email: parsed.email },
      { onConflict: "user_id,email" }
    );
    return true;
  } catch {
    return false;
  }
}

function page(title: string, msg: string, status = 200): NextResponse {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#F5F2EB;color:#3A2A1B;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px}.card{max-width:440px;background:#fff;border:1px solid #E7DFD0;border-radius:16px;padding:32px;box-shadow:0 20px 40px -24px rgba(36,24,14,.35)}h1{font-size:20px;margin:0 0 8px}p{font-size:14px;line-height:1.6;color:#5b5142;margin:0}</style></head><body><div class="card"><h1>${title}</h1><p>${msg}</p></div></body></html>`;
  return new NextResponse(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("t") || "";
  const ok = await record(token);
  return ok
    ? page("You're unsubscribed", "You won't receive further outreach from this sender. You can close this tab.")
    : page(
        "Link expired or invalid",
        "We couldn't process this unsubscribe request. If you keep getting messages, reply to the sender and ask to be removed.",
        400
      );
}

export async function POST(req: NextRequest) {
  // One-click clients send the token in the query string; some also POST a body.
  let token = req.nextUrl.searchParams.get("t") || "";
  if (!token) {
    try {
      const form = await req.formData();
      token = String(form.get("t") || "");
    } catch {
      /* no body */
    }
  }
  const ok = await record(token);
  return NextResponse.json({ ok }, { status: ok ? 200 : 400 });
}
