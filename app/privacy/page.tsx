import { Nav, Footer } from "../site";

export const metadata = {
  title: "Scout · Privacy Policy",
  description:
    "How Scout collects, uses, and protects personal data — including account data, Gmail/Outlook access, and contact information surfaced from the public web.",
};

// Plain-English privacy notice covering the app's actual data practices. This is
// a starting point written to match what Scout does today; have it reviewed by a
// qualified adviser before relying on it, and update the effective date whenever
// practices change.
const EFFECTIVE = "13 July 2026";

function H({ children }: { children: React.ReactNode }) {
  return <h2 className="mt-10 text-xl font-bold tracking-tight text-ink">{children}</h2>;
}
function P({ children }: { children: React.ReactNode }) {
  return <p className="mt-3 text-[15px] leading-relaxed text-body">{children}</p>;
}
function LI({ children }: { children: React.ReactNode }) {
  return <li className="text-[15px] leading-relaxed text-body">{children}</li>;
}

export default function Privacy() {
  return (
    <div className="min-h-screen">
      <Nav />
      <main className="mx-auto max-w-3xl px-6 pb-20 pt-12">
        <span className="inline-block rounded-full border border-warm-border bg-surface px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-accent shadow-card">
          Privacy
        </span>
        <h1 className="mt-4 text-4xl font-extrabold tracking-tight text-ink">Privacy Policy</h1>
        <p className="mt-3 text-sm text-body/70">Effective {EFFECTIVE}</p>

        <P>
          This policy explains what personal data Scout (&ldquo;Scout&rdquo;,
          &ldquo;we&rdquo;, &ldquo;us&rdquo;) collects, why, and the choices you have. It
          covers the Scout website at scout-source.com and the Scout web app. If you have
          any questions, email <b>hello@scout-source.com</b>.
        </P>

        <H>Who we are</H>
        <P>
          Scout is an outreach assistant that helps you find relevant people and
          opportunities and draft personalized messages in your own voice. For data-
          protection purposes, Scout is the controller of the personal data described
          here. Contact us at hello@scout-source.com.
        </P>

        <H>Data we collect</H>
        <ul className="mt-3 list-disc space-y-2 pl-5">
          <LI>
            <b>Account data</b> — your name, email address, and password, handled by our
            authentication provider (Supabase). We never see your raw password.
          </LI>
          <LI>
            <b>Profile you provide</b> — your bio, r&eacute;sum&eacute;, use case, LinkedIn,
            writing samples/templates, and project context you add to personalize drafts.
          </LI>
          <LI>
            <b>Outreach content</b> — the searches you run, the people and opportunities you
            save, notes, statuses, and the messages you draft and send.
          </LI>
          <LI>
            <b>Mailbox access</b> — if you connect Gmail or Outlook, we store an OAuth token
            so Scout can create drafts or send from your address and detect replies in
            those threads. We access message metadata (headers) to track replies; we do
            not read unrelated mail.
          </LI>
          <LI>
            <b>Contact information about other people</b> — when you search, Scout surfaces
            names, roles, and public contact details it finds on the open web about
            potential recipients. See &ldquo;Data about third parties&rdquo; below.
          </LI>
          <LI>
            <b>Usage and billing</b> — basic activity (e.g. counts of searches and drafts)
            and, if you subscribe, billing status via Stripe. We do not store your card
            details; Stripe processes payments.
          </LI>
        </ul>

        <H>How we use your data</H>
        <ul className="mt-3 list-disc space-y-2 pl-5">
          <LI>To provide the service: run searches, surface matches, and draft messages.</LI>
          <LI>To personalize drafts so they sound like you, using the profile you provide.</LI>
          <LI>To send or draft email on your behalf through your connected mailbox.</LI>
          <LI>
            To improve Scout using <b>aggregate, anonymized</b> patterns (for example, which
            kinds of matches people tend to act on). This never exposes your r&eacute;sum&eacute;,
            templates, contacts, or messages to other users.
          </LI>
          <LI>To operate billing, prevent abuse, and meet legal obligations.</LI>
        </ul>

        <H>Data about third parties</H>
        <P>
          Scout surfaces contact information about people from publicly available sources
          so you can reach out. Where we process this without collecting it directly from
          the person, our lawful basis is our and your legitimate interest in relevant B2B
          and professional outreach, balanced against those individuals&rsquo; rights. Any
          person can ask us to stop processing their information or to be removed by
          emailing hello@scout-source.com, and every outreach email includes a way to opt
          out. You are responsible for contacting people lawfully (see our Terms).
        </P>

        <H>Who we share data with</H>
        <P>
          We do not sell your personal data. We share it only with service providers that
          help us run Scout, under contract and only as needed:
        </P>
        <ul className="mt-3 list-disc space-y-2 pl-5">
          <LI>Supabase — authentication and database hosting.</LI>
          <LI>Google / Microsoft — when you connect Gmail or Outlook to send or draft mail.</LI>
          <LI>Stripe — subscription billing.</LI>
          <LI>Search and AI providers (e.g. web search and the model that drafts your messages) — to find people and generate drafts. Only the content needed for the request is sent.</LI>
        </ul>

        <H>International transfers</H>
        <P>
          Some providers process data outside your country. Where required, we rely on
          appropriate safeguards (such as standard contractual clauses) for those
          transfers.
        </P>

        <H>Retention</H>
        <P>
          We keep your account and content for as long as your account is active. You can
          delete finds, projects, and templates in the app, disconnect your mailbox at any
          time, and ask us to delete your account and associated data by emailing
          hello@scout-source.com.
        </P>

        <H>Your rights</H>
        <P>
          Depending on where you live (including under UK/EU GDPR), you may have the right
          to access, correct, delete, or export your data, to object to or restrict certain
          processing, and to withdraw consent. To exercise any of these, email
          hello@scout-source.com. You also have the right to complain to your local data-
          protection authority (in the UK, the ICO).
        </P>

        <H>Cookies and local storage</H>
        <P>
          Scout uses your browser&rsquo;s local storage to keep you signed in and to remember
          your settings and drafts. We do not use third-party advertising cookies.
        </P>

        <H>Security</H>
        <P>
          We use industry-standard measures to protect your data, including encryption in
          transit and access controls. No system is perfectly secure, but we work to keep
          your information safe.
        </P>

        <H>Children</H>
        <P>Scout is not directed to children under 16, and we do not knowingly collect their data.</P>

        <H>Changes</H>
        <P>
          We may update this policy. When we make material changes, we will update the
          effective date above and, where appropriate, notify you in the app.
        </P>

        <H>Contact</H>
        <P>
          Questions or requests: <b>hello@scout-source.com</b>. See also our{" "}
          <a href="/terms" className="font-semibold text-accent hover:underline">
            Terms of Service
          </a>
          .
        </P>
      </main>
      <Footer />
    </div>
  );
}
