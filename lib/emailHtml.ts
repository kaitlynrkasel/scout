// Render a plain-text personal note as minimal HTML so the links in it are
// actually clickable in the recipient's inbox. No styling wrapper, no layout:
// just escaped text, <br> line breaks, and <a> around URLs, so it still reads
// like a person typed it.
export function humanHtml(text: string): string {
  const esc = String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return esc
    // The match runs on escaped text, so &amp; sequences inside a URL stay in
    // the href, which is valid HTML and decodes back to & when clicked.
    .replace(/(https?:\/\/[^\s<]+)/g, (m) => {
      // Trailing punctuation next to a URL belongs to the sentence, not the link.
      const trimmed = m.replace(/[.,)\]!?]+$/, "");
      const tail = m.slice(trimmed.length);
      return `<a href="${trimmed}">${trimmed}</a>${tail}`;
    })
    .replace(/\r?\n/g, "<br>\n");
}

// Only bother with an HTML part when it changes anything.
export function needsHtml(text: string): boolean {
  return /https?:\/\//i.test(String(text || ""));
}
