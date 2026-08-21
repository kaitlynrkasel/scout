// Lets the readiness checker import the app's own TypeScript modules directly,
// so a check exercises the SHIPPING function rather than a copy of it. Node 24
// strips the types itself; all this adds is Next's two resolution habits that
// bare Node doesn't have: extensionless relative imports, and the "@/" alias.
import { register } from "node:module";
register("./readiness-resolve.mjs", import.meta.url);
