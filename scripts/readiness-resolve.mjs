import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXTS = [".ts", ".tsx", "/index.ts", "/index.tsx", ".mjs", ".js"];

// A .ts file must be handed back as "module-typescript" or Node skips type
// stripping and chokes on the first type annotation.
const fmt = (p) => (/\.tsx?$/.test(p) ? "module-typescript" : "module");
const hit = (p) => ({ url: pathToFileURL(p).href, shortCircuit: true, format: fmt(p) });

export async function resolve(spec, ctx, next) {
  let base = null;
  if (spec.startsWith("@/")) base = path.join(ROOT, spec.slice(2));
  else if (spec.startsWith(".") && ctx.parentURL?.startsWith("file:"))
    base = path.resolve(path.dirname(fileURLToPath(ctx.parentURL)), spec);
  if (base) {
    if (fs.existsSync(base) && fs.statSync(base).isFile()) return hit(base);
    for (const e of EXTS) if (fs.existsSync(base + e)) return hit(base + e);
  }
  return next(spec, ctx);
}
