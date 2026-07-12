"use client";

// Drop-a-CSV importer for existing outreach history. Client-side only: parses
// with papaparse, auto-maps common column names (LinkedIn / Google Sheets /
// Notion), lets the user confirm mapping + status, then hands finished Find
// records back to the parent. Dedup + persistence uses the existing pipeline.

import { useEffect, useMemo, useRef, useState } from "react";
import Papa from "papaparse";
import type { Opportunity } from "@/lib/types";

// Local mirrors of the Find / Project / FindStatus shapes from page.tsx. The
// component just needs enough to build records and drop them back in via the
// onImport callback.
type FindStatus = "new" | "drafted" | "sent" | "replied" | "denied";
interface Project {
  id: string;
  name: string;
  useCase: string;
  context?: string;
}
interface Find {
  id: string;
  projectId: string;
  categoryId?: string;
  status: FindStatus;
  opp: Opportunity;
  addedAt: number;
  denyReason?: string;
  sentAt?: number;
}

// Which Scout field each CSV column maps to. `""` = ignore this column.
type FieldKey =
  | ""
  | "name"
  | "email"
  | "outlet"
  | "role"
  | "url"
  | "handle"
  | "notes"
  | "status";

const FIELD_LABELS: Record<Exclude<FieldKey, "">, string> = {
  name: "Name (required)",
  email: "Email",
  outlet: "Company / outlet",
  role: "Role / title",
  url: "URL / website",
  handle: "LinkedIn / handle",
  notes: "Notes",
  status: "Status column",
};

// Guess which Scout field a column header corresponds to, based on common
// spreadsheet conventions (LinkedIn Connections export, Google Sheets, etc.).
function guessField(header: string): FieldKey {
  const h = header.toLowerCase().trim();
  if (!h) return "";
  if (/(first\s*name|full\s*name|contact\s*name|\bname\b|person)/.test(h)) return "name";
  if (/(email|e-mail|mail)/.test(h)) return "email";
  if (/(company|organization|organisation|employer|outlet|publication|firm|business|position\s+company)/.test(h)) return "outlet";
  if (/(role|title|position|job)/.test(h)) return "role";
  if (/(url|website|link|profile)/.test(h) && !/linkedin/.test(h)) return "url";
  if (/(linkedin|handle|twitter|instagram|social)/.test(h)) return "handle";
  if (/(note|comment|message|context|about|memo)/.test(h)) return "notes";
  if (/(status|stage|state|reply|replied|outcome|result)/.test(h)) return "status";
  return "";
}

// If the row has separate "First Name" and "Last Name", combine them.
function fallbackNameFromRow(row: Record<string, string>): string {
  const first = Object.entries(row).find(([k]) => /first\s*name/i.test(k))?.[1];
  const last = Object.entries(row).find(([k]) => /last\s*name/i.test(k))?.[1];
  const combined = [first, last].filter(Boolean).join(" ").trim();
  return combined;
}

function urlHost(u: string): string {
  const m = String(u || "").match(/^https?:\/\/([^/?#]+)/i);
  return m ? m[1].replace(/^www\./, "").toLowerCase() : "";
}

function looksLikeReplied(v: string): boolean {
  return /reply|replied|responded|answered|meeting|interview|hired/i.test(v);
}
function looksLikeDenied(v: string): boolean {
  return /no|passed|rejected|ghosted|dead|declin/i.test(v);
}

// SheetJS worksheet → { header row, string-cell rows }, matching the CSV shape.
// Shared by the file drop and the link importer. XLSX is passed in so it stays a
// dynamic import (loaded only when a spreadsheet is actually read).
function sheetToRows(
  XLSX: any,
  ws: any
): { heads: string[]; clean: Record<string, string>[] } {
  const aoa: any[][] = XLSX.utils.sheet_to_json(ws, {
    header: 1,
    blankrows: false,
    defval: "",
    raw: false,
  });
  const heads = (aoa[0] || []).map((h: any) => String(h ?? "").trim());
  const clean = aoa
    .slice(1)
    .map((r) => {
      const obj: Record<string, string> = {};
      heads.forEach((h, i) => {
        obj[h] = String(r[i] ?? "").trim();
      });
      return obj;
    })
    .filter((r) => Object.values(r).some((v) => v));
  return { heads, clean };
}

export default function ImportOutreach({
  open,
  onClose,
  onImport,
  onSaveSync,
  projects,
  activeProjectId,
  getToken,
}: {
  open: boolean;
  onClose: () => void;
  onImport: (finds: Find[]) => number;
  onSaveSync?: (cfg: {
    url: string;
    label: string;
    projectId: string;
    mapping: Record<string, FieldKey>;
    defaultStatus: FindStatus;
  }) => void;
  projects: Project[];
  activeProjectId: string;
  getToken?: () => Promise<string | null>;
}) {
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Record<string, FieldKey>>({});
  const [projectId, setProjectId] = useState(activeProjectId || projects[0]?.id || "");
  const [defaultStatus, setDefaultStatus] = useState<FindStatus>("sent");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [imported, setImported] = useState<number | null>(null);
  const [fileName, setFileName] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [sourceUrl, setSourceUrl] = useState(""); // set when imported from a link
  const [keepSynced, setKeepSynced] = useState(true);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) {
      // Reset every time the modal reopens so a second import doesn't
      // remember stale headers from a previous file.
      setRows([]);
      setHeaders([]);
      setMapping({});
      setError("");
      setImported(null);
      setFileName("");
      setBusy(false);
    }
  }, [open]);

  useEffect(() => {
    if (activeProjectId) setProjectId(activeProjectId);
  }, [activeProjectId]);

  // Populate the mapping UI from parsed headers + rows (shared by every format).
  function ingest(heads: string[], clean: Record<string, string>[]) {
    if (!clean.length) {
      setError("The file has no data rows.");
      return;
    }
    setRows(clean);
    setHeaders(heads);
    const auto: Record<string, FieldKey> = {};
    for (const h of heads) auto[h] = guessField(h);
    setMapping(auto);
  }

  // Spreadsheet formats (Excel, ODS, …) are read with SheetJS, which is loaded
  // on demand so the CSV path stays light. Everything is normalized to the same
  // { header: string, rows: Record<string,string>[] } shape as the CSV parser.
  const SHEET_EXTS = ["xlsx", "xls", "xlsm", "xlsb", "ods", "fods", "numbers"];

  async function handleFile(file: File) {
    setError("");
    setImported(null);
    setSourceUrl(""); // a dropped file has no link to keep in sync
    setFileName(file.name);
    setBusy(true);
    const ext = (file.name.split(".").pop() || "").toLowerCase();

    if (SHEET_EXTS.includes(ext)) {
      try {
        const XLSX = await import("xlsx");
        const buf = await file.arrayBuffer();
        const wb = XLSX.read(buf, { type: "array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        setBusy(false);
        if (!ws) throw new Error("The workbook has no sheets.");
        const { heads, clean } = sheetToRows(XLSX, ws);
        ingest(heads, clean);
      } catch (e: any) {
        setBusy(false);
        setError(`Could not read that spreadsheet: ${e?.message || "unknown error"}`);
      }
      return;
    }

    // CSV / TSV / plain text: Papa auto-detects the delimiter.
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim(),
      complete: (result) => {
        setBusy(false);
        if (result.errors?.length) {
          setError(`Could not parse the file: ${result.errors[0].message}`);
          return;
        }
        const clean = (result.data || []).filter((r) =>
          Object.values(r).some((v) => String(v || "").trim())
        );
        const heads = (result.meta.fields || []).map((h) => h.trim());
        ingest(heads, clean);
      },
      error: (err) => {
        setBusy(false);
        setError(`Could not read the file: ${err.message}`);
      },
    });
  }

  // Import from a link (Google Sheet share link or a public .csv/.xlsx URL). The
  // server fetches it (CORS + SSRF safe) and returns CSV text or spreadsheet
  // bytes, which we parse with the same code as a dropped file.
  async function handleUrl() {
    const u = linkUrl.trim();
    if (!u) return;
    setError("");
    setImported(null);
    setBusy(true);
    try {
      const token = getToken ? await getToken() : null;
      const res = await fetch("/api/import/sheet", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ url: u }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setBusy(false);
        setError(data?.error || "Couldn't read that link.");
        return;
      }
      setSourceUrl(u);
      setFileName(/docs\.google\.com/.test(u) ? "Linked Google Sheet" : u);
      if (data.kind === "csv") {
        const result = Papa.parse<Record<string, string>>(String(data.text || ""), {
          header: true,
          skipEmptyLines: true,
          transformHeader: (h) => h.trim(),
        });
        setBusy(false);
        const clean = (result.data || []).filter((r) =>
          Object.values(r).some((v) => String(v || "").trim())
        );
        const heads = (result.meta.fields || []).map((h) => h.trim());
        ingest(heads, clean);
      } else {
        const XLSX = await import("xlsx");
        const bin = atob(String(data.b64 || ""));
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const wb = XLSX.read(bytes, { type: "array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        setBusy(false);
        if (!ws) {
          setError("The workbook has no sheets.");
          return;
        }
        const { heads, clean } = sheetToRows(XLSX, ws);
        ingest(heads, clean);
      }
    } catch (e: any) {
      setBusy(false);
      setError(e?.message || "Couldn't import from that link.");
    }
  }

  // Which columns are already assigned to a Scout field. Used to disable the
  // duplicate in the picker so a field can't be mapped twice.
  const assignedFields = useMemo(() => {
    const set = new Set<FieldKey>();
    for (const v of Object.values(mapping)) if (v) set.add(v);
    return set;
  }, [mapping]);

  const nameColumn = useMemo(
    () => Object.entries(mapping).find(([, v]) => v === "name")?.[0] || "",
    [mapping]
  );

  const preview = rows.slice(0, 5);

  function buildFinds(): Find[] {
    if (!projectId) throw new Error("Pick a project first.");
    const cols: Partial<Record<Exclude<FieldKey, "">, string>> = {};
    for (const [col, field] of Object.entries(mapping)) {
      if (field) cols[field] = col;
    }
    const seen = new Set<string>();
    const finds: Find[] = [];
    const now = Date.now();
    let idx = 0;
    for (const row of rows) {
      const name =
        (cols.name && String(row[cols.name] || "").trim()) ||
        fallbackNameFromRow(row) ||
        "";
      if (!name) continue; // no name = nothing to dedup against, skip
      const email = cols.email ? String(row[cols.email] || "").trim() : "";
      const outlet = cols.outlet ? String(row[cols.outlet] || "").trim() : "";
      const role = cols.role ? String(row[cols.role] || "").trim() : "";
      const url = cols.url ? String(row[cols.url] || "").trim() : "";
      const handle = cols.handle ? String(row[cols.handle] || "").trim() : "";
      const notes = cols.notes ? String(row[cols.notes] || "").trim() : "";
      const statusStr = cols.status ? String(row[cols.status] || "").trim() : "";
      let status: FindStatus = defaultStatus;
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
        sourceTitle: fileName,
        sourceSnippet: notes.slice(0, 220),
      };
      const nm = name
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "");
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

  function runImport() {
    setError("");
    setImported(null);
    if (!nameColumn) {
      setError("Pick which column has the person's name.");
      return;
    }
    try {
      const finds = buildFinds();
      if (!finds.length) {
        setError("No importable rows, every row was missing a name.");
        return;
      }
      const added = onImport(finds);
      // If this came from a link and they opted in, remember it so Scout keeps
      // re-reading the sheet automatically.
      if (sourceUrl && keepSynced && onSaveSync) {
        onSaveSync({ url: sourceUrl, label: fileName, projectId, mapping, defaultStatus });
      }
      setImported(added);
    } catch (e: any) {
      setError(e?.message || "Import failed.");
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-ink/40 p-3 backdrop-blur-sm sm:p-8"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-3xl border border-warm-border bg-surface shadow-soft"
      >
        <div className="flex items-center gap-3 border-b border-warm-border bg-white px-6 py-4">
          <div>
            <h2 className="text-lg font-extrabold tracking-tight text-ink">
              Import your outreach history
            </h2>
            <p className="mt-0.5 text-xs text-body">
              Drop a spreadsheet of people you've already reached out to — CSV,
              Excel, Numbers, or OpenDocument. Scout uses it to avoid re-surfacing
              them and to learn what a fit looks like for you.
            </p>
          </div>
          <button
            onClick={onClose}
            className="ml-auto rounded-lg border border-warm-border px-3 py-1.5 text-xs font-semibold text-body transition hover:bg-warm-bg"
          >
            Close
          </button>
        </div>

        <div className="flex-1 overflow-auto p-6">
          {/* Step 1, file drop */}
          {!rows.length && (
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const f = e.dataTransfer.files?.[0];
                if (f) handleFile(f);
              }}
              className="rounded-2xl border-2 border-dashed border-warm-border bg-white p-10 text-center"
            >
              <p className="text-sm font-semibold text-ink">
                Drop a spreadsheet here
              </p>
              <p className="mt-1 text-xs text-body/70">
                <code>.csv</code>, <code>.xlsx</code>, <code>.xls</code>,{" "}
                <code>.ods</code>, <code>.numbers</code>, or a tab/text export from
                Google Sheets, Notion, or LinkedIn Connections. Scout reads the
                headers and matches them to its own fields for you.
              </p>
              <input
                ref={inputRef}
                type="file"
                accept=".csv,.tsv,.txt,.xlsx,.xls,.xlsm,.xlsb,.ods,.fods,.numbers,text/csv,text/tab-separated-values,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.oasis.opendocument.spreadsheet"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleFile(f);
                }}
              />
              <button
                onClick={() => inputRef.current?.click()}
                disabled={busy}
                className="mt-4 rounded-xl bg-brown px-4 py-2 text-sm font-bold text-white shadow-soft transition hover:opacity-90 disabled:opacity-50"
              >
                {busy ? "Reading…" : "Choose a file"}
              </button>

              {/* Or import straight from a link (Google Sheet / public URL). */}
              <div className="mx-auto mt-6 max-w-xl border-t border-warm-border pt-5">
                <div className="text-xs font-bold uppercase tracking-wider text-body/50">
                  Or paste a link
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <input
                    value={linkUrl}
                    onChange={(e) => setLinkUrl(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && linkUrl.trim()) handleUrl();
                    }}
                    placeholder="https://docs.google.com/spreadsheets/…"
                    className="min-w-[220px] flex-1 rounded-xl border border-warm-border px-3.5 py-2.5 text-sm text-ink outline-none transition focus:border-coral focus:ring-4 focus:ring-coral/15"
                  />
                  <button
                    onClick={handleUrl}
                    disabled={busy || !linkUrl.trim()}
                    className="rounded-xl bg-brand-gradient px-4 py-2.5 text-sm font-bold text-white shadow-soft transition hover:opacity-95 disabled:opacity-50"
                  >
                    {busy ? "Reading…" : "Read link"}
                  </button>
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-body/60">
                  Google Sheets need to be shared as <b>Anyone with the link &middot;
                  Viewer</b>. After it reads, tick <b>Keep this sheet synced</b> and
                  Scout re-reads it automatically. (Writing back to the sheet is coming
                  next.)
                </p>
              </div>
            </div>
          )}

          {/* Step 2, column mapping + preview + config */}
          {rows.length > 0 && imported === null && (
            <div className="space-y-6">
              <div className="rounded-2xl border border-warm-border bg-white p-5">
                <div className="text-xs font-bold uppercase tracking-wider text-body/60">
                  File
                </div>
                <div className="mt-1 flex items-center gap-2 text-sm text-ink">
                  <span className="font-semibold">{fileName}</span>
                  <span className="text-body/70">· {rows.length} rows</span>
                </div>
              </div>

              <div>
                <h3 className="text-sm font-extrabold uppercase tracking-wide text-ink">
                  Column mapping
                </h3>
                <p className="mt-1 text-xs text-body/70">
                  Scout guessed what each column is. Fix anything wrong, the Name
                  column is required.
                </p>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  {headers.map((h) => (
                    <div
                      key={h}
                      className="flex items-center gap-2 rounded-xl border border-warm-border bg-white p-3"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-xs font-bold uppercase tracking-wider text-body/60">
                          {h}
                        </div>
                        <div className="mt-0.5 truncate text-[11px] text-body/60">
                          e.g. {String(rows[0]?.[h] || "").slice(0, 40) || "-"}
                        </div>
                      </div>
                      <select
                        value={mapping[h] || ""}
                        onChange={(e) =>
                          setMapping((m) => ({ ...m, [h]: e.target.value as FieldKey }))
                        }
                        className="scout-select shrink-0 rounded-lg border border-warm-border bg-white px-2.5 py-1.5 text-xs font-semibold text-ink outline-none"
                      >
                        <option value="">, ignore, </option>
                        {(Object.keys(FIELD_LABELS) as (keyof typeof FIELD_LABELS)[]).map((k) => (
                          <option
                            key={k}
                            value={k}
                            disabled={mapping[h] !== k && assignedFields.has(k)}
                          >
                            {FIELD_LABELS[k]}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <h3 className="text-sm font-extrabold uppercase tracking-wide text-ink">
                  Preview
                </h3>
                <div className="mt-2 overflow-x-auto rounded-xl border border-warm-border bg-white">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-warm-border text-left text-[10px] font-bold uppercase tracking-wider text-body/60">
                        {Object.keys(FIELD_LABELS).map((k) => (
                          <th key={k} className="whitespace-nowrap px-3 py-2">
                            {FIELD_LABELS[k as keyof typeof FIELD_LABELS]}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {preview.map((row, i) => (
                        <tr key={i} className="border-b border-warm-border last:border-b-0">
                          {(Object.keys(FIELD_LABELS) as (keyof typeof FIELD_LABELS)[]).map((k) => {
                            const col = Object.entries(mapping).find(([, v]) => v === k)?.[0];
                            const val = col ? row[col] : "";
                            return (
                              <td key={k} className="whitespace-nowrap px-3 py-2 text-ink">
                                <span className="line-clamp-1 max-w-[180px] block">
                                  {val || "-"}
                                </span>
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <div className="mb-1 text-[11px] font-bold uppercase tracking-wider text-body/60">
                    Import into project
                  </div>
                  <select
                    value={projectId}
                    onChange={(e) => setProjectId(e.target.value)}
                    className="scout-select w-full rounded-xl border border-warm-border bg-white px-3 py-2 text-sm font-semibold text-ink outline-none"
                  >
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <div className="mb-1 text-[11px] font-bold uppercase tracking-wider text-body/60">
                    Default status when the file doesn't say
                  </div>
                  <select
                    value={defaultStatus}
                    onChange={(e) => setDefaultStatus(e.target.value as FindStatus)}
                    className="scout-select w-full rounded-xl border border-warm-border bg-white px-3 py-2 text-sm font-semibold text-ink outline-none"
                  >
                    <option value="sent">Already reached out</option>
                    <option value="replied">Replied</option>
                    <option value="denied">Not a fit, don't resurface</option>
                    <option value="drafted">Drafted, not yet sent</option>
                    <option value="new">Add to Finds (unactioned)</option>
                  </select>
                </div>
              </div>

              {/* Keep-synced — only when imported from a link (a dropped file has
                  nothing to re-read). */}
              {sourceUrl && onSaveSync && (
                <label className="flex cursor-pointer items-start gap-2.5 rounded-2xl border border-warm-border bg-white p-4">
                  <input
                    type="checkbox"
                    checked={keepSynced}
                    onChange={(e) => setKeepSynced(e.target.checked)}
                    className="mt-0.5 h-4 w-4 shrink-0 accent-brown"
                  />
                  <span className="text-sm leading-relaxed text-body">
                    <span className="font-semibold text-ink">Keep this sheet synced.</span>{" "}
                    Scout re-reads the link automatically (on open and every few
                    minutes) and pulls in new rows — you won&apos;t have to re-import.
                  </span>
                </label>
              )}

              {error && (
                <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  {error}
                </div>
              )}
            </div>
          )}

          {/* Step 3, success */}
          {imported !== null && (
            <div className="rounded-2xl border border-sage/40 bg-sage/10 p-6 text-center">
              <p className="text-base font-extrabold text-ink">
                Imported {imported} {imported === 1 ? "contact" : "contacts"}.
              </p>
              <p className="mt-1 text-sm text-body">
                They're in your Finds now. Future searches won't surface them again.
              </p>
              <button
                onClick={onClose}
                className="mt-4 rounded-xl bg-brown px-4 py-2 text-sm font-bold text-white shadow-soft"
              >
                Done
              </button>
            </div>
          )}
        </div>

        {rows.length > 0 && imported === null && (
          <div className="flex items-center gap-3 border-t border-warm-border bg-white px-6 py-4">
            <span className="text-xs text-body/70">
              {rows.length} rows ready. Duplicates you already have are skipped.
            </span>
            <button
              onClick={runImport}
              className="ml-auto rounded-xl bg-brand-gradient px-5 py-2 text-sm font-bold text-white shadow-soft transition hover:opacity-95"
            >
              Import {rows.length} rows
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
