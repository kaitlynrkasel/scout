import { Nav, Footer } from "../site";

export const metadata = {
  title: "Scout, Proof it works",
  description:
    "The data behind Scout: the search funnel, response-rate benchmarks, and real sample output.",
};

export default function Analytics() {
  return (
    <div className="min-h-screen">
      <Nav />

      {/* Hero */}
      <section className="bg-warm-fade">
        <div className="mx-auto max-w-6xl px-6 pb-10 pt-14">
          <span className="inline-block rounded-full border border-warm-border bg-surface px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-accent shadow-card">
            The proof
          </span>
          <h1 className="mt-4 max-w-3xl text-4xl font-extrabold leading-[1.1] tracking-tight text-ink sm:text-5xl">
            Does it actually work?{" "}
            <span className="brand-text">Here is the evidence.</span>
          </h1>
          <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-body">
            Cold outreach usually fails because it is generic and sent at scale. Scout
            does the opposite: a short list of the right people, real contact info, and
            a personal message for each. Here is what that looks like, and why it works.
          </p>
        </div>
      </section>

      <main className="mx-auto max-w-6xl px-6 pb-20">
        {/* The funnel */}
        <Section
          eyebrow="What one search does"
          title="From a sentence to ready-to-send messages"
          sub="A typical Scout run, start to finish, in about a minute."
        >
          <div className="grid gap-3 sm:grid-cols-5">
            <FunnelStep n="~6" label="searches" hint="across the public web" w="100%" />
            <FunnelStep n="~40" label="pages read" hint="and understood" w="84%" />
            <FunnelStep n="~10" label="strong matches" hint="scored for fit" w="62%" />
            <FunnelStep n="real" label="contacts found" hint="emails & handles" w="46%" />
            <FunnelStep n="1 min" label="drafts ready" hint="in your voice" w="34%" highlight />
          </div>
          <p className="mt-4 text-xs text-body/70">
            Typical numbers from a single search. The same work by hand, finding people,
            digging up emails, and writing each message, usually takes a couple of hours.
          </p>
        </Section>

        {/* Benchmarks */}
        <Section
          eyebrow="Why personalization wins"
          title="Targeted, personal outreach gets far more replies"
          sub="Reply rates for cold outreach, by approach. Scout writes the personalized kind."
        >
          <div className="space-y-5">
            <Bar label="Generic mass cold email" value={2} display="~1-3%" tone="muted" />
            <Bar label="Cold email with a name dropped in" value={6} display="~5-8%" tone="muted" />
            <Bar
              label="Targeted + personalized (the kind Scout writes)"
              value={20}
              display="~12-25%"
              tone="brand"
            />
            <Bar
              label="Warm intro / coffee-chat ask"
              value={28}
              display="~25-30%"
              tone="brand"
            />
          </div>
          <p className="mt-5 text-xs text-body/70">
            Bars are scaled to a 30% axis. Figures are general industry estimates for
            small-scale, targeted outreach (not paid placements). Real results vary with
            list quality, timing, and follow-up, the things Scout is built to get right.
          </p>
        </Section>

        {/* Sample output */}
        <Section
          eyebrow="See the quality"
          title="Illustrative example: find people, then draft for them"
          sub="A sample of the kind of output Scout produces — an illustrative contact and draft, not a real person."
        >
          <div className="grid gap-5 lg:grid-cols-2">
            {/* Finds */}
            <div className="rounded-2xl border border-warm-border bg-surface p-5 shadow-card">
              <div className="mb-3 text-xs font-bold uppercase tracking-wider text-body/60">
                What Scout finds (sample)
              </div>
              <div className="space-y-3">
                <FindCard
                  name="Maria Chen"
                  meta="Head of Partnerships · Brooklyn, NY"
                  contact="maria@example.com"
                  why="Just launched two collaborations with sustainability brands."
                  fit={92}
                  channel="Email"
                />
                <FindCard
                  name="Jordan Lee"
                  meta="Growth Marketing Lead · Remote"
                  contact="@jordanlee_growth"
                  why="Posts about DTC launches and creator partnerships."
                  fit={74}
                  channel="LinkedIn"
                />
              </div>
            </div>

            {/* Draft */}
            <div className="rounded-2xl border border-warm-border bg-surface p-5 shadow-card">
              <div className="mb-3 text-xs font-bold uppercase tracking-wider text-body/60">
                A draft, in your voice
              </div>
              <div className="relative ml-auto rounded-2xl rounded-tr-md border border-warm-border bg-warm-bg/50 p-4">
                <div className="mb-2 flex items-center gap-2">
                  <span className="rounded-full bg-brand-gradient px-2.5 py-0.5 text-[11px] font-semibold text-white">
                    email
                  </span>
                  <span className="text-xs text-body/70">→ maria@example.com</span>
                </div>
                <div className="border-b border-warm-border pb-2 text-sm font-semibold text-ink">
                  Loved your recent collabs, quick hello
                </div>
                <p className="mt-2.5 whitespace-pre-line text-sm leading-relaxed text-body">
                  {`Hi Maria,

I came across your partnerships work and the two sustainability collaborations you just launched, both feel really considered and on-brand. As someone building in growth marketing, I really admire how you pick partners.

I would love to grab a quick coffee or call sometime to hear how you approach finding new brands to work with. No agenda, just genuinely inspired by what you do.

Thanks so much, and congrats again on the launches!`}
                </p>
              </div>
            </div>
          </div>
        </Section>

        {/* Time saved */}
        <Section
          eyebrow="The time math"
          title="Hours of work, done in a minute"
          sub="What outreach takes by hand vs. with Scout."
        >
          <div className="grid gap-5 sm:grid-cols-2">
            <div className="rounded-2xl border border-warm-border bg-surface p-6 shadow-card">
              <div className="text-xs font-bold uppercase tracking-wider text-body/60">
                By hand
              </div>
              <ul className="mt-3 space-y-2 text-sm text-body">
                <li>Find the right people, 30+ min</li>
                <li>Dig up emails &amp; handles, 30+ min</li>
                <li>Research each one, 5 min each</li>
                <li>Write each message, 10 min each</li>
              </ul>
              <div className="mt-4 text-2xl font-extrabold text-ink">~2 hours</div>
            </div>
            <div className="rounded-2xl border border-coral/30 bg-warm-bg/40 p-6 shadow-card">
              <div className="text-xs font-bold uppercase tracking-wider text-accent">
                With Scout
              </div>
              <ul className="mt-3 space-y-2 text-sm text-body">
                <li>Describe who you want, 20 sec</li>
                <li>Scout finds &amp; researches, automatic</li>
                <li>Drafts written in your voice, automatic</li>
                <li>Review and send, a few min</li>
              </ul>
              <div className="mt-4 text-2xl font-extrabold brand-text">~1 minute</div>
            </div>
          </div>
        </Section>

        {/* How Scout learns */}
        <Section
          eyebrow="It gets better as you use it"
          title="How Scout learns"
          sub="Two loops make every search sharper, one just for you, one for everyone."
        >
          <div className="grid gap-5 sm:grid-cols-2">
            <div className="rounded-2xl border border-warm-border bg-surface p-6 shadow-card">
              <div className="mb-3 flex items-center gap-2">
                <span className="h-8 w-8 rounded-xl bg-brand-gradient" />
                <span className="text-xs font-bold uppercase tracking-wider text-accent">
                  Learns you
                </span>
              </div>
              <h3 className="text-[16px] font-bold text-ink">Private to your account</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-body">
                The more you use Scout, the more it fits you. Your Profile, the searches
                you keep, the people you reach out to, and the edits you make to drafts
                all teach it your taste and your voice, so your next results and messages
                land closer to what you want. This stays private to your account.
              </p>
            </div>
            <div className="rounded-2xl border border-warm-border bg-surface p-6 shadow-card">
              <div className="mb-3 flex items-center gap-2">
                <span className="h-8 w-8 rounded-xl bg-brand-gradient" />
                <span className="text-xs font-bold uppercase tracking-wider text-accent">
                  Learns from everyone
                </span>
              </div>
              <h3 className="text-[16px] font-bold text-ink">Smarter for the whole community</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-body">
                Across everyone using Scout, broad patterns, which kinds of outreach get
                replies, which sources have real contacts, what a great message looks
                like, make the engine better for all. It is aggregate and anonymous:
                shared patterns, never your private profile or contacts.
              </p>
            </div>
          </div>
          <p className="mt-4 text-xs text-body/70">
            These learning loops are part of how Scout is built. As the community grows,
            live numbers will appear here, real reply rates and improvements over time,
            rather than estimates.
          </p>
        </Section>

        {/* Honesty note + CTA */}
        <div className="mt-14 rounded-2xl border border-warm-border bg-surface p-6 text-center shadow-card">
          <p className="mx-auto max-w-2xl text-sm leading-relaxed text-body">
            Scout is new, so the figures above are the search funnel and well-established
            industry benchmarks, not inflated user counts. The best proof is trying it:
            run a real search and judge the people and drafts yourself.
          </p>
          <a
            href="/app"
            className="mt-5 inline-block rounded-xl bg-brand-gradient px-7 py-3.5 text-sm font-bold text-white shadow-soft transition hover:opacity-95"
          >
            Try it yourself, free
          </a>
        </div>
      </main>

      <Footer />
    </div>
  );
}

function Section({
  eyebrow,
  title,
  sub,
  children,
}: {
  eyebrow: string;
  title: string;
  sub: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-14 first:mt-10">
      <div className="mb-6">
        <div className="text-xs font-bold uppercase tracking-wider text-accent">
          {eyebrow}
        </div>
        <h2 className="mt-1.5 text-2xl font-extrabold tracking-tight text-ink">
          {title}
        </h2>
        <p className="mt-1 text-sm text-body">{sub}</p>
      </div>
      {children}
    </section>
  );
}

function FunnelStep({
  n,
  label,
  hint,
  w,
  highlight = false,
}: {
  n: string;
  label: string;
  hint: string;
  w: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={`rounded-2xl border p-4 ${
        highlight
          ? "border-coral/40 bg-warm-bg/50"
          : "border-warm-border bg-surface"
      } shadow-card`}
    >
      <div className={`text-xl font-extrabold ${highlight ? "brand-text" : "text-ink"}`}>
        {n}
      </div>
      <div className="text-xs font-semibold text-ink">{label}</div>
      <div className="mt-0.5 text-[11px] text-body/70">{hint}</div>
      <div className="mt-3 h-1.5 w-full rounded-full bg-warm-bg">
        <div
          className="h-1.5 rounded-full bg-brand-gradient"
          style={{ width: w }}
        />
      </div>
    </div>
  );
}

function Bar({
  label,
  value,
  display,
  tone,
}: {
  label: string;
  value: number;
  display: string;
  tone: "brand" | "muted";
}) {
  const pct = Math.min(100, (value / 30) * 100);
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-sm font-semibold text-ink">{label}</span>
        <span className="text-sm font-bold text-body">{display}</span>
      </div>
      <div className="h-3.5 w-full overflow-hidden rounded-full bg-warm-bg">
        <div
          className={`h-3.5 rounded-full ${
            tone === "brand" ? "bg-brand-gradient" : "bg-body/30"
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function FindCard({
  name,
  meta,
  contact,
  why,
  fit,
  channel,
}: {
  name: string;
  meta: string;
  contact: string;
  why: string;
  fit: number;
  channel: string;
}) {
  return (
    <div className="rounded-xl border border-warm-border bg-surface p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-ink">{name}</span>
        <span className="rounded-full bg-brand-gradient px-2 py-0.5 text-[10px] font-bold text-white">
          {fit}% fit
        </span>
        <span className="rounded-full border border-warm-border bg-warm-bg px-2 py-0.5 text-[10px] font-medium text-body">
          {channel}
        </span>
      </div>
      <div className="mt-0.5 text-xs text-body/80">{meta}</div>
      <div className="mt-1 text-xs font-semibold text-accent">{contact}</div>
      <div className="mt-1 text-xs leading-relaxed text-body">{why}</div>
    </div>
  );
}
