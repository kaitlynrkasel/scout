import { NextRequest, NextResponse } from "next/server";
import { claudeJson, parseJsonLoose, noDash } from "@/lib/claude";
import { ApiCreditError } from "@/lib/apiErrors";

export const runtime = "nodejs";
export const maxDuration = 25;

// Turn a fresh profile (what the company does / a resume summary) into the
// projects + search categories the person will ACTUALLY use, instead of generic
// "Coffee Chats" defaults. Example: a Belmont student org whose director plans
// events with speakers should get a "Spring Showcase" style project with
// categories like "Guest speakers", "Panelists", "Sponsors", "Venue partners".
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const about = String(body.about || "").trim();
    const role = String(body.role || "").trim();
    const contribution = String(body.contribution || "").trim();
    const industry = String(body.industry || "").trim();
    const useCase = String(body.useCase || "").trim();
    const name = String(body.name || "").trim(); // company or person name

    // Not enough signal to anticipate anything specific: let the client keep its
    // generic seed rather than invent categories from nothing.
    if (about.length < 15 && contribution.length < 15) {
      return NextResponse.json({ projects: [] });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json({ projects: [] });
    }

    const sys =
      "You set up a cold-outreach workspace for a new user of a tool called Scout. " +
      "Scout finds real people/opportunities on the open web and drafts warm outreach. " +
      "From what you know about them, anticipate the OUTREACH they'll actually run and " +
      "return a small, concrete starter plan: 1 to 2 PROJECTS (a project is one goal, " +
      "client, or initiative) each with 3 to 5 CATEGORIES (a category is one specific " +
      "kind of person to find). Categories must be specific to THIS user's real work, " +
      "never generic filler like 'Networking' or 'Coffee Chats'. Each category needs a " +
      "'goal': a one-line description of exactly who to find, written so a search engine " +
      "could act on it. Base everything only on the facts given; do not invent a different " +
      "line of work. Return STRICT JSON: " +
      '{"projects":[{"name":"...","useCase":"...","categories":[{"name":"...","goal":"..."}]}]}. ' +
      "useCase is a short free-text label for the kind of outreach (e.g. 'Event booking', " +
      "'Music PR', 'Recruiting', 'Sales'). Keep names short (2 to 4 words).";

    const facts = [
      name && `Name: ${name}`,
      about && `What they do: ${about}`,
      industry && `Industry: ${industry}`,
      role && `Their role: ${role}`,
      contribution && `What they personally do / want to use Scout for: ${contribution}`,
      useCase && `Stated use case: ${useCase}`,
    ]
      .filter(Boolean)
      .join("\n");

    const gen = parseJsonLoose<any>(await claudeJson(sys, facts));
    const rawProjects = Array.isArray(gen?.projects) ? gen.projects : [];
    const projects = rawProjects
      .slice(0, 2)
      .map((p: any) => ({
        name: noDash(String(p?.name || "").trim()).slice(0, 60),
        useCase: noDash(String(p?.useCase || "").trim()).slice(0, 60),
        categories: (Array.isArray(p?.categories) ? p.categories : [])
          .slice(0, 5)
          .map((c: any) => ({
            name: noDash(String(c?.name || "").trim()).slice(0, 60),
            goal: noDash(String(c?.goal || "").trim()).slice(0, 300),
          }))
          .filter((c: any) => c.name && c.goal),
      }))
      .filter((p: any) => p.name && p.categories.length);

    return NextResponse.json({ projects });
  } catch (e: any) {
    if (e instanceof ApiCreditError) {
      return NextResponse.json({ projects: [] }); // never block onboarding
    }
    return NextResponse.json({ projects: [] });
  }
}
