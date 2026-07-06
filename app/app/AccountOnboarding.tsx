"use client";

import { useEffect, useState } from "react";

type Company = {
  id: string;
  name: string;
  about: string;
  industry: string;
  memberCount: number;
  domainMatch: boolean;
  alreadyMember: boolean;
};

type CompletePatch = {
  accountType: "individual" | "company";
  companyName?: string;
  companyRole?: string;
  companyContribution?: string;
  companyWorkspaceId?: string;
};

// Blocking first-run gate. Shown over everything until the user picks
// individual vs company. Individual accounts fall through to the normal profile
// flow. Company accounts then choose to CREATE a new company (answering "what is
// this company?") or JOIN an existing one from a dropdown (becoming a teammate
// on that company's workspace). You cannot reach Scout until this is done.
export default function AccountOnboarding({
  name,
  onComplete,
  listCompanies,
  createCompany,
  joinCompany,
}: {
  name?: string;
  onComplete: (patch: CompletePatch) => void;
  listCompanies: () => Promise<Company[]>;
  createCompany: (info: {
    name: string;
    about?: string;
    website?: string;
    industry?: string;
    stage?: string;
  }) => Promise<{ id?: string; error?: string }>;
  joinCompany: (workspaceId: string) => Promise<{ name?: string; error?: string }>;
}) {
  const [step, setStep] = useState<
    "choose" | "company-choose" | "company-create" | "company-join"
  >("choose");

  // Shared company fields.
  const [companyRole, setCompanyRole] = useState("");
  const [companyContribution, setCompanyContribution] = useState("");

  // Create-a-company fields.
  const [companyName, setCompanyName] = useState("");
  const [companyAbout, setCompanyAbout] = useState("");
  const [companyWebsite, setCompanyWebsite] = useState("");
  const [companyIndustry, setCompanyIndustry] = useState("");
  const [companyStage, setCompanyStage] = useState("");
  // Reading the company website to auto-fill the questions (optional — plenty of
  // companies have no site, so this is a shortcut, never a requirement).
  const [scanning, setScanning] = useState(false);
  const [scanNote, setScanNote] = useState("");

  async function scanWebsite() {
    const url = companyWebsite.trim();
    if (!url || scanning) return;
    setScanning(true);
    setScanNote("");
    setError("");
    try {
      const res = await fetch("/api/read-company", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setScanNote(data?.error || "Couldn't read that site. Fill it in by hand below.");
        return;
      }
      // Fill only what came back; never clobber something the user already typed.
      if (data.name && !companyName.trim()) setCompanyName(data.name);
      if (data.about && !companyAbout.trim()) setCompanyAbout(data.about);
      if (data.industry && !companyIndustry.trim()) setCompanyIndustry(data.industry);
      setScanNote(
        data.name || data.about || data.industry
          ? "Filled in what Scout could find. Review and edit anything below."
          : "Scout couldn't pull much from that site. Fill it in by hand below."
      );
    } catch {
      setScanNote("Couldn't read that site. Fill it in by hand below.");
    } finally {
      setScanning(false);
    }
  }

  // Join-a-company state.
  const [companies, setCompanies] = useState<Company[] | null>(null);
  const [selectedId, setSelectedId] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Load the company directory when the user chooses "join existing".
  useEffect(() => {
    if (step !== "company-join" || companies !== null) return;
    let alive = true;
    listCompanies().then((list) => {
      if (alive) setCompanies(list);
    });
    return () => {
      alive = false;
    };
  }, [step, companies, listCompanies]);

  const canCreate = companyName.trim() !== "" && companyRole.trim() !== "" && !busy;
  const canJoin = selectedId !== "" && companyRole.trim() !== "" && !busy;

  async function submitCreate() {
    if (!canCreate) return;
    setBusy(true);
    setError("");
    const res = await createCompany({
      name: companyName.trim(),
      about: companyAbout.trim(),
      website: companyWebsite.trim(),
      industry: companyIndustry.trim(),
      stage: companyStage.trim(),
    });
    setBusy(false);
    if (res.error || !res.id) {
      setError(res.error || "Could not create the company.");
      return;
    }
    onComplete({
      accountType: "company",
      companyName: companyName.trim(),
      companyRole: companyRole.trim(),
      companyContribution: companyContribution.trim(),
      companyWorkspaceId: res.id,
    });
  }

  async function submitJoin() {
    if (!canJoin) return;
    setBusy(true);
    setError("");
    const res = await joinCompany(selectedId);
    setBusy(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    const picked = companies?.find((c) => c.id === selectedId);
    onComplete({
      accountType: "company",
      companyName: res.name || picked?.name || "",
      companyRole: companyRole.trim(),
      companyContribution: companyContribution.trim(),
      companyWorkspaceId: selectedId,
    });
  }

  const inputCls =
    "w-full rounded-xl border border-warm-border bg-surface px-3.5 py-3 text-sm text-ink outline-none transition focus:border-brown focus:ring-4 focus:ring-brown/10";
  const labelCls = "mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-body/60";

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-cream/95 p-4 backdrop-blur-sm sm:items-center sm:p-8"
      role="dialog"
      aria-modal="true"
      aria-label="Set up your account"
    >
      <div className="w-full max-w-xl rounded-3xl border border-warm-border bg-surface p-6 shadow-soft sm:p-9">
        {/* ---- Step 1: individual vs company ---- */}
        {step === "choose" && (
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
                onClick={() => setStep("company-choose")}
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
        )}

        {/* ---- Step 2 (company): create new vs join existing ---- */}
        {step === "company-choose" && (
          <>
            <BackBtn onClick={() => setStep("choose")} />
            <p className="mt-4 text-[11px] font-bold uppercase tracking-[0.16em] text-brown">
              Company setup
            </p>
            <h1 className="mt-2 text-2xl font-extrabold tracking-tight text-ink sm:text-3xl">
              Is your company already on Scout?
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-body">
              Join your team if someone&apos;s already set it up, or create it if
              you&apos;re the first one here.
            </p>

            <div className="mt-6 grid gap-3 sm:grid-cols-2">
              <button
                onClick={() => setStep("company-join")}
                className="group rounded-2xl border border-warm-border bg-surface p-5 text-left transition hover:border-brown/50 hover:bg-warm-bg/40"
              >
                <div className="text-base font-bold text-ink">Join an existing company</div>
                <p className="mt-1 text-sm leading-relaxed text-body/80">
                  Pick your company from the list and join your teammates&apos; workspace.
                </p>
                <span className="mt-3 inline-flex items-center gap-1 text-xs font-bold text-brown">
                  Choose from a list
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></svg>
                </span>
              </button>

              <button
                onClick={() => setStep("company-create")}
                className="group rounded-2xl border border-warm-border bg-surface p-5 text-left transition hover:border-brown/50 hover:bg-warm-bg/40"
              >
                <div className="text-base font-bold text-ink">Create a new company</div>
                <p className="mt-1 text-sm leading-relaxed text-body/80">
                  Set up your company on Scout, you&apos;ll answer a few questions about it.
                </p>
                <span className="mt-3 inline-flex items-center gap-1 text-xs font-bold text-brown">
                  Set it up
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></svg>
                </span>
              </button>
            </div>
          </>
        )}

        {/* ---- Step 3a: create a new company ---- */}
        {step === "company-create" && (
          <>
            <BackBtn onClick={() => setStep("company-choose")} />
            <p className="mt-4 text-[11px] font-bold uppercase tracking-[0.16em] text-brown">
              New company
            </p>
            <h1 className="mt-2 text-2xl font-extrabold tracking-tight text-ink sm:text-3xl">
              Tell Scout about your company
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-body">
              This helps Scout understand who you serve and write outreach that
              represents the company well.
            </p>

            <div className="mt-6 space-y-4">
              {/* Shortcut: paste the website and let Scout fill the rest. */}
              <div className="rounded-2xl border border-warm-border bg-warm-bg/40 p-4">
                <label className={labelCls}>Have a website? Let Scout fill this in</label>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    value={companyWebsite}
                    onChange={(e) => {
                      setCompanyWebsite(e.target.value);
                      setScanNote("");
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        scanWebsite();
                      }
                    }}
                    placeholder="e.g. cedarco.com"
                    className={`${inputCls} flex-1`}
                  />
                  <button
                    type="button"
                    onClick={scanWebsite}
                    disabled={!companyWebsite.trim() || scanning}
                    className="shrink-0 rounded-xl bg-brown px-4 py-3 text-sm font-bold text-white shadow-soft transition hover:bg-brown-deep disabled:opacity-40"
                  >
                    {scanning ? "Reading…" : "Read my site"}
                  </button>
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-body/70">
                  {scanNote ||
                    "Scout reads your site to learn what your company does, then fills the questions below. No website? Just fill them in yourself, it's not required."}
                </p>
              </div>

              <div>
                <label className={labelCls}>Company name</label>
                <input
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  placeholder="e.g. Cedar & Co. Studio"
                  className={inputCls}
                />
              </div>
              <div>
                <label className={labelCls}>What does the company do?</label>
                <textarea
                  value={companyAbout}
                  onChange={(e) => setCompanyAbout(e.target.value)}
                  rows={2}
                  placeholder="e.g. An indie A&R and music-publishing firm that develops emerging songwriters."
                  className={`${inputCls} resize-y leading-relaxed`}
                />
              </div>
              <div>
                <label className={labelCls}>Industry (optional)</label>
                <input
                  value={companyIndustry}
                  onChange={(e) => setCompanyIndustry(e.target.value)}
                  placeholder="e.g. Music"
                  className={inputCls}
                />
              </div>
              <div>
                <label className={labelCls}>Company stage</label>
                <select
                  value={companyStage}
                  onChange={(e) => setCompanyStage(e.target.value)}
                  className={`scout-select ${inputCls}`}
                >
                  <option value="">Select a stage…</option>
                  {["Pre-seed", "Startup", "Growth", "Enterprise", "Agency", "Nonprofit", "Small business", "Other"].map(
                    (s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    )
                  )}
                </select>
              </div>

              <div className="border-t border-warm-border pt-4">
                <label className={labelCls}>Your role at the company</label>
                <input
                  value={companyRole}
                  onChange={(e) => setCompanyRole(e.target.value)}
                  placeholder="e.g. Head of Partnerships, Founder, A&R Coordinator"
                  className={inputCls}
                />
              </div>
              <div>
                <label className={labelCls}>How you serve the company&apos;s work</label>
                <textarea
                  value={companyContribution}
                  onChange={(e) => setCompanyContribution(e.target.value)}
                  rows={2}
                  placeholder="What you own and drive on the company's projects."
                  className={`${inputCls} resize-y leading-relaxed`}
                />
              </div>
            </div>

            {error && <p className="mt-3 text-xs font-medium text-attention">{error}</p>}

            <button
              onClick={submitCreate}
              disabled={!canCreate}
              className="mt-6 w-full rounded-xl bg-brand-gradient px-6 py-3.5 text-sm font-bold text-white shadow-soft transition hover:opacity-95 disabled:opacity-40"
            >
              {busy ? "Creating…" : "Create company & enter Scout"}
            </button>
          </>
        )}

        {/* ---- Step 3b: join an existing company ---- */}
        {step === "company-join" && (
          <>
            <BackBtn onClick={() => setStep("company-choose")} />
            <p className="mt-4 text-[11px] font-bold uppercase tracking-[0.16em] text-brown">
              Join a company
            </p>
            <h1 className="mt-2 text-2xl font-extrabold tracking-tight text-ink sm:text-3xl">
              Which company are you with?
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-body">
              Pick your company to join your teammates. You&apos;ll be able to see
              its projects and choose which ones you&apos;re on.
            </p>

            <div className="mt-6 space-y-4">
              <div>
                <label className={labelCls}>Company</label>
                {companies === null ? (
                  <div className="rounded-xl border border-warm-border bg-warm-bg/40 px-3.5 py-3 text-sm text-body/60">
                    Loading companies…
                  </div>
                ) : companies.length === 0 ? (
                  <div className="rounded-xl border border-warm-border bg-warm-bg/40 px-3.5 py-3 text-sm text-body">
                    No companies on Scout yet.{" "}
                    <button
                      onClick={() => setStep("company-create")}
                      className="font-bold text-brown underline"
                    >
                      Create yours
                    </button>
                    .
                  </div>
                ) : (
                  <select
                    value={selectedId}
                    onChange={(e) => setSelectedId(e.target.value)}
                    className={inputCls}
                  >
                    <option value="">Select your company…</option>
                    {companies.map((c) => (
                      <option key={c.id} value={c.id} disabled={c.alreadyMember}>
                        {c.name}
                        {c.industry ? `, ${c.industry}` : ""}
                        {` (${c.memberCount} ${c.memberCount === 1 ? "member" : "members"})`}
                        {c.domainMatch ? " • matches your email" : ""}
                        {c.alreadyMember ? " • already joined" : ""}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              {selectedId && (
                <>
                  <div>
                    <label className={labelCls}>Your role at the company</label>
                    <input
                      value={companyRole}
                      onChange={(e) => setCompanyRole(e.target.value)}
                      placeholder="e.g. Partnerships Associate, A&R Coordinator"
                      className={inputCls}
                    />
                  </div>
                  <div>
                    <label className={labelCls}>How you serve the company&apos;s work</label>
                    <textarea
                      value={companyContribution}
                      onChange={(e) => setCompanyContribution(e.target.value)}
                      rows={2}
                      placeholder="What you own and drive on the company's projects."
                      className={`${inputCls} resize-y leading-relaxed`}
                    />
                  </div>
                </>
              )}
            </div>

            {error && <p className="mt-3 text-xs font-medium text-attention">{error}</p>}

            <button
              onClick={submitJoin}
              disabled={!canJoin}
              className="mt-6 w-full rounded-xl bg-brand-gradient px-6 py-3.5 text-sm font-bold text-white shadow-soft transition hover:opacity-95 disabled:opacity-40"
            >
              {busy ? "Joining…" : "Join company & enter Scout"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function BackBtn({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-1.5 text-xs font-semibold text-body/60 transition hover:text-ink"
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5" /><path d="m11 18-6-6 6-6" /></svg>
      Back
    </button>
  );
}
