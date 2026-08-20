import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // must reflect the RUNNING deploy, never a cached one

// The commit the currently deployed server is running. The browser bundle bakes
// its own copy in at build time (NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA), so a tab
// that has been open across a deploy can notice the two no longer match and
// offer a refresh.
//
// This exists because Scout is a single-page app: once /app is loaded, no
// further navigation happens, so a tab left open all afternoon keeps running
// whatever JavaScript it started with. Server fixes go live immediately while
// the client half stays hours behind, which looks exactly like the fix not
// working.
export async function GET() {
  const build =
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ||
    "";
  return NextResponse.json(
    { build },
    { headers: { "cache-control": "no-store, max-age=0" } }
  );
}
