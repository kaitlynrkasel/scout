// PDF layout reconstruction: turn positioned glyph runs into readable text.
// Lives in lib (not the route file) so scripts/testPdfLayout.ts can regression
// test it against fixture geometries; Next route files may not export helpers.
export type PdfRun = {
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
export function sameLine(a: number, b: number, size: number): boolean {
  return Math.abs(a - b) <= Math.max(1.5, size * 0.5);
}

export function pageToText(items: PdfRun[]): string {
  const usable = items.filter((it) => typeof it.str === "string" && it.str.length);
  if (!usable.length) return "";

  // ---- True two-column layouts (sidebar resumes) ----
  // A persistent vertical whitespace band with real content on both sides
  // means columns; serializing by baseline would interleave them into
  // nonsense. Find the widest such band in the middle half of the text area;
  // lines that cross it (name banners, section rules) stay full-width and act
  // as flush points, so header, then left column, then right column, read in
  // the order a person reads them. Date-gutter resumes never trigger this:
  // their bullets span the middle, so no empty band exists.
  {
    const minX = Math.min(...usable.map((it) => it.x));
    const maxX = Math.max(...usable.map((it) => it.x + (it.width || 0)));
    const W = maxX - minX;
    let band: number | null = null;
    let bandRun = 0;
    if (W > 0 && usable.length >= 20) {
      let runStart: number | null = null;
      for (let f = 0.25; f <= 0.75; f += 0.01) {
        const bx = minX + W * f;
        const crossing = usable.filter(
          (it) => it.x < bx - W * 0.008 && it.x + (it.width || 0) > bx + W * 0.008
        ).length;
        if (crossing <= Math.max(2, usable.length * 0.04)) {
          if (runStart === null) runStart = f;
        } else if (runStart !== null) {
          if (f - runStart > bandRun) {
            bandRun = f - runStart;
            band = minX + W * (runStart + (f - runStart) / 2);
          }
          runStart = null;
        }
      }
      if (runStart !== null && 0.76 - runStart > bandRun) {
        bandRun = 0.76 - runStart;
        band = minX + W * (runStart + (0.76 - runStart) / 2);
      }
    }
    if (band !== null && bandRun >= 0.03) {
      const left = usable.filter((it) => it.x + (it.width || 0) <= band!);
      const right = usable.filter((it) => it.x >= band!);
      const full = usable.filter(
        (it) => it.x < band! && it.x + (it.width || 0) > band!
      );
      const ys = usable.map((it) => it.y);
      const span = Math.max(...ys) - Math.min(...ys);
      const colSpan = (col: PdfRun[]) =>
        col.length ? Math.max(...col.map((i) => i.y)) - Math.min(...col.map((i) => i.y)) : 0;
      if (
        left.length >= 8 &&
        right.length >= 8 &&
        span > 0 &&
        colSpan(left) > span * 0.4 &&
        colSpan(right) > span * 0.4
      ) {
        // Full-width lines (name banner, section rules) partition the page
        // into slabs; within each slab the left column reads before the right.
        const res: string[] = [];
        const near = (a: number, b: number) => Math.abs(a - b) <= 2;
        const emitSlab = (lo: number, hi: number) => {
          const ls = pageToText(left.filter((it) => it.y < hi && it.y > lo));
          const rs = pageToText(right.filter((it) => it.y < hi && it.y > lo));
          if (ls.trim()) res.push(ls);
          if (rs.trim()) res.push(rs);
        };
        const fullYs = [...new Set(full.map((it) => Math.round(it.y)))].sort((a, b) => b - a);
        let hi = Infinity;
        for (const by of fullYs) {
          emitSlab(by + 2, hi);
          const fl = pageToText(usable.filter((it) => near(it.y, by)));
          if (fl.trim()) res.push(fl);
          hi = by - 2;
        }
        emitSlab(-Infinity, hi);
        return res.join("\n\n");
      }
    }
  }

  // 1. Bucket runs onto baselines, top of the page down (PDF y grows upward).
  const lines: { y: number; size: number; items: PdfRun[] }[] = [];
  for (const it of usable) {
    const size = it.fontSize || it.height || 10;
    // Tolerance from the SMALLER of the two sizes: a 38pt name must not
    // swallow the 10pt location line 19pt below it into one glued line.
    const line = lines.find((l) => sameLine(l.y, it.y, Math.min(l.size, size)));
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
  //    Resume date gutters get their own channel: runs starting in the right
  //    ~28% of the text area are kept apart from the left text, because a
  //    wrapped date range ("Feb 2026 -" then "Jul 2026" a line lower) lands on
  //    the same baseline as the NEXT bullet and used to glue onto it.
  const rightEdge = Math.max(...usable.map((it) => it.x + (it.width || 0)));
  const gutterX = rightEdge * 0.72;
  const rendered = lines.map((l) => {
    const sorted = [...l.items].sort((a, b) => a.x - b.x);
    let out = "";
    let gutter = "";
    let prevEnd: number | null = null;
    for (const it of sorted) {
      const gap = prevEnd === null ? 0 : it.x - prevEnd;
      // Gutter membership needs BOTH the right-zone start and a real column
      // gap: a word's last glyphs can land past the threshold ("catalog|s")
      // and must stay with their word.
      if (it.x >= gutterX && out.trim() && (gutter || gap > l.size * 2.5)) {
        gutter += (gutter && !/\s$/.test(gutter) && !/^\s/.test(it.str) ? " " : "") + it.str;
        continue;
      }
      if (prevEnd !== null && gap > l.size * 2.5) out += "   ";
      else if (
        prevEnd !== null &&
        (gap > l.size * 0.18 || gap < -l.size * 0.5) &&
        !/\s$/.test(out) &&
        !/^\s/.test(it.str)
      )
        out += " ";
      out += it.str;
      prevEnd = it.x + (it.width || 0);
    }
    return {
      text: out.replace(/[ \t]+$/g, ""),
      gutter: gutter.trim(),
      y: l.y,
      size: l.size,
    };
  });

  // A date range that wraps in the gutter continues the PREVIOUS line's
  // gutter ("Feb 2026 -" ... "Jul 2026"), it does not belong to whatever left
  // text shares its baseline. Reunite, then fold each gutter back onto its
  // own line's end.
  for (let i = 1; i < rendered.length; i++) {
    const cur = rendered[i];
    if (!cur.gutter) continue;
    for (let k = i - 1; k >= Math.max(0, i - 2); k--) {
      const prev = rendered[k];
      const openRange =
        /-\s*$/.test(prev.gutter) ||
        // "Jun 2025- July" wraps its closing year onto the next gutter line.
        (/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s*$/i.test(prev.gutter) &&
          /^(19|20)\d{2}$/.test(cur.gutter));
      if (prev.gutter && openRange) {
        prev.gutter += " " + cur.gutter;
        cur.gutter = "";
        break;
      }
      const textOpen =
        !prev.gutter &&
        prev.text &&
        (/-\s*$/.test(prev.text) ||
          (/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s*$/i.test(prev.text) &&
            /^(19|20)\d{2}$/.test(cur.gutter)));
      if (textOpen) {
        prev.text += " " + cur.gutter;
        cur.gutter = "";
        break;
      }
      if (prev.gutter) break;
    }
  }
  // Same reunification when the wrapped year renders as a LINE of its own
  // ("Aug 2025 - Dec" above a lone "2025").
  for (let i = 1; i < rendered.length; i++) {
    const cur = rendered[i];
    const prev = rendered[i - 1];
    if (
      /^(19|20)\d{2}$/.test(cur.text.trim()) &&
      !cur.gutter &&
      (/-\s*$/.test(prev.gutter || prev.text) ||
        /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s*$/i.test(prev.gutter || prev.text))
    ) {
      if (prev.gutter) prev.gutter += " " + cur.text.trim();
      else prev.text += " " + cur.text.trim();
      cur.text = "";
    }
  }
  for (const l of rendered) {
    if (l.gutter) l.text = l.text ? `${l.text}   ${l.gutter}` : l.gutter;
  }

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

export function tidy(s: string): string {
  return s
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{4,}/g, "   ")
    .trim();
}

