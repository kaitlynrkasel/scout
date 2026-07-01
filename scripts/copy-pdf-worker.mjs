// Copy the pdf.js worker into /public so it's served same-origin and always
// version-matched to the installed pdfjs-dist. Runs before dev/build (predev /
// prebuild), so it works locally and on Vercel without any CDN dependency.
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const pkg = require.resolve("pdfjs-dist/package.json");
const src = join(dirname(pkg), "build", "pdf.worker.min.mjs");
const destDir = join(process.cwd(), "public");
const dest = join(destDir, "pdf.worker.min.mjs");

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
console.log("[copy-pdf-worker] copied worker ->", dest);
