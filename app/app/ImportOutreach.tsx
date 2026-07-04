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

export default function ImportOutreach({
  open,
  onClose,
  onImport,
  projects,
  activeProjectId,
}: {
  open: boolean;
  onClose: () => void;
  onImport: (finds: Find[]) => number;
  projects: Project[];
  activeProjectId: string;
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

  function handleFile(file: File) {
    setError("");
    setImported(null);
    setFileName(file.name);
    setBusy(true);
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
        const clean = (result.data || []).filter(
          (r) => Object.values(r).some((v) => String(v || "").trim())
        );
        if (!clean.length) {
          setError("The file has no data rows.");
          return;
        }
        setRows(clean);
        const heads = (result.meta.fields || []).map((h) => h.trim());
        setHeaders(heads);
        const auto: Record<string, FieldKey> = {};
        for (const h of heads) auto[h] = guessField(h);
        setMapping(auto);
      },
      error: (err) => {
        setBusy(false);
        setError(`Could not read the file: ${err.message}`);
      },
    });
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
        setError("No importable rows — every row was missing a name.");
        return;
      }
      const added = onImport(finds);
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
              Drop a CSV of people you've already reached out to. Scout uses it to
              avoid re-surfacing them and to learn what a fit looks like for you.
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
          {/* Step 1 — file drop */}
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
                Drop a <code>.csv</code> file here
              </p>
              <p className="mt-1 text-xs text-body/70">
                Or export from Google Sheets / Notion / LinkedIn Connections and pick
                the file below. Scout reads the headers and matches them to its own
                fields for you.
              </p>
              <input
                ref={inputRef}
                type="file"
                accept=".csv,text/csv"
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
                {busy ? "Reading…" : "Choose a CSV"}
              </button>
            </div>
          )}

          {/* Step 2 — column mapping + preview + config */}
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
                  Scout guessed what each column is. Fix anything wrong — the Name
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
                          e.g. {String(rows[0]?.[h] || "").slice(0, 40) || "—"}
                        </div>
                      </div>
                      <select
                        value={mapping[h] || ""}
                        onChange={(e) =>
                          setMapping((m) => ({ ...m, [h]: e.target.value as FieldKey }))
                        }
                        className="scout-select shrink-0 rounded-lg border border-warm-border bg-white px-2.5 py-1.5 text-xs font-semibold text-ink outline-none"
                      >
                        <option value="">— ignore —</option>
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
                                  {val || "—"}
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
                    <option value="denied">Not a fit — don't resurface</option>
                    <option value="drafted">Drafted, not yet sent</option>
                    <option value="new">Add to Finds (unactioned)</option>
                  </select>
                </div>
              </div>

              {error && (
                <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  {error}
                </div>
              )}
            </div>
          )}

          {/* Step 3 — success */}
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
