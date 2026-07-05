import { NextRequest, NextResponse } from "next/server";

// Bounce the retired old deployment to the canonical site so there aren't two
// live copies floating around. ONLY the exact old hosts below redirect — the
// live site (scout-source.com) and its own preview URLs match none of them and
// pass through untouched. This lives in the shared repo, so it takes effect on
// the old deployment the next time that project builds from this code.
const OLD_HOSTS = new Set(["cue-connect-alpha.vercel.app"]);
const CANONICAL = "https://scout-source.com";

export function middleware(req: NextRequest) {
  const host = (req.headers.get("host") || "").toLowerCase();
  if (OLD_HOSTS.has(host)) {
    const dest = new URL(req.nextUrl.pathname + req.nextUrl.search, CANONICAL);
    return NextResponse.redirect(dest, 308); // permanent, preserves path + query
  }
  return NextResponse.next();
}

export const config = {
  // Run on page/app routes; skip Next internals and static asset files.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp|txt|xml|json)$).*)",
  ],
};
