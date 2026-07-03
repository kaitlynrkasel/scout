import { NextRequest, NextResponse } from "next/server";
import { claudeJson, parseJsonLoose } from "@/lib/claude";
import { ApiCreditError } from "@/lib/apiErrors";

export const maxDuration = 30;

// Read an uploaded resume / bio / company doc and pull out the couple of profile
// fields we can prefill (name + a likely use case). Never fabricates: blanks a
// field it can't find. The full text still becomes the bio on the client.
export async function POST(req: NextRequest) {
  try {
    const { text } = await req.json();
    const t = String(text || "").slice(0, 12000);
    if (!t.trim()) {
      return NextResponse.json({ error: "No text to read." }, { status: 400 });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json(
        { error: "Missing ANTHROPIC_API_KEY in .env.local." },
        { status: 500 }
      );
    }
    const sys =
      "You read a resume, bio, or company description and extract profile fields " +
      "for a personal outreach tool. Return ONLY a JSON object, no prose. Never invent facts, " +
      "leave a field as an empty string (or null for numbers) if it is not present or reasonably inferable. " +
      "Lean toward filling every field you can from the evidence in the document — the user prefers a full " +
      "profile they can edit over a blank one — but do NOT fabricate. Inference from concrete evidence is fine; " +
      "guessing without evidence is not.\n\n" +
      "name = the person's full name (or the company name if this is a company document); empty if unclear.\n" +
      "use_case = a short phrase (2 to 5 words) for what this person would most likely use an outreach tool for, " +
      "e.g. 'Job / Internship search', 'Networking', 'Music PR / Playlisting', 'Sales / lead generation', " +
      "'Recruiting / hiring', 'Fundraising / investors', 'Press & media outreach'. Choose the single best fit.\n" +
      "signature = a short professional email signature built ONLY from details that actually appear in the document: " +
      "the person's name on the first line, then their current title/role and company if present, then contact lines " +
      "(email, phone) and any links (LinkedIn, website), each on its own line. NEVER invent an email, phone number, " +
      "title, company, or link. If only the name is present, the signature is just the name. Plain text with real " +
      "newline characters between lines, no markdown, no em-dashes.\n" +
      "age = an integer if a birth year, graduation year, or explicit age lets you calculate it (e.g. 'junior at USC' " +
      "→ ~20, 'MFA class of 2019' → ~30). null if you can't infer with reasonable confidence.\n" +
      "education = ONE short phrase describing their current schooling or highest completed education, e.g. 'USC junior', " +
      "'MFA 2022, Berklee', 'self-taught', 'PhD candidate, Stanford CS'. Empty if not present.\n" +
      "location = 'City, State' or 'City, Country' if explicitly listed; empty otherwise. Do not guess from area codes.\n" +
      "company_size = 'small' if the document shows preference for startups / small teams / early-stage work, " +
      "'big' if it shows preference for Fortune 500 / big-name brands / enterprise, or 'any' when it's balanced or " +
      "unclear. Default to 'any' unless there's clear signal.\n" +
      "competitiveness = a self-assessed applicant tier based on concrete evidence in the document: 'competitive' " +
      "(top-tier school + selective past internships like FAANG / Jane Street / McKinsey, or comparable pedigree), " +
      "'intermediate' (a few real internships or notable projects, mid-tier school, some track record), 'beginner' " +
      "(no prior internships, freshman/sophomore, few projects listed, or a first-time applicant vibe), or 'any' when " +
      "the document doesn't reveal enough to place them. Bias toward 'beginner' when in doubt for students without a " +
      "clear track record — Scout users tend to be beginners looking for their first shot.";
    const user =
      `Fields: name (string), use_case (string), signature (string with newlines), age (integer or null), ` +
      `education (string), location (string), company_size ('any'|'small'|'big'), ` +
      `competitiveness ('any'|'beginner'|'intermediate'|'competitive').\n\nDOCUMENT:\n${t}`;
    const parsed = parseJsonLoose(await claudeJson(sys, user));
    const allowedSize = new Set(["any", "small", "big"]);
    const allowedComp = new Set(["any", "beginner", "intermediate", "competitive"]);
    const rawAge = parsed?.age;
    const ageNum = typeof rawAge === "number" && Number.isFinite(rawAge) && rawAge > 12 && rawAge < 100
      ? Math.round(rawAge)
      : null;
    const rawSize = String(parsed?.company_size || parsed?.companySize || "").trim().toLowerCase();
    const rawComp = String(parsed?.competitiveness || "").trim().toLowerCase();
    return NextResponse.json({
      name: String(parsed?.name || "").trim(),
      useCase: String(parsed?.use_case || parsed?.useCase || "").trim(),
      signature: String(parsed?.signature || "").trim(),
      age: ageNum,
      education: String(parsed?.education || parsed?.college || "").trim(),
      location: String(parsed?.location || "").trim(),
      companySize: allowedSize.has(rawSize) ? rawSize : "",
      competitiveness: allowedComp.has(rawComp) ? rawComp : "",
    });
  } catch (e: any) {
    if (e instanceof ApiCreditError) {
      return NextResponse.json(
        { error: e.userMessage(), credit: true, provider: e.provider, reason: e.reason },
        { status: 402 }
      );
    }
    return NextResponse.json(
      { error: e?.message || "Could not read that document." },
      { status: 500 }
    );
  }
}
