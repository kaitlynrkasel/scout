import { NextRequest, NextResponse } from "next/server";
import { extractText, extractTextItems, getDocumentProxy } from "unpdf";

export const runtime = "nodejs";
export const maxDuration = 60; // large PDFs (multi-page resumes) can exceed the low ceiling

// Extract text from a PDF on the SERVER so it works in every browser, even
// older Safari/iOS that can't run pdf.js's worker. Uses unpdf, which ships a
// serverless-safe pdf.js build (no worker-file resolution, the exact thing
// that failed on Vercel with the plain pdfjs-dist import).
//
// We do NOT use unpdf's own merged extractText for the main path: it joins the
// pieces of a line with no separator and then flattens every newline to a
// space, so a resume comes back as one run-together wall
// ("Jane Doe555-1234jane@x.comExperience..."). A PDF has no words or lines of
// its own, only positioned glyph runs, so we rebuild both from the geometry:
// group runs that sit on the same baseline, space them by the horizontal gap
// between them, and break paragraphs on the vertical gaps. extractText stays as
// the fallback if a file has no usable positions.

type Item = {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  hasEOL: boolean;
};

// Two runs belong to the same visual line when their baselines are within a
// fraction of the type size (superscripts and slight drift shouldn't split).
function sameLine(a: number, b: number, size: number): boolean {
  return Math.abs(a - b) <= Math.max(1.5, size * 0.5);
}

function pageToText(items: Item[]): string {
  const usable = items.filter((it) => typeof it.str === "string" && it.str.length);
  if (!usable.length) return "";

  // 1. Bucket runs onto baselines, top of the page down (PDF y grows upward).
  const lines: { y: number; size: number; items: Item[] }[] = [];
  for (const it of usable) {
    const size = it.fontSize || it.height || 10;
    const line = lines.find((l) => sameLine(l.y, it.y, Math.max(l.size, size)));
    if (line) {
      line.items.push(it);
      line.size = Math.max(line.size, size);
    } else {
      lines.push({ y: it.y, size, items: [it] });
    }
  }
  lines.sort((a, b) => b.y - a.y);

  // 2. Rebuild each line left to right. A PDF often splits a single word across
  //    runs (kerning, a font switch mid-word), so only a real horizontal gap
  //    earns a space, and a gap wide enough to be a column becomes a longer
  //    separator rather than jamming two columns into one phrase.
  const rendered = lines.map((l) => {
    const sorted = [...l.items].sort((a, b) => a.x - b.x);
    let out = "";
    let prevEnd: number | null = null;
    for (const it of sorted) {
      const gap = prevEnd === null ? 0 : it.x - prevEnd;
      if (prevEnd !== null && gap > l.size * 2.5) out += "   ";
      else if (prevEnd !== null && gap > l.size * 0.18 && !/\s$/.test(out) && !/^\s/.test(it.str))
        out += " ";
      out += it.str;
      prevEnd = it.x + (it.width || 0);
    }
    return { text: out.replace(/[ \t]+$/g, ""), y: l.y, size: l.size };
  });

  // 3. Blank line where the vertical step is bigger than ordinary leading, so
  //    sections separate the way they do on the page.
  let text = "";
  for (let i = 0; i < rendered.length; i++) {
    const cur = rendered[i];
    if (!cur.text.trim()) continue;
    if (i > 0) {
      const prev = rendered[i - 1];
      const step = prev.y - cur.y;
      text += step > Math.max(prev.size, cur.size) * 1.6 ? "\n\n" : "\n";
    }
    text += cur.text.trim();
  }
  return text;
}

function tidy(s: string): string {
  return s
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{4,}/g, "   ")
    .trim();
}

export async function POST(req: NextRequest) {
  try {
    const buf = Buffer.from(await req.arrayBuffer());
    if (!buf.length) {
      return NextResponse.json({ error: "No file received." }, { status: 400 });
    }
    const pdf = await getDocumentProxy(new Uint8Array(buf));

    let out = "";
    try {
      const { items } = await extractTextItems(pdf);
      out = tidy(
        (items || [])
          .map((page: any) => pageToText(page as Item[]))
          .filter((p) => p.trim())
          .join("\n\n")
      );
    } catch {
      /* fall through to the flat extractor below */
    }

    if (!out) {
      const { text } = await extractText(pdf, { mergePages: true });
      out = tidy(Array.isArray(text) ? text.join("\n") : text || "");
    }

    if (!out) {
      return NextResponse.json(
        {
          error:
            "That PDF had no selectable text (it may be a scan). Paste the text instead.",
        },
        { status: 400 }
      );
    }
    return NextResponse.json({ text: out });
  } catch (e: any) {
    const msg = String(e?.message || e || "");
    if (/password|encrypt/i.test(msg)) {
      return NextResponse.json(
        { error: "That PDF is password-protected. Remove the password or paste the text." },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { error: "Couldn't read that PDF. Try a .docx or paste the text instead." },
      { status: 400 }
    );
  }
}
