import type { Template, TemplateKey } from "./types";

// The "one engine, multiple templates" core. Each template is the same kind of
// config object your Internship Scout used (PROFILES) and your Anna Belt Scout
// used (CONFIG_DEFAULTS) — just data. Adding a new vertical = adding an entry here.

export const TEMPLATES: Record<TemplateKey, Template> = {
  networking: {
    key: "networking",
    label: "Networking",
    blurb: "Find people in a field and write warm coffee-chat outreach.",
    targetNoun: "people",
    goalPlaceholder: "e.g. people who work in A&R at indie labels in Nashville",
    aboutPlaceholder:
      "A sentence or two about you — who you are and what you're hoping to learn.",
    exampleGoal: "A&R and artist development people at indie labels in Nashville",
    exampleAbout:
      "I'm a Belmont music business student and founder of a small artist-development company, hoping to learn from people doing A&R.",
    queryTails: [
      "{goal} LinkedIn",
      "people who work in {goal}",
      "{goal} contact",
      "{goal} email",
      "{goal} team members",
    ],
    draftStyle:
      "A warm, genuine, peer-to-peer note that shares specific interest in this person's work and softly asks for a quick call or coffee. NOT a job pitch. Short and human.",
  },
  jobs: {
    key: "jobs",
    label: "Job / Internship Search",
    blurb: "Find openings and write tailored cover-letter outreach.",
    targetNoun: "openings",
    goalPlaceholder: "e.g. remote marketing internships at music companies",
    aboutPlaceholder:
      "Your background, skills, school/role, and what you're looking for.",
    exampleGoal: "remote marketing & communications internships in the music industry",
    exampleAbout:
      "A Belmont music business junior with internship experience at Warner Music Group and BMI, strong in social media, writing, and catalog admin.",
    queryTails: [
      "{goal} apply",
      "{goal} hiring",
      "{goal} internship 2026",
      "{goal} careers",
      "{goal} job posting",
    ],
    draftStyle:
      "A tailored cover-letter / outreach email connecting the candidate's real experience to this specific role, with a soft ask to be considered. Warm but professional.",
  },
  musicpr: {
    key: "musicpr",
    label: "Music PR / Playlisting",
    blurb: "Find curators, blogs, and press and write pitch outreach.",
    targetNoun: "outlets",
    goalPlaceholder: "e.g. indie folk Spotify playlist curators accepting submissions",
    aboutPlaceholder:
      "The artist and the release you're promoting, plus the genre and influences.",
    exampleGoal: "indie folk-rock playlist curators and blogs accepting submissions",
    exampleAbout:
      "Promoting Anna Belt, a Nashville singer-songwriter (folk-rock, indie), new single out now, for fans of Stevie Nicks and Maggie Rogers.",
    queryTails: [
      "{goal} submit",
      "submit music to {goal}",
      "{goal} contact email",
      "{goal} accepting submissions 2026",
      "{goal} curator",
    ],
    draftStyle:
      "A warm, humble, non-salesy pitch for fans of the artist's influences, with a specific personalized line and a soft ask to be considered. NO hype.",
  },
};

export const TEMPLATE_LIST: Template[] = Object.values(TEMPLATES);
