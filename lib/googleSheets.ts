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

// Read a private sheet by URL into { headers, rows } (same shape as CSV import).
export async function readSheetByUrl(
  refreshToken: string,
  url: string
): Promise<{ headers: string[]; rows: Record<string, string>[]; title: string }> {
  const id = spreadsheetIdFromUrl(url);
  if (!id) throw new Error("Not a Google Sheets URL.");
  const at = await accessTokenFromRefresh(refreshToken);
  const title = await sheetTitleForGid(at, id, gidFromUrl(url));
  const grid = await readValues(at, id, title);
  const headers = (grid[0] || []).map((h) => String(h ?? "").trim());
  const rows = grid
    .slice(1)
    .map((r) => {
      const obj: Record<string, string> = {};
      headers.forEach((h, i) => (obj[h] = String(r[i] ?? "").trim()));
      return obj;
    })
    .filter((r) => Object.values(r).some((v) => v));
  return { headers, rows, title };
}

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

// Write-back: update a "Scout Status" column on rows Scout can match (by name or
// email), and append people it discovered that aren't in the sheet yet. Matching
// is by normalized name and/or email against the sheet's own columns.
export async function writeBackToSheet(
  refreshToken: string,
  url: string,
  finds: {
    name: string;
    email?: string;
    status: string;
    company?: string;
    role?: string;
  }[]
): Promise<{ updated: number; appended: number }> {
  const id = spreadsheetIdFromUrl(url);
  if (!id || !finds.length) return { updated: 0, appended: 0 };
  const at = await accessTokenFromRefresh(refreshToken);
  const title = await sheetTitleForGid(at, id, gidFromUrl(url));
  const grid = await readValues(at, id, title);
  const headers = (grid[0] || []).map((h) => String(h ?? "").trim());
  const lc = headers.map((h) => h.toLowerCase());

  const nameCol = lc.findIndex((h) => /name|contact|person/.test(h));
  const emailCol = lc.findIndex((h) => /email|e-mail/.test(h));
  let statusCol = lc.findIndex((h) => h === STATUS_HEADER.toLowerCase());

  const norm = (s: string) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  // Index existing rows by name + email so we can find matches.
  const rowByKey = new Map<string, number>();
  for (let r = 1; r < grid.length; r++) {
    if (nameCol >= 0 && grid[r][nameCol]) rowByKey.set("n:" + norm(grid[r][nameCol]), r);
    if (emailCol >= 0 && grid[r][emailCol]) rowByKey.set("e:" + norm(grid[r][emailCol]), r);
  }

  const requests: { range: string; values: string[][] }[] = [];

  // Ensure a Scout Status column header exists (append one if missing).
  if (statusCol < 0) {
    statusCol = headers.length;
    requests.push({
      range: `${title}!${colLetter(statusCol)}1`,
      values: [[STATUS_HEADER]],
    });
  }

  let updated = 0;
  const toAppend: string[][] = [];
  for (const f of finds) {
    const byEmail = f.email ? rowByKey.get("e:" + norm(f.email)) : undefined;
    const rowIdx = byEmail ?? rowByKey.get("n:" + norm(f.name));
    if (rowIdx !== undefined) {
      requests.push({
        range: `${title}!${colLetter(statusCol)}${rowIdx + 1}`,
        values: [[f.status]],
      });
      updated++;
    } else {
      // New person Scout found — build a row aligned to the sheet's columns.
      const row = new Array(Math.max(headers.length, statusCol + 1)).fill("");
      if (nameCol >= 0) row[nameCol] = f.name;
      if (emailCol >= 0 && f.email) row[emailCol] = f.email;
      const companyCol = lc.findIndex((h) => /company|outlet|organization|employer/.test(h));
      if (companyCol >= 0 && f.company) row[companyCol] = f.company;
      const roleCol = lc.findIndex((h) => /role|title|position/.test(h));
      if (roleCol >= 0 && f.role) row[roleCol] = f.role;
      row[statusCol] = f.status;
      toAppend.push(row);
    }
  }

  // Apply cell updates in one batch.
  if (requests.length) {
    await api(at, `/${id}/values:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({ valueInputOption: "RAW", data: requests }),
    });
  }
  // Append the new rows.
  if (toAppend.length) {
    await api(
      at,
      `/${id}/values/${encodeURIComponent(title)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      { method: "POST", body: JSON.stringify({ values: toAppend }) }
    );
  }
  return { updated, appended: toAppend.length };
}
