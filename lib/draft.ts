// Drafting engine: channel-aware, voice-matched outreach per opportunity.
// Ported/condensed from claudeDraft() in 04_Drafting.gs. Picks email vs message
// from the contact we actually have, and never fabricates.

import { claudeJson, parseJsonLoose, noDash } from "./claude";
import { TEMPLATES } from "./templates";
import { ApiCreditError } from "./apiErrors";
import type { Draft, Opportunity, OutreachTemplate, TemplateKey } from "./types";

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

export async function draftFor(
  opp: Opportunity,
  about: string,
  templateKey: TemplateKey,
  templates: OutreachTemplate[] = []
): Promise<Draft> {
  const t = TEMPLATES[templateKey];
  const { channelType, to } = pickChannel(opp);

  const sys =
    `You write outreach for someone reaching out in the "${t.label}" context. ` +
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

  const purpose = `PURPOSE / STYLE of this message: ${t.draftStyle}`;

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

  let gen: any = null;
  try {
    gen = parseJsonLoose(
      await claudeJson(
        sys,
        `${sender}\n\n${recipient}\n\n${purpose}\n\n${task}${tpl}`
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
