import { Nav, Footer } from "./site";

export const metadata = {
  title: "Scout — Find the right people, reach out in your voice",
  description:
    "Scout finds the people and opportunities that fit your goal, pulls their contact info, and drafts personalized outreach that sounds like you.",
};

export default function Landing() {
  return (
    <div className="min-h-screen">
      <Nav />

      {/* Hero */}
      <section className="relative overflow-hidden bg-warm-fade">
        <div className="pointer-events-none absolute -right-32 -top-32 h-96 w-96 rounded-full bg-brand-gradient opacity-[0.12] blur-3xl" />
        <div className="mx-auto grid max-w-6xl items-center gap-10 px-6 pb-16 pt-16 lg:grid-cols-[1.25fr_1fr]">
          <div>
            <span className="inline-block rounded-full border border-warm-border bg-white px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-accent shadow-card">
              One place for every conversation
            </span>
            <h1 className="mt-5 text-5xl font-extrabold leading-[1.05] tracking-tight text-ink sm:text-6xl">
              We Search,
              <br />
              <span className="brand-text">You Smile</span>
            </h1>
            <p className="mt-5 max-w-xl text-[16px] leading-relaxed text-body">
              Scout searches the public web for the people and opportunities that fit
              your goal, finds their real contact info, and drafts warm, personal
              messages that sound like you. Reaching out finally feels easy.
            </p>
            <div className="mt-7 flex flex-wrap items-center gap-3">
              <a
                href="/app"
                className="rounded-xl bg-brand-gradient px-6 py-3.5 text-sm font-bold text-white shadow-soft transition hover:opacity-95"
              >
                Try Scout free
              </a>
              <a
                href="/analytics"
                className="rounded-xl border border-warm-border bg-white px-6 py-3.5 text-sm font-bold text-ink transition hover:bg-warm-bg"
              >
                See the proof
              </a>
            </div>
            <p className="mt-3 text-xs text-body/60">
              No account needed to try. Works for networking, job searches, press,
              partnerships, and more.
            </p>
          </div>

          {/* Conversation mock */}
          <div className="hidden lg:block">
            <div className="relative mx-auto h-72 w-full max-w-sm">
              <div className="absolute right-2 top-0 w-64 rounded-2xl rounded-tr-sm border border-warm-border bg-white p-4 shadow-soft">
                <span className="absolute -right-[6px] top-6 h-3 w-3 rotate-45 border-r border-t border-warm-border bg-white" />
                <div className="mb-2 flex items-center gap-2">
                  <span className="h-6 w-6 rounded-full bg-brand-gradient" />
                  <span className="text-xs font-bold text-ink">You</span>
                  <span className="ml-auto text-[10px] font-semibold uppercase tracking-wide text-accent">
                    Email
                  </span>
                </div>
                <div className="space-y-1.5">
                  <div className="h-2 w-full rounded-full bg-warm-bg" />
                  <div className="h-2 w-5/6 rounded-full bg-warm-bg" />
                  <div className="h-2 w-2/3 rounded-full bg-warm-bg" />
                </div>
              </div>
              <div className="absolute left-0 top-32 w-56 rounded-2xl rounded-tl-sm bg-brand-gradient p-4 text-white shadow-soft">
                <span className="absolute -left-[6px] top-6 h-3 w-3 rotate-45 bg-[#ff8159]" />
                <div className="mb-2 flex items-center gap-2">
                  <span className="h-6 w-6 rounded-full bg-white/30" />
                  <span className="text-xs font-bold">Reply</span>
                  <span className="ml-auto text-[10px] font-semibold uppercase tracking-wide text-white/80">
                    LinkedIn
                  </span>
                </div>
                <div className="space-y-1.5">
                  <div className="h-2 w-full rounded-full bg-white/35" />
                  <div className="h-2 w-3/4 rounded-full bg-white/35" />
                </div>
              </div>
              <div className="absolute bottom-2 right-12 flex items-center gap-1.5 rounded-full border border-warm-border bg-white px-3 py-2 shadow-card">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-coral" />
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-blush [animation-delay:150ms]" />
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-coral [animation-delay:300ms]" />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Proof strip */}
      <section className="border-y border-warm-border bg-white">
        <div className="mx-auto grid max-w-6xl gap-px overflow-hidden rounded-none sm:grid-cols-3">
          <Stat big="Minutes, not hours" small="Find, research, and draft outreach in about a minute per person." />
          <Stat big="3–10× more replies" small="Personalized, targeted outreach vs. generic blasts (industry estimates)." />
          <Stat big="Real contacts only" small="Pulled from the public web. Never invented, never fabricated." />
        </div>
      </section>

      {/* Use cases */}
      <UseCases />

      {/* Features */}
      <section id="features" className="mx-auto max-w-6xl px-6 py-20">
        <h2 className="text-3xl font-extrabold tracking-tight text-ink">
          Everything you need to <span className="brand-text">reach out well</span>
        </h2>
        <p className="mt-2 max-w-2xl text-[15px] text-body">
          Scout handles the tedious parts of outreach so you can focus on the
          conversations that matter.
        </p>
        <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          <Feature
            title="Find anyone"
            body="Describe who you want to reach in plain language. Scout searches the open web and surfaces the best fits."
          />
          <Feature
            title="Real contact info"
            body="Emails, names, and handles pulled from public pages, with a fit score so you know who is worth it."
          />
          <Feature
            title="Your voice"
            body="Add your own examples and Scout drafts every message to match your tone, not a robotic template."
          />
          <Feature
            title="Every channel"
            body="Email, LinkedIn, Instagram, and more. Scout writes the right format for each one."
          />
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="bg-warm-bg/60">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <h2 className="text-3xl font-extrabold tracking-tight text-ink">
            How it <span className="brand-text">works</span>
          </h2>
          <div className="mt-10 grid gap-5 sm:grid-cols-3">
            <HowStep
              n="1"
              title="Tell Scout your goal"
              body="Pick a category and describe the people or opportunities you want, in your own words."
            />
            <HowStep
              n="2"
              title="Scout finds them"
              body="It reads the public web, pulls real contacts, and scores each match against your goal."
            />
            <HowStep
              n="3"
              title="Say hello, your way"
              body="Review warm, personalized drafts for each channel. Tweak, copy, and send."
            />
          </div>
          <div className="mt-10">
            <a
              href="/analytics"
              className="inline-flex items-center gap-2 rounded-xl border border-warm-border bg-white px-5 py-3 text-sm font-bold text-ink shadow-card transition hover:bg-warm-bg"
            >
              See the data behind it
              <span aria-hidden>→</span>
            </a>
          </div>
        </div>
      </section>

      {/* Meet the team */}
      <MeetTheTeam />

      {/* CTA */}
      <section className="mx-auto max-w-6xl px-6 py-20">
        <div className="relative overflow-hidden rounded-3xl bg-brand-gradient px-8 py-14 text-center shadow-soft">
          <h2 className="text-3xl font-extrabold tracking-tight text-white sm:text-4xl">
            Your next opportunity is one message away.
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-[15px] text-white/90">
            Try Scout free and see real people, real contacts, and drafts in your voice
            in under a minute.
          </p>
          <a
            href="/app"
            className="mt-7 inline-block rounded-xl bg-white px-7 py-3.5 text-sm font-bold text-ink shadow-card transition hover:bg-white/90"
          >
            Open Scout
          </a>
        </div>
      </section>

      <Footer />
    </div>
  );
}

const USE_CASES = [
  { who: "Musician / manager", q: "Unsigned bassists in Nashville to join my artist's band" },
  { who: "Health brand", q: "Fitness influencers to promote my new supplement" },
  { who: "Student", q: "Summer internships at companies I admire" },
  { who: "Student", q: "Alumni in my field for a quick coffee chat" },
  { who: "Startup founder", q: "Heads of growth at Series A SaaS companies" },
  { who: "Author", q: "Book bloggers who review thriller novels" },
  { who: "Nonprofit", q: "Local businesses to sponsor our charity 5K" },
  { who: "Photographer", q: "Wedding planners near Austin to partner with" },
  { who: "Podcaster", q: "Personal-finance experts to interview as guests" },
  { who: "Job seeker", q: "Recruiters hiring remote UX designers" },
  { who: "Filmmaker", q: "Cinematographers open to indie short films" },
  { who: "E-commerce", q: "Micro-influencers in sustainable fashion" },
  { who: "Event organizer", q: "Women-in-tech speakers for our conference" },
  { who: "Restaurant owner", q: "Food critics and foodie accounts in Chicago" },
];

function UseCases() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-20">
      <h2 className="text-3xl font-extrabold tracking-tight text-ink">
        Whatever you&apos;re working on,{" "}
        <span className="brand-text">Scout finds your people</span>
      </h2>
      <p className="mt-2 max-w-2xl text-[15px] text-body">
        It is not just for one industry. Here are real things people search for, the
        more specific, the better Scout does. Yours probably fits right in.
      </p>
      <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {USE_CASES.map((u) => (
          <div
            key={u.q}
            className="rounded-2xl border border-warm-border bg-white p-4 shadow-card transition hover:-translate-y-0.5 hover:shadow-soft"
          >
            <div className="text-[11px] font-bold uppercase tracking-wider text-accent">
              {u.who}
            </div>
            <div className="mt-2 flex items-start gap-2.5 rounded-xl bg-warm-bg/60 px-3 py-2.5">
              <SearchIcon />
              <span className="text-sm font-medium leading-snug text-ink">{u.q}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-8">
        <a
          href="/app"
          className="inline-block rounded-xl bg-brand-gradient px-6 py-3.5 text-sm font-bold text-white shadow-soft transition hover:opacity-95"
        >
          Search for yours
        </a>
      </div>
    </section>
  );
}

function SearchIcon() {
  return (
    <svg
      className="mt-0.5 shrink-0"
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#e8566b"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  );
}

function Stat({ big, small }: { big: string; small: string }) {
  return (
    <div className="bg-white px-6 py-7 text-center sm:border-l sm:border-warm-border sm:first:border-l-0">
      <div className="text-xl font-extrabold tracking-tight text-ink">{big}</div>
      <div className="mx-auto mt-1.5 max-w-xs text-xs leading-relaxed text-body">
        {small}
      </div>
    </div>
  );
}

function Feature({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-warm-border bg-white p-5 shadow-card">
      <div className="mb-3 h-9 w-9 rounded-xl bg-brand-gradient" />
      <h3 className="text-[15px] font-bold text-ink">{title}</h3>
      <p className="mt-1.5 text-[13px] leading-relaxed text-body">{body}</p>
    </div>
  );
}

function HowStep({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-warm-border bg-white p-6 shadow-card">
      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-gradient text-base font-extrabold text-white">
        {n}
      </div>
      <h3 className="mt-4 text-[16px] font-bold text-ink">{title}</h3>
      <p className="mt-1.5 text-[13px] leading-relaxed text-body">{body}</p>
    </div>
  );
}

// ------------------- Meet the team -------------------
// Two subsections: the humans (circular headshot cards) and "Our Scouts",
// a horizontal scroller of their dogs. Portrait slots are placeholders —
// swap in <img src="/team/<name>.jpg" /> when real photos land.
const TEAM: { name: string; role: string; blurb: string; photo?: string }[] = [
  {
    name: "Kaitlyn Kasel",
    role: "Founder",
    blurb: "Building the thing she wished existed while running her artist's outreach by hand.",
  },
  {
    name: "Mera Kasel",
    role: "Team",
    blurb: "TBD — add a short line about Mera here.",
  },
  {
    name: "Suri Kasel",
    role: "Team",
    blurb: "TBD — add a short line about Suri here.",
  },
];

// The dogs. Add or remove as the pack grows — the horizontal scroller just
// stretches. Keep names short; the card is compact by design.
const SCOUTS: { name: string; owner?: string; photo?: string }[] = [
  { name: "Scout", owner: "Kaitlyn" },
  { name: "TBD", owner: "Mera" },
  { name: "TBD", owner: "Suri" },
  { name: "TBD" },
  { name: "TBD" },
];

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((p) => p[0] || "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function MeetTheTeam() {
  return (
    <section id="team" className="border-t border-warm-border bg-warm-bg/40">
      <div className="mx-auto max-w-6xl px-6 py-20">
        <div className="max-w-2xl">
          <h2 className="text-3xl font-extrabold tracking-tight text-ink">
            Meet the <span className="brand-text">team</span>
          </h2>
          <p className="mt-2 text-[15px] leading-relaxed text-body">
            The humans building Scout.
          </p>
        </div>
        <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {TEAM.map((m) => (
            <TeamCard key={m.name} {...m} />
          ))}
        </div>

        {/* Our Scouts — horizontal scroller of the dogs. */}
        <div className="mt-16">
          <div className="flex items-baseline justify-between gap-4">
            <div>
              <h3 className="text-2xl font-extrabold tracking-tight text-ink">
                Our <span className="brand-text">scouts</span>
              </h3>
              <p className="mt-1 text-[14px] leading-relaxed text-body">
                The four-legged supervisors. Every commit is dog-approved.
              </p>
            </div>
            <span className="hidden text-[11px] font-bold uppercase tracking-wider text-body/50 sm:block">
              Scroll →
            </span>
          </div>
          <div
            className="mt-5 -mx-6 flex snap-x snap-mandatory gap-4 overflow-x-auto px-6 pb-3"
            style={{ scrollbarWidth: "thin" }}
          >
            {SCOUTS.map((d, i) => (
              <ScoutCard key={`${d.name}-${i}`} {...d} />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function TeamCard({
  name,
  role,
  blurb,
  photo,
}: {
  name: string;
  role: string;
  blurb: string;
  photo?: string;
}) {
  return (
    <div className="flex flex-col rounded-3xl border border-warm-border bg-white p-6 shadow-card transition hover:-translate-y-0.5 hover:shadow-soft">
      {/* Circular headshot slot. Swap the initials fallback for
          <img src={photo} className="..." /> when a real photo lands. */}
      <div className="relative mx-auto mb-4 h-32 w-32 overflow-hidden rounded-full border-4 border-white bg-warm-bg shadow-card ring-1 ring-warm-border">
        {photo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={photo}
            alt={name}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-brand-gradient/15 text-xl font-extrabold tracking-tight text-brown-deep">
            {initials(name)}
          </div>
        )}
      </div>
      <div className="text-center">
        <div className="text-[11px] font-bold uppercase tracking-wider text-accent">
          {role}
        </div>
        <div className="mt-1 text-lg font-extrabold tracking-tight text-ink">
          {name}
        </div>
        <p className="mt-2 text-sm leading-relaxed text-body">{blurb}</p>
      </div>
    </div>
  );
}

function ScoutCard({
  name,
  owner,
  photo,
}: {
  name: string;
  owner?: string;
  photo?: string;
}) {
  return (
    <div className="w-40 shrink-0 snap-start rounded-2xl border border-warm-border bg-white p-3 shadow-card">
      <div className="relative aspect-square w-full overflow-hidden rounded-xl bg-brand-gradient/15">
        {photo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={photo} alt={name} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-brown-deep/70">
            <svg
              viewBox="0 0 120 120"
              width="56"
              height="56"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
              className="opacity-80"
            >
              <path d="M30 55c0-14 13-24 30-24s30 10 30 24v10c0 12-8 22-20 26h-20c-12-4-20-14-20-26z" />
              <path d="M30 45c-8 0-14 6-14 14s5 12 14 12" />
              <path d="M90 45c8 0 14 6 14 14s-5 12-14 12" />
              <circle cx="48" cy="62" r="1.8" fill="currentColor" />
              <circle cx="72" cy="62" r="1.8" fill="currentColor" />
              <path d="M48 80c3 4 8 6 12 6s9-2 12-6" />
              <ellipse cx="60" cy="76" rx="4.5" ry="3" fill="currentColor" />
            </svg>
          </div>
        )}
      </div>
      <div className="mt-2.5 text-center">
        <div className="text-sm font-extrabold tracking-tight text-ink">
          {name}
        </div>
        {owner && (
          <div className="mt-0.5 text-[11px] font-semibold text-body/70">
            {owner}'s
          </div>
        )}
      </div>
    </div>
  );
}
