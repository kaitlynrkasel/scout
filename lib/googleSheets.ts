// Google Sheets integration: a SEPARATE OAuth flow (its own redirect + scope) so
// sheet access is opt-in and doesn't touch the Gmail send consent. Reuses the
// generic Google token helpers from lib/gmail. Reads private sheets and writes
// back — updates a "Scout Status" column on matching rows and appends new finds.

import { accessTokenFromRefresh, emailFromIdToken } from "./gmail";

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const API = "https://sheets.googleapis.com/v4/spreadsheets";

// Read + write the user's sheets, plus email/openid to label the connection.
const SHEETS_SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "openid",
  "email",
];

export const STATUS_HEADER = "Scout Status";

export function sheetsRedirectUri(origin: string): string {
  return `${origin}/api/sheets/callback`;
}

export function sheetsAuthUrl(origin: string, state: string): string {
  const p = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID || "",
    redirect_uri: sheetsRedirectUri(origin),
    response_type: "code",
    scope: SHEETS_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `${GOOGLE_AUTH}?${p.toString()}`;
}

export async function sheetsExchangeCode(origin: string, code: string): Promise<any> {
  const body = new URLSearchParams({
    code,
    client_id: process.env.GOOGLE_CLIENT_ID || "",
    client_secret: process.env.GOOGLE_CLIENT_SECRET || "",
    redirect_uri: sheetsRedirectUri(origin),
    grant_type: "authorization_code",
  });
  const r = await fetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) throw new Error("token exchange failed: " + (await r.text()));
  return r.json();
}

export { emailFromIdToken };

// ---- URL parsing ----
export function spreadsheetIdFromUrl(url: string): string | null {
  return url.match(/spreadsheets\/d\/([a-zA-Z0-9-_]+)/)?.[1] || null;
}
export function gidFromUrl(url: string): string {
  return url.match(/[#&?]gid=([0-9]+)/)?.[1] || "0";
}

// ---- Sheets API ----
async function api(accessToken: string, path: string, init?: RequestInit) {
  const r = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      ...(init?.headers || {}),
    },
  });
  if (!r.ok) throw new Error(`Sheets API ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

// The tab (title) for a given gid, so we can address ranges in A1 notation.
export async function sheetTitleForGid(
  accessToken: string,
  spreadsheetId: string,
  gid: string
): Promise<string> {
  const meta = await api(accessToken, `/${spreadsheetId}?fields=sheets.properties`);
  const sheets = meta.sheets || [];
  const match = sheets.find((s: any) => String(s.properties?.sheetId) === String(gid));
  return (match || sheets[0])?.properties?.title || "Sheet1";
}

// Every tab title in the workbook (so we can read them all).
async function allSheetTitles(accessToken: string, spreadsheetId: string): Promise<string[]> {
  const meta = await api(accessToken, `/${spreadsheetId}?fields=sheets.properties`);
  return (meta.sheets || [])
    .map((s: any) => String(s.properties?.title || ""))
    .filter(Boolean);
}

// Whole-tab values as a string grid (first row = headers).
export async function readValues(
  accessToken: string,
  spreadsheetId: string,
  title: string
): Promise<string[][]> {
  const data = await api(
    accessToken,
    `/${spreadsheetId}/values/${encodeURIComponent(title)}?valueRenderOption=FORMATTED_VALUE`
  );
  return (data.values || []).map((row: any[]) => row.map((c) => String(c ?? "")));
}

function gridToHeaderRows(grid: string[][]): { headers: string[]; rows: Record<string, string>[] } {
  const headers = (grid[0] || []).map((h) => String(h ?? "").trim());
  const rows = grid
    .slice(1)
    .map((r) => {
      const obj: Record<string, string> = {};
      headers.forEach((h, i) => (obj[h] = String(r[i] ?? "").trim()));
      return obj;
    })
    .filter((r) => Object.values(r).some((v) => v));
  return { headers, rows };
}

// Read a private sheet by URL into { headers, rows } — reads EVERY tab in the
// workbook and combines them (union of columns), so a multi-tab tracking sheet
// isn't missed. Same shape as the CSV import.
export async function readSheetByUrl(
  refreshToken: string,
  url: string
): Promise<{ headers: string[]; rows: Record<string, string>[]; title: string }> {
  const id = spreadsheetIdFromUrl(url);
  if (!id) throw new Error("Not a Google Sheets URL.");
  const at = await accessTokenFromRefresh(refreshToken);
  const titles = await allSheetTitles(at, id);
  if (!titles.length) throw new Error("The workbook has no tabs.");

  const headerSet: string[] = [];
  const seen = new Set<string>();
  const rows: Record<string, string>[] = [];
  for (const title of titles) {
    let grid: string[][] = [];
    try {
      grid = await readValues(at, id, title);
    } catch {
      continue; // skip an unreadable tab rather than fail the whole read
    }
    const part = gridToHeaderRows(grid);
    for (const h of part.headers) {
      const k = h.toLowerCase();
      if (h && !seen.has(k)) {
        seen.add(k);
        headerSet.push(h);
      }
    }
    rows.push(...part.rows);
  }
  return { headers: headerSet, rows, title: titles.join(", ") };
}

// Write-back always targets the tab in the link (gid) — see writeBackToSheet.

const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
function colLetter(i: number): string {
  let s = "";
  i += 1;
  while (i > 0) {
    const rem = (i - 1) % 26;
    s = A[rem] + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}

export interface WriteFind {
  name: string;
  email?: string;
  status: string;
  company?: string;
  role?: string;
}

export interface WritePlan {
  trackingTab: string; // the tab the user linked (where statuses go)
  statusColumn: string; // the (new) column statuses are written to
  addsStatusColumn: boolean; // true = we'll add a brand-new column (never overwrite)
  statusUpdates: number; // rows we'll set a status on (never touches other cells)
  newFinds: number; // people not in the sheet yet
  newFindsTab: string; // where new finds go (a separate tab by default)
  newTabExists: boolean; // whether that tab already exists (else we create it)
}

const norm = (s: string) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
// Fixed columns for the Scout tab we manage, so appends always line up.
const SCOUT_TAB_HEADERS = ["Name", "Email", "Company", "Role", STATUS_HEADER];

// Write-back, safe by default:
//  • statuses go into a NEW "Scout Status" column on the tab you linked (adds a
//    column, never overwrites existing cells),
//  • NEW finds go into a SEPARATE tab ("Scout" by default; configurable), created
//    if missing — your existing tabs' data is never touched,
//  • already-written finds match against both tabs, so re-running just updates
//    the status cell instead of appending duplicates.
// Pass { preview: true } to get the plan without writing anything.
export async function writeBackToSheet(
  refreshToken: string,
  url: string,
  finds: WriteFind[],
  opts: { newFindsTab?: string; preview?: boolean } = {}
): Promise<{ updated: number; appended: number; plan: WritePlan }> {
  const newFindsTab = (opts.newFindsTab || "Scout").trim() || "Scout";
  const id = spreadsheetIdFromUrl(url);
  const empty: WritePlan = {
    trackingTab: "",
    statusColumn: STATUS_HEADER,
    addsStatusColumn: false,
    statusUpdates: 0,
    newFinds: 0,
    newFindsTab,
    newTabExists: false,
  };
  if (!id || !finds.length) return { updated: 0, appended: 0, plan: empty };
  const at = await accessTokenFromRefresh(refreshToken);

  // --- Tracking tab (the linked gid): where statuses on existing rows go. ---
  const trackTitle = await sheetTitleForGid(at, id, gidFromUrl(url));
  const trackGrid = await readValues(at, id, trackTitle);
  const tHeaders = (trackGrid[0] || []).map((h) => String(h ?? "").trim());
  const tLc = tHeaders.map((h) => h.toLowerCase());
  const tNameCol = tLc.findIndex((h) => /name|contact|person/.test(h));
  const tEmailCol = tLc.findIndex((h) => /email|e-mail/.test(h));
  let tStatusCol = tLc.findIndex((h) => h === STATUS_HEADER.toLowerCase());

  // --- Scout tab (separate; may not exist yet). ---
  const titles = await allSheetTitles(at, id);
  const scoutExists = titles.some((t) => t.toLowerCase() === newFindsTab.toLowerCase());
  let scoutGrid: string[][] = [];
  if (scoutExists) {
    try {
      scoutGrid = await readValues(at, id, newFindsTab);
    } catch {
      /* treat as empty */
    }
  }
  const sHeaders =
    scoutExists && scoutGrid[0]?.length
      ? scoutGrid[0].map((h) => String(h ?? "").trim())
      : SCOUT_TAB_HEADERS;
  const sLc = sHeaders.map((h) => h.toLowerCase());
  const sNameCol = Math.max(0, sLc.findIndex((h) => /name/.test(h)));
  const sEmailCol = sLc.findIndex((h) => /email/.test(h));
  let sStatusCol = sLc.findIndex((h) => h === STATUS_HEADER.toLowerCase());
  if (sStatusCol < 0) sStatusCol = SCOUT_TAB_HEADERS.indexOf(STATUS_HEADER);

  // Index existing rows across BOTH tabs so nothing is appended twice.
  const index = new Map<string, { tab: "track" | "scout"; row: number }>();
  for (let r = 1; r < trackGrid.length; r++) {
    if (tNameCol >= 0 && trackGrid[r][tNameCol]) index.set("n:" + norm(trackGrid[r][tNameCol]), { tab: "track", row: r });
    if (tEmailCol >= 0 && trackGrid[r][tEmailCol]) index.set("e:" + norm(trackGrid[r][tEmailCol]), { tab: "track", row: r });
  }
  for (let r = 1; r < scoutGrid.length; r++) {
    if (sNameCol >= 0 && scoutGrid[r][sNameCol]) index.set("n:" + norm(scoutGrid[r][sNameCol]), { tab: "scout", row: r });
    if (sEmailCol >= 0 && scoutGrid[r][sEmailCol]) index.set("e:" + norm(scoutGrid[r][sEmailCol]), { tab: "scout", row: r });
  }

  const statusUpdates: { tab: "track" | "scout"; row: number; status: string }[] = [];
  const toAppend: WriteFind[] = [];
  for (const f of finds) {
    const hit = (f.email ? index.get("e:" + norm(f.email)) : undefined) ?? index.get("n:" + norm(f.name));
    if (hit) statusUpdates.push({ ...hit, status: f.status });
    else toAppend.push(f);
  }

  const willAddStatusCol = tStatusCol < 0 && statusUpdates.some((u) => u.tab === "track");
  const plan: WritePlan = {
    trackingTab: trackTitle,
    statusColumn: STATUS_HEADER,
    addsStatusColumn: willAddStatusCol,
    statusUpdates: statusUpdates.length,
    newFinds: toAppend.length,
    newFindsTab,
    newTabExists: scoutExists,
  };
  if (opts.preview) return { updated: 0, appended: 0, plan };

  // ---- Perform writes (safe: only a new column + a separate tab) ----
  const cellReqs: { range: string; values: string[][] }[] = [];
  if (willAddStatusCol) {
    tStatusCol = tHeaders.length;
    cellReqs.push({ range: `${trackTitle}!${colLetter(tStatusCol)}1`, values: [[STATUS_HEADER]] });
  }

  // Create the Scout tab (with headers) if we need to append and it's missing.
  if (toAppend.length && !scoutExists) {
    await api(at, `/${id}:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: newFindsTab } } }] }),
    });
    await api(
      at,
      `/${id}/values/${encodeURIComponent(newFindsTab)}!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      { method: "POST", body: JSON.stringify({ values: [SCOUT_TAB_HEADERS] }) }
    );
  }

  // Status cell updates (each is a single cell — never touches neighbours).
  for (const u of statusUpdates) {
    const title = u.tab === "track" ? trackTitle : newFindsTab;
    const col = u.tab === "track" ? tStatusCol : sStatusCol;
    if (col < 0) continue;
    cellReqs.push({ range: `${title}!${colLetter(col)}${u.row + 1}`, values: [[u.status]] });
  }
  if (cellReqs.length) {
    await api(at, `/${id}/values:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({ valueInputOption: "RAW", data: cellReqs }),
    });
  }

  // Append new finds to the Scout tab (aligned to SCOUT_TAB_HEADERS).
  if (toAppend.length) {
    const rows = toAppend.map((f) => [f.name, f.email || "", f.company || "", f.role || "", f.status]);
    await api(
      at,
      `/${id}/values/${encodeURIComponent(newFindsTab)}!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      { method: "POST", body: JSON.stringify({ values: rows }) }
    );
  }
  return { updated: statusUpdates.length, appended: toAppend.length, plan };
}
