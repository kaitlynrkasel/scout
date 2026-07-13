"use client";

// Drop-a-CSV importer for existing outreach history. Client-side only: parses
// with papaparse, auto-maps common column names (LinkedIn / Google Sheets /
// Notion), lets the user confirm mapping + status, then hands finished Find
// records back to the parent. Dedup + persistence uses the existing pipeline.

import { useEffect, useMemo, useRef, useState } from "react";
import Papa from "papaparse";
import {
  workbookToTabs,
  fetchSheetTabs,
  unionTabs,
  tabLooksLikeFinds,
  type SheetTab,
} from "@/lib/sheetImport";
import type { Opportunity } from "@/lib/types";
import { MicButton, joinSpoken } from "./dictate";

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

// Last-resort name: the first non-empty cell in the row, so a row with data but
// no obvious name column still imports instead of being silently dropped.
function firstNonEmptyCell(row: Record<string, string>): string {
  for (const v of Object.values(row)) {
    const s = String(v || "").trim();
    if (s) return s.slice(0, 120);
  }
  return "";
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
    understanding?: number;
    understandingSummary?: string;
    understandingAnswers?: string;
    allowWrite?: boolean;
    writeTab?: string;
  }) => void;
  projects: Project[];
  activeProjectId: string;
  getToken?: () => Promise<string | null>;
}) {
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [headers, setHeaders] = useState<string[]>([]);
  // Multi-tab workbooks: keep every tab, and let the user choose which hold the
  // finds (so a Senders/Config tab doesn't hijack the import).
  const [tabs, setTabs] = useState<SheetTab[]>([]);
  const [selectedTabs, setSelectedTabs] = useState<Set<string>>(new Set());
  const [mapping, setMapping] = useState<Record<string, FieldKey>>({});
  const [projectId, setProjectId] = useState(activeProjectId || projects[0]?.id || "");
  const [defaultStatus, setDefaultStatus] = useState<FindStatus>("sent");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [imported, setImported] = useState<number | null>(null);
  const [importStats, setImportStats] = useState<{
    total: number;
    skippedNoName: number;
    dupWithin: number;
    alreadyHad: number;
  } | null>(null);
  const [fileName, setFileName] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [sourceUrl, setSourceUrl] = useState(""); // set when imported from a link
  const [keepSynced, setKeepSynced] = useState(true);
  const [showMapping, setShowMapping] = useState(false); // column mapping is advanced; hidden by default
  const [writeBack, setWriteBack] = useState(false); // let Scout write the pipeline back into the synced sheet
  const [writeTab, setWriteTab] = useState("Scout"); // which tab Scout writes into
  // Understanding gate: Scout reads the doc, then asks until it grasps it. The
  // percentage is the model's honest read, raised as questions get answered.
  const [understand, setUnderstand] = useState<{
    understanding: number;
    summary: string;
    questions: { question: string; options: string[] }[];
  } | null>(null);
  const [uBusy, setUBusy] = useState(false);
  const [uPicks, setUPicks] = useState<Record<number, string[]>>({});
  const [uOther, setUOther] = useState<Record<number, string>>({});
  const [uAsked, setUAsked] = useState<string[]>([]);
  const [uAnswers, setUAnswers] = useState(""); // composed answers folded in so far
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) {
      // Reset every time the modal reopens so a second import doesn't
      // remember stale headers from a previous file.
      setRows([]);
      setHeaders([]);
      setTabs([]);
      setSelectedTabs(new Set());
      setImportStats(null);
      setShowMapping(false);
      setMapping({});
      setError("");
      setImported(null);
      setFileName("");
      setBusy(false);
      setSourceUrl("");
      setUnderstand(null);
      setUPicks({});
      setUOther({});
      setUAsked([]);
      setUAnswers("");
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
    // Kick off the understanding read on the freshly-parsed data.
    setUnderstand(null);
    setUPicks({});
    setUOther({});
    setUAsked([]);
    setUAnswers("");
    void runUnderstand("", [], clean, heads);
  }

  // Receive a workbook's tabs: store them, pre-select the ones that look like
  // finds (skipping Senders/Config/Coach), and ingest the union of the selected.
  function ingestTabs(tabList: SheetTab[]) {
    const nonEmpty = tabList.filter((t) => t.rows.length);
    if (!nonEmpty.length) {
      setError("The file has no data rows.");
      return;
    }
    setTabs(nonEmpty);
    const findsTabs = nonEmpty.filter(tabLooksLikeFinds);
    // Default: the finds-like tabs, or all tabs if the heuristic found none.
    const picked = (findsTabs.length ? findsTabs : nonEmpty).map((t) => t.name);
    setSelectedTabs(new Set(picked));
    const chosen = nonEmpty.filter((t) => picked.includes(t.name));
    const { headers: h, rows: r } = unionTabs(chosen);
    ingest(h, r);
  }

  // Re-ingest whenever the user changes which tabs are selected. Keep at least
  // one tab selected so the picker (and the rest of the panel) stays on screen.
  function applyTabSelection(next: Set<string>) {
    if (next.size === 0) return; // ignore unchecking the last tab
    setSelectedTabs(next);
    const chosen = tabs.filter((t) => next.has(t.name));
    const { headers: h, rows: r } = unionTabs(chosen);
    ingest(h, r);
  }

  // Ask Scout how well it understands this document; folds prior answers back in.
  async function runUnderstand(
    foldAnswers: string,
    prevQuestions: string[],
    rowsArg?: Record<string, string>[],
    headsArg?: string[]
  ) {
    const useRows = rowsArg ?? rows;
    const useHeads = headsArg ?? headers;
    if (!useHeads.length) return;
    setUBusy(true);
    try {
      const token = getToken ? await getToken() : null;
      const proj = projects.find((p) => p.id === projectId);
      const res = await fetch("/api/import/understand", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          headers: useHeads,
          sampleRows: useRows.slice(0, 15),
          rowCount: useRows.length,
          useCase: proj?.useCase || "outreach",
          answers: foldAnswers,
          asked: prevQuestions,
        }),
      });
      const d = await res.json().catch(() => ({}));
      setUnderstand({
        understanding: typeof d.understanding === "number" ? d.understanding : 100,
        summary: String(d.summary || ""),
        questions: Array.isArray(d.questions) ? d.questions : [],
      });
      setUPicks({});
      setUOther({});
    } catch {
      setUnderstand({ understanding: 100, summary: "", questions: [] });
    } finally {
      setUBusy(false);
    }
  }

  // Compose the currently-answered understanding questions into one string.
  function composeUnderstandAnswers(): string {
    if (!understand) return "";
    return understand.questions
      .map((q, i) => {
        const sel = uPicks[i] || [];
        if (!sel.length) return "";
        const parts = sel
          .map((s) => (s === "__other__" ? (uOther[i] || "").trim() : s))
          .filter(Boolean);
        return parts.length ? `${q.question} ${parts.join(", ")}` : "";
      })
      .filter(Boolean)
      .join(". ");
  }

  // Fold the answers in and re-score — the new % is the model's honest re-read.
  function recheckUnderstanding() {
    if (!understand || uBusy) return;
    const combined = [uAnswers, composeUnderstandAnswers()].filter(Boolean).join(". ");
    const askedNow = [...uAsked, ...understand.questions.map((q) => q.question)];
    setUAnswers(combined);
    setUAsked(askedNow);
    void runUnderstand(combined, askedNow);
  }

  // Answered-question count + live % (each answer closes a share of the gap).
  const uAnsweredCount = understand
    ? understand.questions.filter((_, i) => {
        const sel = uPicks[i] || [];
        if (!sel.length) return false;
        if (sel.length === 1 && sel[0] === "__other__") return (uOther[i] || "").trim().length > 0;
        return true;
      }).length
    : 0;
  const liveUnderstanding = understand
    ? Math.min(
        100,
        Math.round(
          understand.understanding +
            (understand.questions.length
              ? (uAnsweredCount / understand.questions.length) * (100 - understand.understanding)
              : 0)
        )
      )
    : 0;

  // Auto-fold answers into a deeper re-read shortly after you answer — no button.
  // Scout just keeps improving its understanding as you go. Debounced so a burst
  // of picks (or typing an "Other") folds in once, not per keystroke. Terminates
  // naturally: a re-read clears the picks, so it won't loop until you answer more.
  useEffect(() => {
    if (!understand || uBusy || uAnsweredCount === 0) return;
    const t = setTimeout(() => recheckUnderstanding(), 1400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uPicks, uOther, understand, uBusy, uAnsweredCount]);

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
        setBusy(false);
        if (!wb.SheetNames?.length) throw new Error("The workbook has no sheets.");
        // Read every tab separately so the user can pick which hold the finds.
        ingestTabs(workbookToTabs(XLSX, wb));
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
      const tabList = await fetchSheetTabs(u, token);
      setBusy(false);
      setSourceUrl(u);
      setFileName(/docs\.google\.com/.test(u) ? "Linked Google Sheet" : u);
      ingestTabs(tabList);
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
  // Write-back is only possible for a linked Google Sheet (a dropped file / public
  // CSV has nothing to write into).
  const isGoogleSheet = /docs\.google\.com\/spreadsheets/.test(sourceUrl);

  function buildFinds(): { finds: Find[]; skippedNoName: number; dupWithin: number } {
    if (!projectId) throw new Error("Pick a project first.");
    const cols: Partial<Record<Exclude<FieldKey, "">, string>> = {};
    for (const [col, field] of Object.entries(mapping)) {
      if (field) cols[field] = col;
    }
    const seen = new Set<string>();
    const finds: Find[] = [];
    const now = Date.now();
    let idx = 0;
    let skippedNoName = 0;
    let dupWithin = 0;
    for (const row of rows) {
      const emailEarly = cols.email ? String(row[cols.email] || "").trim() : "";
      const handleEarly = cols.handle ? String(row[cols.handle] || "").trim() : "";
      const outletEarly = cols.outlet ? String(row[cols.outlet] || "").trim() : "";
      // Don't drop a row just because the Name cell is blank — if we have ANY
      // identifier (email, handle, outlet, or any non-empty cell) use it as the
      // name so real contacts aren't silently lost on import.
      const rawName =
        (cols.name && String(row[cols.name] || "").trim()) || fallbackNameFromRow(row) || "";
      // A "name" that's really a sentence/description (long, many words) makes an
      // ugly card title. Prefer a short identifier (handle/outlet/email) as the
      // title when the mapped name looks like a description; keep the description
      // as notes so nothing is lost.
      const descLike = (s: string) => s.length > 55 || s.split(/\s+/).length > 8;
      const identifier = handleEarly || outletEarly || emailEarly || "";
      const name =
        (rawName && !descLike(rawName) ? rawName : "") ||
        identifier ||
        rawName ||
        firstNonEmptyCell(row) ||
        "";
      if (!name) {
        skippedNoName++;
        continue; // genuinely empty row
      }
      const email = emailEarly;
      const outlet = outletEarly;
      const role = cols.role ? String(row[cols.role] || "").trim() : "";
      const url = cols.url ? String(row[cols.url] || "").trim() : "";
      const handle = handleEarly;
      const notes0 = cols.notes ? String(row[cols.notes] || "").trim() : "";
      // If the raw name was a description we set aside, preserve it as context.
      const notes =
        rawName && descLike(rawName) && name !== rawName
          ? [notes0, rawName].filter(Boolean).join(" — ")
          : notes0;
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
      const nm = name.toLowerCase().replace(/[^a-z0-9]/g, "");
      const host = urlHost(opp.url || "");
      // Dedup by the actual CONTACT, not just the display name: two rows that
      // share a name but have different emails/handles are different people and
      // both should import. Only a true repeat (same name + same email/handle +
      // same host) is dropped.
      const contactKey = (email || handle).toLowerCase().replace(/[^a-z0-9@._-]/g, "");
      const id = `${projectId}::${nm}::${host}::${contactKey}`;
      if (seen.has(id)) {
        dupWithin++;
        continue;
      }
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
    return { finds, skippedNoName, dupWithin };
  }

  function runImport() {
    setError("");
    setImported(null);
    if (!nameColumn) {
      setError("Pick which column has the person's name.");
      return;
    }
    try {
      const { finds, skippedNoName, dupWithin } = buildFinds();
      if (!finds.length) {
        setError("No importable rows — every row was completely empty.");
        return;
      }
      const added = onImport(finds);
      setImportStats({
        total: rows.length,
        skippedNoName,
        dupWithin,
        alreadyHad: finds.length - added,
      });
      // If this came from a link and they opted in, remember it so Scout keeps
      // re-reading the sheet automatically.
      if (sourceUrl && keepSynced && onSaveSync) {
        onSaveSync({
          url: sourceUrl,
          label: fileName,
          projectId,
          mapping,
          defaultStatus,
          understanding: understand ? liveUnderstanding : undefined,
          understandingSummary: understand?.summary || undefined,
          understandingAnswers: [uAnswers, composeUnderstandAnswers()].filter(Boolean).join(". ") || undefined,
          allowWrite: isGoogleSheet && writeBack,
          writeTab: isGoogleSheet && writeBack ? writeTab.trim() || "Scout" : undefined,
        });
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

              {/* Tab picker — this workbook has several tabs (Opportunities,
                  Senders, Config…). Only import the ones that hold your finds so a
                  Senders/Config tab doesn't hijack the import. */}
              {tabs.length > 1 && (
                <div className="rounded-2xl border border-warm-border bg-white p-5">
                  <div className="text-xs font-bold uppercase tracking-wider text-body/60">
                    Which tabs hold your contacts?
                  </div>
                  <p className="mt-1 text-xs text-body/70">
                    This sheet has {tabs.length} tabs. Scout pre-picked the ones that
                    look like lists of people/opportunities — uncheck any that aren&apos;t
                    (like Senders or Config).
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {tabs.map((t) => {
                      const on = selectedTabs.has(t.name);
                      return (
                        <button
                          key={t.name}
                          onClick={() => {
                            const next = new Set(selectedTabs);
                            if (on) next.delete(t.name);
                            else next.add(t.name);
                            applyTabSelection(next);
                          }}
                          className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
                            on
                              ? "border-transparent bg-brand-gradient text-white"
                              : "border-warm-border bg-white text-body hover:bg-warm-bg"
                          }`}
                        >
                          {on ? "✓ " : ""}
                          {t.name}{" "}
                          <span className={on ? "text-white/70" : "text-body/50"}>
                            ({t.rows.length})
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Understanding gate — Scout reads the doc and asks until it gets it.
                  The % is its honest read, and rises as you answer. */}
              {(understand || uBusy) && (
                <div className="rounded-2xl border border-warm-border bg-white p-5">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-sm font-extrabold uppercase tracking-wide text-ink">
                      What Scout understands
                    </h3>
                    <span className="text-sm font-extrabold tabular-nums text-brown">
                      {uBusy && !understand ? "reading…" : `${liveUnderstanding}%`}
                    </span>
                  </div>
                  <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-warm-bg">
                    <div
                      className="h-full rounded-full bg-brand-gradient transition-[width] duration-500"
                      style={{ width: `${uBusy && !understand ? 12 : liveUnderstanding}%` }}
                    />
                  </div>
                  {understand?.summary && (
                    <p className="mt-3 text-sm leading-relaxed text-body">{understand.summary}</p>
                  )}

                  {understand && understand.questions.length > 0 && (
                    <div className="mt-4 space-y-4">
                      <p className="text-xs text-body/70">
                        Answer these so Scout fully gets your sheet — the number climbs as you do.
                      </p>
                      {understand.questions.map((q, i) => {
                        const sel = uPicks[i] || [];
                        const toggle = (opt: string) =>
                          setUPicks((prev) => {
                            const cur = prev[i] || [];
                            return {
                              ...prev,
                              [i]: cur.includes(opt) ? cur.filter((x) => x !== opt) : [...cur, opt],
                            };
                          });
                        return (
                          <div key={i}>
                            <div className="text-sm font-semibold text-ink">{q.question}</div>
                            <div className="mt-1.5 flex flex-wrap gap-1.5">
                              {q.options.map((opt) => (
                                <button
                                  key={opt}
                                  onClick={() => toggle(opt)}
                                  className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
                                    sel.includes(opt)
                                      ? "border-transparent bg-brand-gradient text-white"
                                      : "border-warm-border bg-white text-body hover:bg-warm-bg"
                                  }`}
                                >
                                  {opt}
                                </button>
                              ))}
                              <button
                                onClick={() => toggle("__other__")}
                                className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
                                  sel.includes("__other__")
                                    ? "border-transparent bg-brand-gradient text-white"
                                    : "border-warm-border bg-white text-body hover:bg-warm-bg"
                                }`}
                              >
                                Other…
                              </button>
                            </div>
                            {sel.includes("__other__") && (
                              <div className="mt-1.5 flex items-center gap-2">
                                <input
                                  value={uOther[i] || ""}
                                  onChange={(e) => setUOther((p) => ({ ...p, [i]: e.target.value }))}
                                  placeholder="Tell Scout in your words"
                                  className="w-full rounded-lg border border-warm-border px-3 py-1.5 text-xs text-ink outline-none focus:border-coral"
                                />
                                <MicButton
                                  onAppend={(t) =>
                                    setUOther((p) => ({ ...p, [i]: joinSpoken(p[i] || "", t) }))
                                  }
                                />
                              </div>
                            )}
                          </div>
                        );
                      })}
                      {uBusy ? (
                        <div className="flex items-center gap-2 text-xs font-semibold text-brown">
                          <span className="h-3 w-3 animate-spin rounded-full border-2 border-warm-border border-t-brown" />
                          Folding your answers in…
                        </div>
                      ) : (
                        uAnsweredCount > 0 && (
                          <div className="text-xs font-medium text-body/60">
                            Scout updates its understanding as you answer.
                          </div>
                        )
                      )}
                    </div>
                  )}
                  {understand && understand.questions.length === 0 && !uBusy && (
                    <p className="mt-3 text-xs font-semibold text-sage-deep">
                      Scout understands this sheet — you&apos;re good to import.
                    </p>
                  )}
                </div>
              )}

              {/* Column mapping, preview and config only appear once Scout has
                  finished its FIRST read — otherwise users are tempted to edit a
                  half-understood sheet. While reading, only the progress shows. */}
              {!understand ? (
                <div className="rounded-2xl border border-dashed border-warm-border bg-white/60 p-5 text-center text-sm text-body/70">
                  Scout is reading your sheet… the column mapping opens once it&apos;s done.
                </div>
              ) : (
              <>
              <div className="rounded-2xl border border-warm-border bg-white p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-extrabold uppercase tracking-wide text-ink">
                      Columns matched
                    </h3>
                    <p className="mt-1 text-xs text-body/70">
                      Scout already figured out what each column is — you don&apos;t need to
                      do anything here. Open it only if a column looks wrong.
                    </p>
                  </div>
                  <button
                    onClick={() => setShowMapping((v) => !v)}
                    className="shrink-0 rounded-lg border border-warm-border px-3 py-1.5 text-xs font-semibold text-body transition hover:bg-warm-bg"
                  >
                    {showMapping ? "Hide" : "Review columns"}
                  </button>
                </div>
                {showMapping && (
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
                )}
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
                <div className="rounded-2xl border border-warm-border bg-white p-4">
                  <label className="flex cursor-pointer items-start gap-2.5">
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

                  {/* When synced, offer to write the pipeline back — and ask WHERE, so
                      Scout never touches your existing tabs. Google Sheets only. */}
                  {keepSynced && isGoogleSheet && (
                    <div className="mt-3 border-t border-warm-border pt-3">
                      <label className="flex cursor-pointer items-start gap-2.5">
                        <input
                          type="checkbox"
                          checked={writeBack}
                          onChange={(e) => setWriteBack(e.target.checked)}
                          className="mt-0.5 h-4 w-4 shrink-0 accent-brown"
                        />
                        <span className="text-sm leading-relaxed text-body">
                          <span className="font-semibold text-ink">
                            Let Scout write the rows back into this sheet.
                          </span>{" "}
                          It adds a status/notes for each contact — never overwriting your
                          existing columns.
                        </span>
                      </label>
                      {writeBack && (
                        <div className="mt-3 pl-7">
                          <div className="mb-1 text-[11px] font-bold uppercase tracking-wider text-body/60">
                            Which tab should Scout write into?
                          </div>
                          <input
                            value={writeTab}
                            onChange={(e) => setWriteTab(e.target.value)}
                            placeholder="Scout"
                            className="w-full max-w-xs rounded-xl border border-warm-border bg-white px-3 py-2 text-sm text-ink outline-none focus:border-coral"
                          />
                          <p className="mt-1.5 text-[11px] leading-relaxed text-body/60">
                            Scout creates this tab if it doesn&apos;t exist and writes there,
                            so your other tabs are left untouched. Default: a new
                            &ldquo;Scout&rdquo; tab.
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
              </>
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
              {/* Full accounting of the sheet so nothing looks "missed" silently:
                  where every row went. */}
              {importStats && (
                <div className="mx-auto mt-4 max-w-sm rounded-xl border border-warm-border bg-white/70 px-4 py-3 text-left text-xs text-body">
                  <div className="mb-1 font-bold uppercase tracking-wider text-body/60">
                    From {importStats.total.toLocaleString()} rows
                  </div>
                  <div className="flex justify-between"><span>Imported</span><span className="font-semibold text-ink">{imported}</span></div>
                  {importStats.alreadyHad > 0 && (
                    <div className="flex justify-between"><span>Already in your Finds</span><span>{importStats.alreadyHad}</span></div>
                  )}
                  {importStats.dupWithin > 0 && (
                    <div className="flex justify-between"><span>Repeat rows in the sheet</span><span>{importStats.dupWithin}</span></div>
                  )}
                  {importStats.skippedNoName > 0 && (
                    <div className="flex justify-between"><span>Empty rows skipped</span><span>{importStats.skippedNoName}</span></div>
                  )}
                </div>
              )}
              <button
                onClick={onClose}
                className="mt-4 rounded-xl bg-brown px-4 py-2 text-sm font-bold text-white shadow-soft"
              >
                Done
              </button>
            </div>
          )}
        </div>

        {rows.length > 0 && imported === null && understand && (
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
