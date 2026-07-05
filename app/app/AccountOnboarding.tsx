"use client";

import { useState } from "react";

// Blocking first-run gate. Shown over everything until the user picks
// individual vs company (and, for company, answers the company-shaped
// questions). There is no close/skip — you cannot reach the Scout system
// until this is done. Individual accounts fall through to the normal
// "tell Scout who you are" profile flow; company accounts capture their role
// and how they serve the company's work here, up front. The Teams/workspace
// project picker is layered on in a later step.
export default function AccountOnboarding({
  name,
  onComplete,
}: {
  name?: string;
  onComplete: (patch: {
    accountType: "individual" | "company";
    companyName?: string;
    companyRole?: string;
    companyContribution?: string;
  }) => void;
}) {
  const [step, setStep] = useState<"choose" | "company">("choose");
  const [companyName, setCompanyName] = useState("");
  const [companyRole, setCompanyRole] = useState("");
  const [companyContribution, setCompanyContribution] = useState("");

  const canFinishCompany = companyName.trim() !== "" && companyRole.trim() !== "";

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-cream/95 p-4 backdrop-blur-sm sm:items-center sm:p-8"
      role="dialog"
      aria-modal="true"
      aria-label="Set up your account"
    >
      <div className="w-full max-w-xl rounded-3xl border border-warm-border bg-surface p-6 shadow-soft sm:p-9">
        {step === "choose" ? (
          <>
            <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-brown">
              Welcome to Scout
            </p>
            <h1 className="mt-3 text-2xl font-extrabold tracking-tight text-ink sm:text-3xl">
              {name ? `Hi ${name}. ` : ""}Who are you setting up Scout for?
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-body">
              This shapes the questions Scout asks and how it writes for you. You
              can&apos;t change it later, so pick the one that fits.
            </p>

            <div className="mt-6 grid gap-3 sm:grid-cols-2">
              <button
                onClick={() => onComplete({ accountType: "individual" })}
                className="group rounded-2xl border border-warm-border bg-surface p-5 text-left transition hover:border-brown/50 hover:bg-warm-bg/40"
              >
                <span className="grid h-11 w-11 place-items-center rounded-xl bg-brown-tint text-brown-deep">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="3.5" /><path d="M5 20a7 7 0 0 1 14 0" /></svg>
                </span>
                <div className="mt-3 text-base font-bold text-ink">I&apos;m an individual</div>
                <p className="mt-1 text-sm leading-relaxed text-body/80">
                  Reaching out for yourself, your job search, your art, your network.
                </p>
                <span className="mt-3 inline-flex items-center gap-1 text-xs font-bold text-brown">
                  Continue
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></svg>
                </span>
              </button>

              <button
                onClick={() => setStep("company")}
                className="group rounded-2xl border border-warm-border bg-surface p-5 text-left transition hover:border-brown/50 hover:bg-warm-bg/40"
              >
                <span className="grid h-11 w-11 place-items-center rounded-xl bg-brown-tint text-brown-deep">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 21h18" /><path d="M5 21V7l7-4 7 4v14" /><path d="M9 21v-5h6v5" /><path d="M9 10h.01M15 10h.01M9 13h.01M15 13h.01" /></svg>
                </span>
                <div className="mt-3 text-base font-bold text-ink">I&apos;m with a company</div>
                <p className="mt-1 text-sm leading-relaxed text-body/80">
                  Reaching out on behalf of a company, brand, or team you&apos;re part of.
                </p>
                <span className="mt-3 inline-flex items-center gap-1 text-xs font-bold text-brown">
                  Continue
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></svg>
                </span>
              </button>
            </div>
          </>
        ) : (
          <>
            <button
              onClick={() => setStep("choose")}
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-body/60 transition hover:text-ink"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5" /><path d="m11 18-6-6 6-6" /></svg>
              Back
            </button>
            <p className="mt-4 text-[11px] font-bold uppercase tracking-[0.16em] text-brown">
              Company setup
            </p>
            <h1 className="mt-2 text-2xl font-extrabold tracking-tight text-ink sm:text-3xl">
              Tell Scout about your company and your role
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-body">
              Since you&apos;re reaching out for a company, Scout leans on what the
              company does and how you serve it, not a personal resume.
            </p>

            <div className="mt-6 space-y-4">
              <div>
                <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-body/60">
                  Company name
                </label>
                <input
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  placeholder="e.g. Cedar & Co. Studio"
                  className="w-full rounded-xl border border-warm-border bg-surface px-3.5 py-3 text-sm text-ink outline-none transition focus:border-brown focus:ring-4 focus:ring-brown/10"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-body/60">
                  Your role at the company
                </label>
                <input
                  value={companyRole}
                  onChange={(e) => setCompanyRole(e.target.value)}
                  placeholder="e.g. Head of Partnerships, Founder, A&R Coordinator"
                  className="w-full rounded-xl border border-warm-border bg-surface px-3.5 py-3 text-sm text-ink outline-none transition focus:border-brown focus:ring-4 focus:ring-brown/10"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-body/60">
                  How you serve the company&apos;s work
                </label>
                <textarea
                  value={companyContribution}
                  onChange={(e) => setCompanyContribution(e.target.value)}
                  rows={3}
                  placeholder="What you own and drive on the company's projects, e.g. 'I run outbound partnerships and pitch our product to prospective retail accounts.'"
                  className="w-full resize-y rounded-xl border border-warm-border bg-surface px-3.5 py-3 text-sm leading-relaxed text-ink outline-none transition focus:border-brown focus:ring-4 focus:ring-brown/10"
                />
                <p className="mt-1.5 text-xs text-body/60">
                  After this, you&apos;ll be able to pick which of your company&apos;s
                  projects you&apos;re part of.
                </p>
              </div>
            </div>

            <button
              onClick={() =>
                onComplete({
                  accountType: "company",
                  companyName: companyName.trim(),
                  companyRole: companyRole.trim(),
                  companyContribution: companyContribution.trim(),
                })
              }
              disabled={!canFinishCompany}
              className="mt-6 w-full rounded-xl bg-brand-gradient px-6 py-3.5 text-sm font-bold text-white shadow-soft transition hover:opacity-95 disabled:opacity-40"
            >
              Enter Scout
            </button>
          </>
        )}
      </div>
    </div>
  );
}
