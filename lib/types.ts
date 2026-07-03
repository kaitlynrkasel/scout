// Shared types for the Scout engine. These mirror the columns the Apps Script
// tools store on the Discovered / Drafts tabs, so the later DB migration is a
// near-direct map (OPP_SPEC -> Opportunity, DRAFT_SPEC -> Draft).

export type TemplateKey = "networking" | "jobs" | "musicpr";

export interface Template {
  key: TemplateKey;
  label: string;
  blurb: string;
  // What an "opportunity" is in this vertical (people vs postings vs outlets).
  targetNoun: string;
  // Placeholder copy for the two setup fields.
  goalPlaceholder: string;
  aboutPlaceholder: string;
  // The default goal/about shown so the spike is one-click runnable.
  exampleGoal: string;
  exampleAbout: string;
  // Search-query scaffolds (the {goal} token is replaced at runtime). Mirrors
  // buildQueries() in 07_Discovery.gs.
  queryTails: string[];
  // How the drafter should frame the message in this vertical.
  draftStyle: string;
}

export interface Opportunity {
  id: string;
  name: string; // person/company/outlet + role
  outlet: string; // org / company / publication
  url: string; // primary link
  channel: string; // Email / LinkedIn / Website Form / etc.
  contactEmail: string;
  contactName: string;
  contactRole: string;
  contactHandle: string;
  location: string;
  timezone?: string; // IANA tz inferred from location (e.g. America/Chicago), for send timing
  fitScore: number | null; // 0..1
  whyItFits: string; // recent/specific note used to personalize
  sourceTitle: string;
  sourceSnippet: string;
}

export interface Draft {
  opportunityId: string;
  to: string; // email or handle
  channelType: "email" | "message" | "form";
  subject: string;
  body: string;
  whyItFits: string;
  attachResume?: boolean; // suggested default for attaching the user's resume
}

// An outreach template: how a given KIND of message (email, LinkedIn note,
// Instagram DM, ...) should sound. The drafter matches the format + voice of the
// template that fits the channel it's writing. Mirrors OUTREACH_SAMPLE +
// the edit-learning loop (EDIT_EXAMPLES) in the Apps Script tools.
export interface OutreachTemplate {
  id: string;
  channel: string; // "Email" | "LinkedIn message" | "Instagram DM" | ...
  text: string;
  // Scope: which outreach this voice applies to. Empty projectId = every project
  // (global). projectId set = only that project. categoryId set (implies a
  // project) = only that category. Older templates have neither and stay global.
  projectId?: string;
  categoryId?: string;
}
