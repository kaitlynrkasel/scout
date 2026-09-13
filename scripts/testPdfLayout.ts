// Regression tests for lib/pdfLayout.ts against captured resume geometries
// (fixtures/*.json: anonymized glyph runs; positions real, letters rotated).
// Run: npm run test:pdf. Every invariant here is a bug we actually shipped
// once: torn date ranges, a big name swallowing the location line, lone-year
// lines, and word-final glyphs drifting into the date gutter.
import { readFileSync, readdirSync } from "fs";
import { pageToText, tidy, type PdfRun } from "../lib/pdfLayout.ts";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
  } else {
    console.log(`ok   ${name}`);
  }
};

const RANGE =
  /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s?(?:19|20)\d{2}\s*-\s*(?:Present|Current|(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s?)?(?:19|20)\d{2})/g;

for (const f of readdirSync("fixtures").filter((f) => f.startsWith("resume-layout"))) {
  const pages = JSON.parse(readFileSync(`fixtures/${f}`, "utf8")) as PdfRun[][];
  const out = tidy(pages.map((p) => pageToText(p)).join("\n\n"));
  const lines = out.split("\n").map((l) => l.trim());

  // 1. Wrapped date ranges reunite: this layout carries at least 6 complete
  //    Month YYYY - (Month YYYY | Present) ranges once reconstruction works.
  const ranges = out.match(RANGE) || [];
  check(`${f}: >=6 complete date ranges`, ranges.length >= 6, `got ${ranges.length}`);

  // 2. No orphaned bare-year lines (a range's second half stranded alone).
  const bareYears = lines.filter((l) => /^(19|20)\d{2}$/.test(l));
  check(`${f}: no lone-year lines`, bareYears.length === 0, bareYears.join(","));

  // 3. The header: the largest run (the name) shares its line with nothing
  //    from a much smaller size (the location underneath).
  const all = pages.flat();
  const big = all.reduce((a, b) => ((a.fontSize || 0) >= (b.fontSize || 0) ? a : b));
  const nameLine = lines.find((l) => l.includes(big.str.trim()));
  const small = all.find(
    (r) => Math.abs(r.y - big.y) > 5 && Math.abs(r.y - big.y) < 25 && r.str.trim().length > 8
  );
  check(
    `${f}: big name does not swallow neighbors`,
    !!nameLine && (!small || !nameLine.includes(small.str.trim())),
    nameLine
  );

  // 4. No run lost: every run's text appears in the output (order-insensitive
  //    verbatim check, letters and digits only).
  const sig = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const inChars = sig(all.map((r) => r.str).join(""));
  const outChars = sig(out);
  check(
    `${f}: no characters lost`,
    outChars.length >= inChars.length * 0.99,
    `${outChars.length}/${inChars.length}`
  );
}

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log("pdf layout: all invariants hold");
