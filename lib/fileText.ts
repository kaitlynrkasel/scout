// Extract plain text from an uploaded file (resume, cover letter). Runs entirely
// in the browser. Supports .txt/.md natively, .docx via mammoth, .pdf via pdfjs.
// Heavy parsers are dynamically imported so they don't bloat the initial bundle.

export async function fileToText(file: File): Promise<string> {
  const name = file.name.toLowerCase();

  if (name.endsWith(".txt") || name.endsWith(".md") || file.type.startsWith("text/")) {
    return (await file.text()).trim();
  }

  if (name.endsWith(".docx")) {
    const mammoth = await import("mammoth");
    const arrayBuffer = await file.arrayBuffer();
    const res = await mammoth.extractRawText({ arrayBuffer });
    return (res.value || "").trim();
  }

  if (name.endsWith(".pdf")) {
    const pdfjs: any = await import("pdfjs-dist");
    // Worker is served same-origin from /public (copied there by scripts/
    // copy-pdf-worker.mjs at build time), so it's always version-matched and
    // never depends on a CDN having this exact pdfjs release.
    pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;
    let out = "";
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      out += content.items.map((it: any) => it.str).join(" ") + "\n";
    }
    return out.trim();
  }

  if (name.endsWith(".doc")) {
    throw new Error(
      "Old .doc files aren't supported. Save it as .docx or .pdf, or paste the text."
    );
  }

  throw new Error(
    "Couldn't read that file type. Use a .pdf, .docx, or .txt, or paste the text."
  );
}
