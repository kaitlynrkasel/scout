import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 30;

// Extract text from a PDF on the SERVER, so it works in every browser — even
// older Safari/iOS that can't run the pdf.js worker (module workers unsupported).
// The browser just uploads the file's bytes here.
export async function POST(req: NextRequest) {
  try {
    const buf = Buffer.from(await req.arrayBuffer());
    if (!buf.length) {
      return NextResponse.json({ error: "No file received." }, { status: 400 });
    }
    // Legacy build runs in Node with a main-thread fake worker (no browser worker).
    const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(buf),
      isEvalSupported: false,
      useSystemFonts: true,
    }).promise;

    let out = "";
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      out += content.items.map((it: any) => it.str).join(" ") + "\n";
    }
    const text = out.trim();
    if (!text) {
      return NextResponse.json(
        { error: "That PDF had no selectable text (it may be a scan). Paste the text instead." },
        { status: 400 }
      );
    }
    return NextResponse.json({ text });
  } catch (e: any) {
    const msg = String(e?.message || e || "");
    if (/password/i.test(msg)) {
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
