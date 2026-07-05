import { NextRequest, NextResponse } from "next/server";
import { extractText, getDocumentProxy } from "unpdf";

export const runtime = "nodejs";
export const maxDuration = 60; // large PDFs (multi-page resumes) can exceed the low ceiling

// Extract text from a PDF on the SERVER so it works in every browser, even
// older Safari/iOS that can't run pdf.js's worker. Uses unpdf, which ships a
// serverless-safe pdf.js build (no worker-file resolution, the exact thing
// that failed on Vercel with the plain pdfjs-dist import).
export async function POST(req: NextRequest) {
  try {
    const buf = Buffer.from(await req.arrayBuffer());
    if (!buf.length) {
      return NextResponse.json({ error: "No file received." }, { status: 400 });
    }
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { text } = await extractText(pdf, { mergePages: true });
    const out = (Array.isArray(text) ? text.join("\n") : text || "").trim();
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
