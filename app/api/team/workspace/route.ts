import { NextRequest, NextResponse } from "next/server";
import { userFromReq } from "@/lib/supabaseAdmin";
import {
  createWorkspace,
  getWorkspaceContext,
  updateWorkspaceDetails,
  deleteWorkspace,
  TeamError,
} from "@/lib/teams";

export const runtime = "nodejs";

// Owner-only: edit the company's onboarding answers (name/about/industry/website).
export async function PATCH(req: NextRequest) {
  const u = await userFromReq(req);
  if (!u) return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  try {
    const { workspaceId, name, about, website, industry, stage } = await req.json();
    const ws = await updateWorkspaceDetails(u.id, String(workspaceId || ""), {
      name,
      about,
      website,
      industry,
      stage,
    });
    return NextResponse.json({ workspace: ws });
  } catch (e: any) {
    const status = e instanceof TeamError ? e.status : 500;
    return NextResponse.json({ error: e?.message || "Failed." }, { status });
  }
}

// The caller's workspaces (with members) + pending invites addressed to them.
export async function GET(req: NextRequest) {
  const u = await userFromReq(req);
  if (!u) return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  try {
    return NextResponse.json(await getWorkspaceContext(u.id, u.email));
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Failed." }, { status: e?.status || 500 });
  }
}

// Owner-only: permanently delete the company (confirmed by typing its name).
export async function DELETE(req: NextRequest) {
  const u = await userFromReq(req);
  if (!u) return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  try {
    const { workspaceId, confirmName } = await req.json();
    const r = await deleteWorkspace(u.id, String(workspaceId || ""), String(confirmName || ""));
    return NextResponse.json(r);
  } catch (e: any) {
    const status = e instanceof TeamError ? e.status : 500;
    return NextResponse.json({ error: e?.message || "Failed." }, { status });
  }
}

// Create a workspace (the caller becomes its owner).
export async function POST(req: NextRequest) {
  const u = await userFromReq(req);
  if (!u) return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  try {
    const { name, about, website, industry, stage } = await req.json();
    const ws = await createWorkspace(u.id, u.email, String(name || ""), {
      about: about ? String(about) : "",
      website: website ? String(website) : "",
      industry: industry ? String(industry) : "",
      stage: stage ? String(stage) : "",
    });
    return NextResponse.json({ workspace: ws });
  } catch (e: any) {
    const status = e instanceof TeamError ? e.status : 500;
    return NextResponse.json({ error: e?.message || "Failed." }, { status });
  }
}
