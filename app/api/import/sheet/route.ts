import { NextRequest, NextResponse } from "next/server";
import { userIdFromReq } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Fetch a spreadsheet by link so the client can import it without a file. Handles
// Google Sheets share/edit links (converted to a CSV export) and direct public
// .csv/.xlsx URLs. Fetched server-side to avoid CORS, with an SSRF guard so a
// user can't point it at internal hosts.

// Block loopback / link-local / private ranges (basic SSRF protection).
function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h === "0.0.0.0") return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true; // link-local (incl. cloud metadata)
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true; // 172.16–31.x
  return false;
}

// Turn a Google Sheets edit/view link into its CSV-export URL for the tab in view.
function googleCsvUrl(url: string): string | null {
  const m = url.match(/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!m) return null;
  const id = m[1];
  const gid = url.match(/[#&?]gid=([0-9]+)/)?.[1] || "0";
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
}

const NOT_PUBLIC =
  "Couldn't read that sheet. Make sure it's shared so anyone with the link can view it (Share → General access → Anyone with the link → Viewer), then try again.";

export async function POST(req: NextRequest) {
  const uid = await userIdFromReq(req);
  if (!uid) return NextResponse.json({ error: "Please sign in first." }, { status: 401 });

  const { url } = await req.json().catch(() => ({}));
  const raw = String(url || "").trim();
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return NextResponse.json({ error: "That doesn't look like a valid link." }, { status: 400 });
  }
  if (parsed.protocol !== "https:") {
    return NextResponse.json({ error: "Use an https:// link." }, { status: 400 });
  }
  if (isBlockedHost(parsed.hostname)) {
    return NextResponse.json({ error: "That link isn't allowed." }, { status: 400 });
  }

  const gUrl = googleCsvUrl(raw);
  const fetchUrl = gUrl || raw;
  const wantsCsv = !!gUrl || /\.csv(\?|$)/i.test(fetchUrl);

  let res: Response;
  try {
    res = await fetch(fetchUrl, {
      redirect: "follow",
      headers: { "user-agent": "Scout-Importer/1.0" },
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return NextResponse.json({ error: "Couldn't reach that link." }, { status: 502 });
  }
  if (!res.ok) {
    return NextResponse.json({ error: gUrl ? NOT_PUBLIC : `The link returned ${res.status}.` }, { status: 400 });
  }
  const ct = (res.headers.get("content-type") || "").toLowerCase();

  // A Google sign-in / permission page comes back as HTML — that means it isn't
  // shared publicly, so the import can't read it.
  if (ct.includes("text/html")) {
    return NextResponse.json({ error: NOT_PUBLIC }, { status: 400 });
  }

  const isCsv = wantsCsv || ct.includes("csv") || ct.includes("text/plain");
  if (isCsv) {
    const text = await res.text();
    if (/^\s*<(?:!doctype|html)/i.test(text)) {
      return NextResponse.json({ error: NOT_PUBLIC }, { status: 400 });
    }
    if (!text.trim()) {
      return NextResponse.json({ error: "That sheet looks empty." }, { status: 400 });
    }
    return NextResponse.json({ kind: "csv", text });
  }

  // Otherwise treat it as a binary spreadsheet (.xlsx/.ods/…) and hand back bytes.
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > 8 * 1024 * 1024) {
    return NextResponse.json({ error: "That file is too large (over 8 MB)." }, { status: 400 });
  }
  return NextResponse.json({ kind: "binary", b64: buf.toString("base64") });
}
