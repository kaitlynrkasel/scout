import { NextRequest, NextResponse } from "next/server";
import { withinRateLimit, requestIp } from "@/lib/rateLimit";
import { extractText, extractTextItems, getDocumentProxy } from "unpdf";
import { pageToText, tidy, type PdfRun } from "@/lib/pdfLayout";

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

export async function POST(req: NextRequest) {
  // Open to pre-login flows by design, so the guard is per-IP rate
  // limiting: without it this endpoint spends our API money for anyone
  // who curls it in a loop.
  if (!withinRateLimit(`readpdf:${requestIp(req.headers)}`, 30, 10 * 60 * 1000)) {
    return NextResponse.json({ error: "Slow down a moment." }, { status: 429 });
  }
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
          .map((page: any) => pageToText(page as PdfRun[]))
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
