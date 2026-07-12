// Shared spreadsheet-import logic used by BOTH the manual importer modal and the
// background auto-sync. Client-side (uses papaparse + a dynamic SheetJS import),
// but has no React so it can run headlessly on a timer. Fetching goes through
// /api/import/sheet (CORS + SSRF safe).

import Papa from "papaparse";
import type { Opportunity } from "@/lib/types";

export type FieldKey =
  | ""
  | "name"
  | "email"
  | "outlet"
  | "role"
  | "url"
  | "handle"
  | "notes"
  | "status";

export type ImportFindStatus = "new" | "drafted" | "sent" | "replied" | "denied";

export interface ImportFind {
  id: string;
  projectId: string;
  categoryId?: string;
  status: ImportFindStatus;
  opp: Opportunity;
  addedAt: number;
  denyReason?: string;
  sentAt?: number;
}

// One saved linked sheet that Scout keeps re-reading. Stored in user state.
export interface SyncedSheet {
  id: string;
  url: string;
  label: string;
  projectId: string;
  mapping: Record<string, FieldKey>;
  defaultStatus: ImportFindStatus;
  allowWrite?: boolean; // explicit per-sheet permission for Scout to EDIT the sheet
  understanding?: number; // 0-100, how well Scout understands this document
  understandingSummary?: string; // Scout's read of the sheet (from the gate)
  understandingAnswers?: string; // the user's answers folded in during the gate
  lastSyncedAt?: number;
  lastCount?: number; // rows added on the most recent sync
}

export const FIELD_LABELS: Record<Exclude<FieldKey, "">, string> = {
  name: "Name (required)",
  email: "Email",
  outlet: "Company / outlet",
  role: "Role / title",
  url: "URL / website",
  handle: "LinkedIn / handle",
  notes: "Notes",
  status: "Status column",
};

// Guess which Scout field a column header corresponds to.
export function guessField(header: string): FieldKey {
  const h = header.toLowerCase().trim();
  if (!h) return "";
  if (/(first\s*name|full\s*name|contact\s*name|\bname\b|person)/.test(h)) return "name";
  if (/(email|e-mail|mail)/.test(h)) return "email";
  if (/(company|organization|organisation|employer|outlet|publication|firm|business)/.test(h)) return "outlet";
  if (/(role|title|position|job)/.test(h)) return "role";
  if (/(url|website|link|profile)/.test(h) && !/linkedin/.test(h)) return "url";
  if (/(linkedin|handle|twitter|instagram|social)/.test(h)) return "handle";
  if (/(note|comment|message|context|about|memo)/.test(h)) return "notes";
  if (/(status|stage|state|reply|replied|outcome|result)/.test(h)) return "status";
  return "";
}

export function fallbackNameFromRow(row: Record<string, string>): string {
  const first = Object.entries(row).find(([k]) => /first\s*name/i.test(k))?.[1];
  const last = Object.entries(row).find(([k]) => /last\s*name/i.test(k))?.[1];
  return [first, last].filter(Boolean).join(" ").trim();
}

function urlHost(u: string): string {
  const m = String(u || "").match(/^https?:\/\/([^/?#]+)/i);
  return m ? m[1].replace(/^www\./, "").toLowerCase() : "";
}

export function looksLikeReplied(v: string): boolean {
  return /reply|replied|responded|answered|meeting|interview|hired/i.test(v);
}
export function looksLikeDenied(v: string): boolean {
  return /no|passed|rejected|ghosted|dead|declin/i.test(v);
}

// SheetJS worksheet → { headers, rows } matching the CSV parser's shape.
function sheetToRows(XLSX: any, ws: any): { headers: string[]; rows: Record<string, string>[] } {
  const aoa: any[][] = XLSX.utils.sheet_to_json(ws, {
    header: 1,
    blankrows: false,
    defval: "",
    raw: false,
  });
  const headers = (aoa[0] || []).map((h: any) => String(h ?? "").trim());
  const rows = aoa
    .slice(1)
    .map((r) => {
      const obj: Record<string, string> = {};
      headers.forEach((h: string, i: number) => {
        obj[h] = String(r[i] ?? "").trim();
      });
      return obj;
    })
    .filter((r) => Object.values(r).some((v) => v));
  return { headers, rows };
}

// Fetch a linked sheet through the server route and parse it to { headers, rows }.
export async function fetchSheetRows(
  url: string,
  token: string | null
): Promise<{ headers: string[]; rows: Record<string, string>[] }> {
  const res = await fetch("/api/import/sheet", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ url }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || "Couldn't read that link.");

  // Private read via the Sheets API returns parsed rows straight away.
  if (data.kind === "rows") {
    return {
      headers: Array.isArray(data.headers) ? data.headers : [],
      rows: Array.isArray(data.rows) ? data.rows : [],
    };
  }

  if (data.kind === "csv") {
    const result = Papa.parse<Record<string, string>>(String(data.text || ""), {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim(),
    });
    const rows = (result.data || []).filter((r) =>
      Object.values(r).some((v) => String(v || "").trim())
    );
    const headers = (result.meta.fields || []).map((h) => h.trim());
    return { headers, rows };
  }
  const XLSX = await import("xlsx");
  const bin = atob(String(data.b64 || ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const wb = XLSX.read(bytes, { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error("The workbook has no sheets.");
  return sheetToRows(XLSX, ws);
}

// Turn mapped rows into Find records (deterministic ids, so re-syncing the same
// row produces the same id and dedups cleanly against existing finds).
export function rowsToFinds(opts: {
  rows: Record<string, string>[];
  mapping: Record<string, FieldKey>;
  defaultStatus: ImportFindStatus;
  projectId: string;
  sourceLabel: string;
}): ImportFind[] {
  const { rows, mapping, defaultStatus, projectId, sourceLabel } = opts;
  if (!projectId) return [];
  const cols: Partial<Record<Exclude<FieldKey, "">, string>> = {};
  for (const [col, field] of Object.entries(mapping)) if (field) cols[field] = col;

  const seen = new Set<string>();
  const finds: ImportFind[] = [];
  const now = Date.now();
  let idx = 0;
  for (const row of rows) {
    const name =
      (cols.name && String(row[cols.name] || "").trim()) || fallbackNameFromRow(row) || "";
    if (!name) continue;
    const email = cols.email ? String(row[cols.email] || "").trim() : "";
    const outlet = cols.outlet ? String(row[cols.outlet] || "").trim() : "";
    const role = cols.role ? String(row[cols.role] || "").trim() : "";
    const url = cols.url ? String(row[cols.url] || "").trim() : "";
    const handle = cols.handle ? String(row[cols.handle] || "").trim() : "";
    const notes = cols.notes ? String(row[cols.notes] || "").trim() : "";
    const statusStr = cols.status ? String(row[cols.status] || "").trim() : "";
    let status: ImportFindStatus = defaultStatus;
    if (statusStr) {
      if (looksLikeReplied(statusStr)) status = "replied";
      else if (looksLikeDenied(statusStr)) status = "denied";
    }
    const opp: Opportunity = {
      id: `import-${now}-${idx++}`,
      name,
      outlet,
      url: url || (handle && !url ? handle : ""),
      channel: email ? "Email" : handle ? "LinkedIn" : url ? "Website" : "Unknown",
      contactEmail: email,
      contactName: name,
      contactRole: role,
      contactHandle: handle,
      contactPhone: "",
      location: "",
      timezone: "",
      fitScore: null as any,
      whyItFits: notes,
      sourceTitle: sourceLabel,
      sourceSnippet: notes.slice(0, 220),
    };
    const nm = name.toLowerCase().replace(/[^a-z0-9]/g, "");
    const host = urlHost(opp.url || "");
    const id = `${projectId}::${nm}::${host}`;
    if (seen.has(id)) continue;
    seen.add(id);
    finds.push({
      id,
      projectId,
      status,
      opp,
      addedAt: now,
      denyReason: status === "denied" ? "already contacted (imported)" : undefined,
      sentAt: status === "sent" || status === "replied" ? now : undefined,
    });
  }
  return finds;
}
