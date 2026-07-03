// Drafting engine: channel-aware, voice-matched outreach per opportunity.
// Ported/condensed from claudeDraft() in 04_Drafting.gs. Picks email vs message
// from the contact we actually have, and never fabricates.

import { claudeJson, parseJsonLoose, noDash } from "./claude";
import { resolveTemplate, GENERIC } from "./templates";
import { ApiCreditError } from "./apiErrors";
import type { Draft, Opportunity, OutreachTemplate } from "./types";

function pickChannel(opp: Opportunity): {
  channelType: Draft["channelType"];
  to: string;
} {
  if (opp.contactEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(opp.contactEmail))
    return { channelType: "email", to: opp.contactEmail };
  if (opp.contactHandle) return { channelType: "message", to: opp.contactHandle };
  if (opp.url) return { channelType: "form", to: opp.url };
  return { channelType: "email", to: "" };
}

function templateBlock(
  templates: OutreachTemplate[],
  channelType: Draft["channelType"]
): string {
  if (!templates || !templates.length) return "";
  // Prefer templates whose channel matches what we're writing; fall back to all.
  const wantEmail = channelType === "email";
  const matched = templates.filter((s) =>
    wantEmail
      ? /email|cover/i.test(s.channel)
      : /linkedin|instagram|tiktok|twitter|x dm|\bdm\b|message|text|note|other/i.test(
          s.channel
        )
  );
  const use = (matched.length ? matched : templates).slice(0, 4);
  if (!use.length) return "";
  return (
    "\n\nTEMPLATES the sender set up for their outreach. Match the FORMAT and VOICE of the " +
    "one that fits this channel closely, its tone, warmth, structure, and rough length. " +
    "Do NOT copy the content, adapt every detail to THIS recipient:\n" +
    use
      .map((s, i) => `${i + 1}. [${s.channel}] ${s.text.replace(/\s+/g, " ").trim()}`)
      .join("\n\n")
  );
}

// Coaching directives the user approved from their dashboard — applied to every draft.
function coachingBlock(coaching?: string[]): string {
  const c = (coaching || []).map((s) => String(s || "").trim()).filter(Boolean).slice(0, 8);
  if (!c.length) return "";
  return (
    "\n\nCOACHING the user approved (follow ALL of these in this message):\n" +
    c.map((d) => `- ${d}`).join("\n")
  );
}

// The strongest voice signal: how the user rewrote earlier drafts. Learn the delta.
function editBlock(editPairs?: { before: string; after: string }[]): string {
  const p = (editPairs || []).filter((x) => x && x.after).slice(0, 4);
  if (!p.length) return "";
  return (
    "\n\nMOST IMPORTANT — corrections the user made to earlier drafts. Study what changed from BEFORE " +
    "(what the engine wrote) to AFTER (how the user rewrote it): the tone, cuts, softening, length, openings/closings. " +
    "Proactively make those same kinds of changes and match that tone here. Do NOT copy the content, copy the pattern:\n" +
    p.map((x, i) => `${i + 1}. BEFORE: ${x.before.slice(0, 500)}\n   AFTER: ${x.after.slice(0, 500)}`).join("\n\n")
  );
}

// What this specific target asks for (pasted by the user or found by deep-scan).
function requirementsBlock(requirements?: string): string {
  const r = String(requirements || "").trim();
  if (!r) return "";
  return (
    "\n\nREQUIREMENTS this specific recipient asks for (make the message satisfy them exactly — " +
    "put a requested detail in the subject, hit a requested length/format, mention what they ask to mention): " +
    r.replace(/\s+/g, " ").slice(0, 900)
  );
}

export async function draftFor(
  opp: Opportunity,
  about: string,
  useCase: string,
  opts: {
    templates?: OutreachTemplate[];
    coaching?: string[];
    editPairs?: { before: string; after: string }[];
    requirements?: string;
  } = {}
): Promise<Draft> {
  const templates = opts.templates || [];
  const requirements = opts.requirements || (opp as any).requirements || "";
  const t = resolveTemplate(useCase);
  const draftStyle = t ? t.draftStyle : GENERIC.draftStyle;
  const { channelType, to } = pickChannel(opp);

  const sys =
    `You write outreach for someone whose use case is "${useCase}". ` +
    `Voice: warm, genuine, human, first person, never salesy. ` +
    `NEVER use em-dashes or en-dashes; use commas and periods like a normal typed email. ` +
    `Write SHORT paragraphs (1 to 3 sentences) separated by a blank line ("\\n\\n"). ` +
    `Any personalized reference MUST be specific and TRUE, taken only from the provided note. ` +
    `If no specific note is given, do not invent one. Never fabricate facts about the sender beyond what is provided. ` +
    `Return ONLY JSON.`;

  const recipient =
    `RECIPIENT: ${opp.name}` +
    (opp.outlet ? ` at ${opp.outlet}` : "") +
    (opp.location ? `, based in ${opp.location}` : "") +
    `. Specific note (the ONLY basis for personalization, may be empty): "${opp.whyItFits || ""}".`;

  const sender = `ABOUT THE SENDER (draw on what fits, do not list it all): ${about}`;

  const purpose = `PURPOSE / STYLE of this message: ${draftStyle}`;

  let task: string;
  if (channelType === "email") {
    task =
      `Write an EMAIL. Return JSON {subject, body}. ` +
      `subject = honest, specific, low-key, no em-dashes. ` +
      `body = greeting + 2 to 3 short paragraphs + a sign-off, the WHOLE message, ready to send. ` +
      `Open with the specific personalized line if a real note exists; otherwise a genuine specific reason for reaching out. Then the ask from PURPOSE.`;
  } else {
    task =
      `Write a SHORT ${channelType === "message" ? "LinkedIn / DM" : "form / message"} note (2 to 4 sentences). ` +
      `Return JSON {subject, body} with subject empty. ` +
      `body = a warm, genuine note reflecting PURPOSE, with the personalized line if real.`;
  }

  const tpl = templateBlock(templates, channelType);
  const extras =
    requirementsBlock(requirements) +
    coachingBlock(opts.coaching) +
    editBlock(opts.editPairs);

  let gen: any = null;
  try {
    gen = parseJsonLoose(
      await claudeJson(
        sys,
        `${sender}\n\n${recipient}\n\n${purpose}\n\n${task}${tpl}${extras}`
      )
    );
  } catch (e) {
    if (e instanceof ApiCreditError) throw e; // credits/auth/limit — don't swallow
    gen = null;
  }

  return {
    opportunityId: opp.id,
    to,
    channelType,
    subject: noDash(gen?.subject || ""),
    body: noDash(gen?.body || "(could not generate a draft for this one — try again)"),
    whyItFits: opp.whyItFits,
  };
}
