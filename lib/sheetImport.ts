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
  writeTab?: string; // which tab new finds go to (default "Scout")
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
export function looksLikeSent(v: string): boolean {
  return /sent|submitted|submit|contacted|reached out|reached|pitched|emailed|outreached|delivered/i.test(v);
}
export function looksLikeDrafted(v: string): boolean {
  return /draft|drafted|ready|queued|to send|pending/i.test(v);
}

// Infer a status from a TAB NAME, for multi-tab trackers that organize outreach
// by tab (a "Submitted" tab, a "Denied" tab, etc.) instead of a status column.
// Returns null when the tab name says nothing about state (use the default).
export function statusFromTabName(tabName: string): ImportFindStatus | null {
  const t = (tabName || "").toLowerCase();
  if (/(denied|rejected|passed|no\b|dead|ghosted)/.test(t)) return "denied";
  if (/(response|replied|reply|answered|meeting|interview|heard back)/.test(t)) return "replied";
  if (/(submitted|submit|sent|outbox|contacted|reached|pitched|emailed)/.test(t)) return "sent";
  if (/(draft|outbox draft|ready|queued)/.test(t)) return "drafted";
  // Discovered / Manual / Pinned / Liked / Leads → still fresh
  if (/(discover|manual|pinned|liked|lead|prospect|new|to reach|contact)/.test(t)) return "new";
  return null;
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

// Read EVERY tab in a workbook and combine (union of columns), so a multi-tab
// tracking sheet is fully read, not just the first tab.
// A tab is a workbook sheet kept SEPARATE (its own headers + rows), so a
// multi-tab workbook where each tab is a different entity (Opportunities vs
// Senders vs Config) isn't blindly merged into one mess.
export type SheetTab = { name: string; headers: string[]; rows: Record<string, string>[] };

// Read every tab in a workbook, kept separate. Empty tabs are dropped.
export function workbookToTabs(XLSX: any, wb: any): SheetTab[] {
  const tabs: SheetTab[] = [];
  for (const name of wb.SheetNames || []) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const part = sheetToRows(XLSX, ws);
    if (part.rows.length) tabs.push({ name, headers: part.headers, rows: part.rows });
  }
  return tabs;
}

// Heuristic: does this tab look like a list of outreach targets (finds)? Used to
// pre-select the right tabs and skip Senders / Config / Coach-style tabs.
export function tabLooksLikeFinds(tab: SheetTab): boolean {
  const h = tab.headers.map((x) => x.toLowerCase());
  const hasName = h.some((x) => /name|artist|contact|outlet|company|title|handle/.test(x)) || tab.headers[0] === "";
  const isConfigLike = /sender|config|setting|coach|instruction|template|readme|about|key|value/i.test(tab.name);
  // A finds tab has several rows and isn't an obvious config/sender sheet.
  return tab.rows.length >= 2 && hasName && !isConfigLike;
}

export function workbookToRows(
  XLSX: any,
  wb: any
): { headers: string[]; rows: Record<string, string>[] } {
  const headers: string[] = [];
  const seen = new Set<string>();
  const rows: Record<string, string>[] = [];
  for (const name of wb.SheetNames || []) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const part = sheetToRows(XLSX, ws);
    for (const h of part.headers) {
      const k = h.toLowerCase();
      if (h && !seen.has(k)) {
        seen.add(k);
        headers.push(h);
      }
    }
    rows.push(...part.rows);
  }
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
  if (!wb.SheetNames?.length) throw new Error("The workbook has no sheets.");
  return workbookToRows(XLSX, wb);
}

// Like fetchSheetRows, but keeps each tab SEPARATE so the user can choose which
// tab(s) hold the finds. The public whole-workbook (.xlsx) path yields many
// tabs; the private-API / CSV paths are single-tab and return one entry.
export async function fetchSheetTabs(
  url: string,
  token: string | null
): Promise<SheetTab[]> {
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

  if (data.kind === "rows") {
    return [
      {
        name: "Sheet",
        headers: Array.isArray(data.headers) ? data.headers : [],
        rows: Array.isArray(data.rows) ? data.rows : [],
      },
    ];
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
    return [{ name: "Sheet", headers, rows }];
  }
  const XLSX = await import("xlsx");
  const bin = atob(String(data.b64 || ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const wb = XLSX.read(bytes, { type: "array" });
  if (!wb.SheetNames?.length) throw new Error("The workbook has no sheets.");
  return workbookToTabs(XLSX, wb);
}

// Union a set of tabs into one { headers, rows } for mapping/import. Only tabs
// that share the finds schema should be combined (the picker enforces that).
// Key used to stamp each unioned row with the tab it came from, so the importer
// can infer a status from the tab name (a "Submitted" tab, a "Denied" tab, …).
export const TAB_SOURCE_KEY = "__scout_tab";

export function unionTabs(tabs: SheetTab[]): { headers: string[]; rows: Record<string, string>[] } {
  const headers: string[] = [];
  const seen = new Set<string>();
  const rows: Record<string, string>[] = [];
  for (const t of tabs) {
    for (const h of t.headers) {
      const k = h.toLowerCase();
      if (!seen.has(k)) {
        seen.add(k);
        headers.push(h);
      }
    }
    // Stamp each row with its source tab (multi-tab trackers organize by tab).
    for (const r of t.rows) rows.push({ ...r, [TAB_SOURCE_KEY]: t.name });
  }
  return { headers, rows };
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
  // Spreadsheet checkbox/boolean artifacts ("TRUE", "FALSE", "x", "N/A") are
  // cell VALUES, not contact data, blank them so they can't become a name, a
  // LinkedIn handle, or a company. (Status columns keep their raw value, a
  // TRUE in a "Submitted" column is real signal, handled below.)
  const cleanCell = (v: string) => {
    const t = String(v || "").trim();
    return /^(true|false|yes|no|x|✓|✔|n\/?a|-|—)$/i.test(t) ? "" : t;
  };
  const EMAIL_RE = /[\w.+-]+@[\w-]+(\.[\w-]+)*\.[a-z]{2,}/i;
  for (const row of rows) {
    const name = cleanCell(
      (cols.name && String(row[cols.name] || "").trim()) || fallbackNameFromRow(row) || ""
    );
    if (!name) continue;
    let email = cols.email ? cleanCell(row[cols.email]) : "";
    // The mapped email column often comes back empty (mis-labeled headers,
    // merged cells). Fall back to scanning the whole row for anything that
    // looks like an email address, the value matters more than the header.
    if (!email || !EMAIL_RE.test(email)) {
      for (const v of Object.values(row)) {
        const m = String(v || "").match(EMAIL_RE);
        if (m) {
          email = m[0];
          break;
        }
      }
    }
    const outlet = cols.outlet ? cleanCell(row[cols.outlet]) : "";
    const role = cols.role ? cleanCell(row[cols.role]) : "";
    const url = cols.url ? cleanCell(row[cols.url]) : "";
    const handle = cols.handle ? cleanCell(row[cols.handle]) : "";
    const notes = cols.notes ? String(row[cols.notes] || "").trim() : "";
    // Prose rows ("In July 2025, covered a…", "Accepting submissions…") are
    // sheet commentary, not contacts: sentence-length "name" with no way to
    // reach anyone gets skipped instead of imported as a person.
    const looksLikeProse = name.split(/\s+/).length >= 7 || name.length > 80;
    if (looksLikeProse && !email && !url && !handle) continue;
    const statusStr = cols.status ? String(row[cols.status] || "").trim() : "";
    const tabName = String(row[TAB_SOURCE_KEY] || "");
    let status: ImportFindStatus = defaultStatus;
    if (statusStr) {
      if (looksLikeReplied(statusStr)) status = "replied";
      else if (looksLikeDenied(statusStr)) status = "denied";
      else if (looksLikeSent(statusStr)) status = "sent";
      else if (looksLikeDrafted(statusStr)) status = "drafted";
      // A bare checkbox TRUE in a status-ish column ("Submitted?", "Contacted")
      // almost always means the outreach happened.
      else if (/^(true|yes|x|✓|✔)$/i.test(statusStr)) status = "sent";
    } else if (tabName) {
      const s = statusFromTabName(tabName);
      if (s) status = s;
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
