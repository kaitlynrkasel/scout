// Render a plain-text personal note as minimal HTML so the links in it are
// actually clickable in the recipient's inbox. No styling wrapper, no layout:
// just escaped text, <br> line breaks, and <a> around URLs, so it still reads
// like a person typed it.
// Named links are written [label](https://url) (what pasting a rich link
// into a template produces). They render as the label alone, linked; bare
// URLs still link themselves.
const NAMED_LINK = /\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)/g;

export function humanHtml(text: string): string {
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const raw = String(text || "");
  // Named links become placeholders first so the bare-URL pass below can't
  // re-link the href inside them.
  const named: string[] = [];
  const marked = raw.replace(NAMED_LINK, (_m, label, url) => {
    named.push(`<a href="${esc(url)}">${esc(label)}</a>`);
    return `\u0000${named.length - 1}\u0000`;
  });
  return esc(marked)
    // The match runs on escaped text, so &amp; sequences inside a URL stay in
    // the href, which is valid HTML and decodes back to & when clicked.
    .replace(/(https?:\/\/[^\s<\u0000]+)/g, (m) => {
      // Trailing punctuation next to a URL belongs to the sentence, not the link.
      const trimmed = m.replace(/[.,)\]!?]+$/, "");
      const tail = m.slice(trimmed.length);
      return `<a href="${trimmed}">${trimmed}</a>${tail}`;
    })
    .replace(/\u0000(\d+)\u0000/g, (_m, i) => named[Number(i)] || "")
    .replace(/\r?\n/g, "<br>\n");
}

// The plain-text twin: a named link reads "label: url", which is what a
// text-only inbox, a DM, or the clipboard should get.
export function plainLinks(text: string): string {
  return String(text || "").replace(NAMED_LINK, (_m, label, url) => `${label}: ${url}`);
}

// Only bother with an HTML part when it changes anything.
export function needsHtml(text: string): boolean {
  return /https?:\/\//i.test(String(text || ""));
}
