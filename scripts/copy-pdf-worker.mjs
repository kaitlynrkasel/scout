// Copy the pdf.js worker into /public so it's served same-origin and always
// version-matched to the installed pdfjs-dist. Runs before dev/build (predev /
// prebuild), so it works locally and on Vercel without any CDN dependency.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const pkg = require.resolve("pdfjs-dist/package.json");
// LEGACY worker to match the legacy main build imported in lib/fileText.ts —
// the modern build breaks on older Safari/iOS ("undefined is not a function").
const src = join(dirname(pkg), "legacy", "build", "pdf.worker.min.mjs");
const destDir = join(process.cwd(), "public");
const dest = join(destDir, "pdf.worker.min.mjs");

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);

// The worker runs in its own JS context, so the main-thread polyfill in
// lib/fileText.ts doesn't reach it. pdf.js 6 uses Promise.withResolvers() inside
// the worker too, which is missing on browsers older than Safari 17.4 / Chrome
// 119. Prepend the same polyfill so the worker survives on those browsers.
const POLYFILL =
  'if(typeof Promise.withResolvers!=="function"){Promise.withResolvers=function(){' +
  "let resolve,reject;const promise=new Promise((res,rej)=>{resolve=res;reject=rej;});" +
  "return{promise,resolve,reject};};}\n";
const worker = readFileSync(dest, "utf8");
if (!worker.startsWith(POLYFILL)) writeFileSync(dest, POLYFILL + worker);
console.log("[copy-pdf-worker] copied worker (+ withResolvers polyfill) ->", dest);
