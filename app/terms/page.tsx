import { Nav, Footer } from "../site";

export const metadata = {
  title: "Scout · Terms of Service",
  description:
    "The terms that govern your use of Scout, including acceptable use, outreach responsibilities, billing, and disclaimers.",
};

// Plain-English terms matching how Scout works today. A starting point — have it
// reviewed by a qualified adviser before relying on it, and keep the effective
// date current.
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

export default function Terms() {
  return (
    <div className="min-h-screen">
      <Nav />
      <main className="mx-auto max-w-3xl px-6 pb-20 pt-12">
        <span className="inline-block rounded-full border border-warm-border bg-surface px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-accent shadow-card">
          Terms
        </span>
        <h1 className="mt-4 text-4xl font-extrabold tracking-tight text-ink">Terms of Service</h1>
        <p className="mt-3 text-sm text-body/70">Effective {EFFECTIVE}</p>

        <P>
          These terms govern your use of Scout (&ldquo;Scout&rdquo;, &ldquo;we&rdquo;,
          &ldquo;us&rdquo;), the website at scout-source.com, and the Scout web app. By
          creating an account or using Scout, you agree to these terms. If you do not
          agree, do not use Scout.
        </P>

        <H>The service</H>
        <P>
          Scout helps you find relevant people and opportunities from publicly available
          information and drafts personalized outreach in your voice. Scout is a tool: you
          decide who to contact and what to send, and you send from your own connected
          mailbox.
        </P>

        <H>Your account</H>
        <P>
          You must provide accurate information and keep your login secure. You are
          responsible for activity under your account. One person may not create multiple
          accounts to evade limits.
        </P>

        <H>Acceptable use &amp; lawful outreach</H>
        <P>
          You are solely responsible for the messages you send and for complying with the
          laws that apply to your outreach. In particular, you agree that you will:
        </P>
        <ul className="mt-3 list-disc space-y-2 pl-5">
          <LI>Only contact people for legitimate, relevant purposes, and honor any request to stop.</LI>
          <LI>
            Comply with anti-spam and privacy laws that apply to you and your recipients
            (for example, GDPR/PECR in the UK/EU and CAN-SPAM in the US), including
            providing a genuine way to opt out and identifying yourself.
          </LI>
          <LI>Not use Scout to harass, deceive, impersonate, or send unlawful, bulk, or misleading messages.</LI>
          <LI>Not scrape, resell, or misuse contact data in violation of applicable law or third-party terms.</LI>
        </ul>
        <P>
          We may suspend or terminate accounts that misuse Scout. Scout adds a standard
          unsubscribe header to outreach emails and honors opt-outs it can detect, but this
          does not remove your own legal responsibility as the sender.
        </P>

        <H>Third-party services</H>
        <P>
          Scout connects to services like Google (Gmail), Microsoft (Outlook), and Stripe.
          Your use of those services is subject to their own terms, and their availability
          is outside our control.
        </P>

        <H>Billing, renewal, and cancellation</H>
        <ul className="mt-3 list-disc space-y-2 pl-5">
          <LI>Scout offers a free tier with a monthly search allowance and paid plans billed through Stripe.</LI>
          <LI>Paid plans renew automatically each month until you cancel.</LI>
          <LI>You can cancel anytime; you keep access to your plan&rsquo;s searches until the end of the current period.</LI>
          <LI>Except where required by law, payments are non-refundable.</LI>
        </ul>

        <H>AI-generated content &amp; results</H>
        <P>
          Scout uses automated search and AI to find people and draft messages. Results and
          drafts may contain inaccuracies and are provided as a starting point — you should
          review contact details and message content before you rely on or send them. We do
          not guarantee any particular reply rate, outcome, or that every surfaced contact
          is accurate. Any figures or examples on our marketing pages are illustrative or
          general estimates, not promises of results.
        </P>

        <H>Your content</H>
        <P>
          You keep ownership of the content you provide (your profile, templates, and
          messages). You grant us the limited license needed to operate the service for you.
          We handle your data as described in our{" "}
          <a href="/privacy" className="font-semibold text-accent hover:underline">
            Privacy Policy
          </a>
          .
        </P>

        <H>Disclaimers</H>
        <P>
          Scout is provided &ldquo;as is&rdquo; without warranties of any kind, to the
          fullest extent permitted by law. We do not warrant that the service will be
          uninterrupted, error-free, or that results will meet your expectations.
        </P>

        <H>Limitation of liability</H>
        <P>
          To the fullest extent permitted by law, Scout will not be liable for indirect,
          incidental, or consequential damages, or for lost profits or data. Nothing in
          these terms limits liability that cannot be limited by law.
        </P>

        <H>Indemnity</H>
        <P>
          You agree to indemnify us against claims arising from your use of Scout in breach
          of these terms or applicable law, including claims related to messages you send.
        </P>

        <H>Termination</H>
        <P>
          You can stop using Scout and delete your account at any time. We may suspend or
          end access for breach of these terms or to protect the service.
        </P>

        <H>Changes &amp; governing law</H>
        <P>
          We may update these terms; material changes will be reflected in the effective
          date above. These terms are governed by the laws of England and Wales, and you
          agree to the exclusive jurisdiction of its courts, except where your local law
          gives you additional rights.
        </P>

        <H>Contact</H>
        <P>
          Questions: <b>hello@scout-source.com</b>.
        </P>
      </main>
      <Footer />
    </div>
  );
}
