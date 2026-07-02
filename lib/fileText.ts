// Extract plain text from an uploaded file (resume, cover letter). .txt/.md and
// .docx are parsed in the browser (works everywhere); PDFs are parsed on the
// SERVER so they work in every browser, including older Safari/iOS that can't
// run pdf.js's module worker at all.

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
    // Upload the raw bytes; the server extracts the text (no browser PDF engine).
    const res = await fetch("/api/read-pdf", {
      method: "POST",
      headers: { "content-type": "application/pdf" },
      body: await file.arrayBuffer(),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.text) {
      throw new Error(
        data?.error || "Couldn't read that PDF. Try a .docx or paste the text instead."
      );
    }
    return String(data.text).trim();
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
