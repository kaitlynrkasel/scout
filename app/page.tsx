"use client";

import { useEffect, useState } from "react";
import { TEMPLATE_LIST, TEMPLATES } from "@/lib/templates";
import type { Draft, Opportunity, OutreachTemplate, TemplateKey } from "@/lib/types";

const OUTREACH_KINDS = [
  "Email",
  "LinkedIn message",
  "Instagram DM",
  "TikTok DM",
  "X / Twitter DM",
  "Text message",
  "Cover letter",
  "Other",
];
const TPL_KEY = "cue_templates";
const PROFILE_KEY = "cue_profile";
const CAT_KEY = "cue_categories";

interface Profile {
  name: string;
  bio: string;
}
interface Category {
  id: string;
  name: string;
  useCase: TemplateKey;
  goal: string;
}

export default function Home() {
  const [tab, setTab] = useState<"outreach" | "templates" | "profile">("outreach");

  // ---- Outreach state ----
  const [useCase, setUseCase] = useState<TemplateKey>("networking");
  const [goal, setGoal] = useState(TEMPLATES.networking.exampleGoal);
  const [discovering, setDiscovering] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState("");
  const [opps, setOpps] = useState<Opportunity[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [stats, setStats] = useState("");
  const [expanded, setExpanded] = useState(false);

  // ---- Persisted state ----
  const [myTemplates, setMyTemplates] = useState<OutreachTemplate[]>([]);
  const [mtChannel, setMtChannel] = useState(OUTREACH_KINDS[0]);
  const [mtText, setMtText] = useState("");
  const [profile, setProfile] = useState<Profile>({ name: "", bio: "" });
  const [categories, setCategories] = useState<Category[]>([]);

  useEffect(() => {
    try {
      const t = localStorage.getItem(TPL_KEY);
      if (t) setMyTemplates(JSON.parse(t));
      const p = localStorage.getItem(PROFILE_KEY);
      if (p) setProfile(JSON.parse(p));
      const c = localStorage.getItem(CAT_KEY);
      if (c) setCategories(JSON.parse(c));
    } catch {}
  }, []);

  function persistTemplates(next: OutreachTemplate[]) {
    setMyTemplates(next);
    try {
      localStorage.setItem(TPL_KEY, JSON.stringify(next));
    } catch {}
  }
  function persistProfile(next: Profile) {
    setProfile(next);
    try {
      localStorage.setItem(PROFILE_KEY, JSON.stringify(next));
    } catch {}
  }
  function persistCategories(next: Category[]) {
    setCategories(next);
    try {
      localStorage.setItem(CAT_KEY, JSON.stringify(next));
    } catch {}
  }

  function addTemplate() {
    if (!mtText.trim()) return;
    persistTemplates([
      { id: `${Date.now()}`, channel: mtChannel, text: mtText.trim() },
      ...myTemplates,
    ]);
    setMtText("");
  }
  function removeTemplate(id: string) {
    persistTemplates(myTemplates.filter((s) => s.id !== id));
  }

  function saveCategory() {
    const name = window.prompt(
      "Name this outreach request (so you can reuse it):",
      goal.slice(0, 40)
    );
    if (!name || !name.trim()) return;
    persistCategories([
      { id: `${Date.now()}`, name: name.trim(), useCase, goal },
      ...categories,
    ]);
  }
  function loadCategory(c: Category) {
    setUseCase(c.useCase);
    setGoal(c.goal);
    setOpps([]);
    setSelected({});
    setDrafts([]);
    setStats("");
    setError("");
  }
  function removeCategory(id: string) {
    persistCategories(categories.filter((c) => c.id !== id));
  }

  const uc = TEMPLATES[useCase];
  const aboutText = [profile.name, profile.bio].filter(Boolean).join(". ").trim();

  function switchUseCase(key: TemplateKey) {
    setUseCase(key);
    setGoal(TEMPLATES[key].exampleGoal);
    setOpps([]);
    setSelected({});
    setDrafts([]);
    setStats("");
    setError("");
  }

  async function runDiscover() {
    setError("");
    setDrafts([]);
    setSelected({});
    setOpps([]);
    setStats("");
    setDiscovering(true);
    try {
      const res = await fetch("/api/discover", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ goal, about: aboutText, template: useCase }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Discovery failed.");
      setOpps(data.opportunities || []);
      const sel: Record<string, boolean> = {};
      (data.opportunities || []).forEach((o: Opportunity) => (sel[o.id] = true));
      setSelected(sel);
      setStats(
        `${data.opportunities.length} found · ${data.searched} searches · ${data.candidates} pages read · skipped ${data.skippedDupes} duplicates, ${data.skippedNotFit} not a fit`
      );
    } catch (e: any) {
      setError(e.message);
    } finally {
      setDiscovering(false);
    }
  }

  async function runDraft() {
    setError("");
    setExpanded(false);
    setDrafting(true);
    try {
      const chosen = opps.filter((o) => selected[o.id]);
      const res = await fetch("/api/draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          opportunities: chosen,
          about: aboutText,
          template: useCase,
          templates: myTemplates,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Drafting failed.");
      setDrafts(data.drafts || []);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setDrafting(false);
    }
  }

  const selectedCount = opps.filter((o) => selected[o.id]).length;
  const toggle = (id: string, v: boolean) =>
    setSelected((s) => ({ ...s, [id]: v }));

  return (
    <div className="min-h-screen">
      {/* ---------------- App bar ---------------- */}
      <header className="sticky top-0 z-20 border-b border-warm-border bg-white/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-6 py-3">
          <Logo />
          <span className="text-[16px] font-extrabold tracking-tight text-ink">
            Cue <span className="brand-text">Connect</span>
          </span>
          <div className="ml-auto hidden text-xs font-medium text-body/70 sm:block">
            Reach the right people, in your own voice
          </div>
        </div>
        <div className="mx-auto flex max-w-6xl gap-7 px-6">
          <TabButton active={tab === "outreach"} onClick={() => setTab("outreach")}>
            Outreach
          </TabButton>
          <TabButton active={tab === "templates"} onClick={() => setTab("templates")}>
            Templates
            {myTemplates.length > 0 && <Count n={myTemplates.length} />}
          </TabButton>
          <TabButton active={tab === "profile"} onClick={() => setTab("profile")}>
            Profile
            {profile.bio.trim() && <Dot />}
          </TabButton>
        </div>
      </header>

      {tab === "outreach" && (
        <>
          {/* ---------------- Hero ---------------- */}
          <section className="relative overflow-hidden bg-warm-fade">
            <div className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-brand-gradient opacity-[0.12] blur-3xl" />
            <div className="mx-auto grid max-w-6xl items-center gap-8 px-6 pb-3 pt-12 lg:grid-cols-[1.3fr_1fr]">
              <div>
                <span className="inline-block rounded-full border border-warm-border bg-white px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-accent shadow-card">
                  One place for every conversation
                </span>
                <h1 className="mt-4 max-w-2xl text-4xl font-extrabold leading-[1.1] tracking-tight text-ink sm:text-5xl">
                  Find your people.{" "}
                  <span className="brand-text">Start the conversation.</span>
                </h1>
                <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-body">
                  Cue Connect helps you reach the right people across email, LinkedIn,
                  Instagram and more. It finds their contact info and drafts warm,
                  personal messages that sound like you, so saying hello feels easy.
                </p>
              </div>
              <div className="hidden lg:block">
                <HeroArt />
              </div>
            </div>
          </section>

          <main className="mx-auto max-w-6xl px-6 pb-20">
            {/* ---------------- Request card ---------------- */}
            <section className="mt-6 rounded-3xl border border-warm-border bg-white p-6 shadow-soft sm:p-8">
              <div className="grid gap-6 sm:grid-cols-[230px_1fr]">
                <div>
                  <Label>Use case</Label>
                  <select
                    value={useCase}
                    onChange={(e) => switchUseCase(e.target.value as TemplateKey)}
                    className="scout-select w-full rounded-xl border border-warm-border bg-white px-3.5 py-3 text-sm font-semibold text-ink outline-none transition focus:border-coral focus:ring-4 focus:ring-coral/15"
                  >
                    {TEMPLATE_LIST.map((tpl) => (
                      <option key={tpl.key} value={tpl.key}>
                        {tpl.label}
                      </option>
                    ))}
                  </select>
                  <p className="mt-2.5 text-xs leading-relaxed text-body/80">
                    {uc.blurb}
                  </p>
                  {!aboutText && (
                    <button
                      onClick={() => setTab("profile")}
                      className="mt-3 text-xs font-semibold text-accent underline-offset-2 hover:underline"
                    >
                      Add your info in Profile to personalize →
                    </button>
                  )}
                </div>

                <div>
                  <Label>Who are you looking for?</Label>
                  <textarea
                    value={goal}
                    onChange={(e) => setGoal(e.target.value)}
                    placeholder={uc.goalPlaceholder}
                    rows={3}
                    className="w-full resize-y rounded-xl border border-warm-border px-3.5 py-3 text-sm text-ink outline-none transition focus:border-coral focus:ring-4 focus:ring-coral/15"
                  />
                  <p className="mt-1.5 text-xs text-body/70">
                    Describe the people or opportunities you want, in plain language.
                  </p>
                </div>
              </div>

              {/* Saved categories */}
              {categories.length > 0 && (
                <div className="mt-5 flex flex-wrap items-center gap-2">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-body/50">
                    Saved
                  </span>
                  {categories.map((c) => (
                    <span
                      key={c.id}
                      className="group inline-flex items-center gap-1.5 rounded-full border border-warm-border bg-warm-bg px-3 py-1 text-xs font-medium text-ink"
                    >
                      <button
                        onClick={() => loadCategory(c)}
                        className="transition hover:text-accent"
                        title={`${TEMPLATES[c.useCase].label}: ${c.goal}`}
                      >
                        {c.name}
                      </button>
                      <button
                        onClick={() => removeCategory(c.id)}
                        className="text-body/40 transition hover:text-accent"
                        aria-label="Remove saved search"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}

              <div className="mt-6 flex flex-wrap items-center gap-3">
                <button
                  onClick={runDiscover}
                  disabled={discovering || !goal.trim()}
                  className="rounded-xl bg-brand-gradient px-6 py-3 text-sm font-bold text-white shadow-soft transition hover:opacity-95 disabled:opacity-50"
                >
                  {discovering ? "Finding…" : `Find ${uc.targetNoun}`}
                </button>
                <button
                  onClick={saveCategory}
                  disabled={!goal.trim()}
                  className="rounded-xl border border-warm-border bg-white px-4 py-3 text-sm font-semibold text-body transition hover:bg-warm-bg disabled:opacity-50"
                >
                  Save as category
                </button>
                {stats && <span className="text-xs text-body/80">{stats}</span>}
              </div>
            </section>

            {error && (
              <div className="mt-5 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {error}
              </div>
            )}

            {discovering && (
              <div className="mt-8 flex items-start gap-3">
                <Avatar />
                <div className="relative max-w-md rounded-2xl rounded-tl-sm border border-warm-border bg-white px-4 py-3 shadow-card">
                  <Tail side="left" />
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-semibold text-ink">
                      Cue Connect is searching
                    </span>
                    <span className="ml-1 flex gap-1">
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-coral" />
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-blush [animation-delay:150ms]" />
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-coral [animation-delay:300ms]" />
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-body">
                    Reading the web and finding real contacts. About 30 to 60 seconds.
                  </p>
                </div>
              </div>
            )}

            {/* ---------------- How it works ---------------- */}
            {!opps.length && !discovering && (
              <section className="mt-12">
                <div className="grid gap-5 sm:grid-cols-3">
                  <Step
                    n="1"
                    title="Tell us who to reach"
                    body="Pick a use case and describe the people you want to connect with, in plain language."
                    icon={
                      <path d="M12 21s-7-5.5-7-11a7 7 0 0 1 14 0c0 5.5-7 11-7 11Z M12 11.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z" />
                    }
                  />
                  <Step
                    n="2"
                    title="We find them for you"
                    body="Cue Connect searches the public web and pulls real names and emails. Never invented."
                    icon={<path d="M21 21l-4.3-4.3 M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z" />}
                  />
                  <Step
                    n="3"
                    title="Say hello, your way"
                    body="Warm, personal drafts for each channel, matched to your templates. Review, tweak, send."
                    icon={
                      <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4L3 21l1.1-3.3A8.4 8.4 0 1 1 21 11.5Z" />
                    }
                  />
                </div>
              </section>
            )}

            {/* ---------------- Results as a chat bubble ---------------- */}
            {opps.length > 0 && (
              <section className="mt-10">
                <div className="flex items-start gap-3">
                  <Avatar />
                  <div className="relative w-full rounded-3xl rounded-tl-md border border-warm-border bg-white shadow-soft">
                    <Tail side="left" />
                    <button
                      onClick={() => setExpanded(true)}
                      className="flex w-full items-center gap-3 border-b border-warm-border px-5 py-4 text-left transition hover:bg-warm-bg/40"
                    >
                      <div>
                        <div className="text-sm font-bold text-ink">Cue Connect</div>
                        <div className="text-xs text-body/80">
                          I found {opps.length} {uc.targetNoun} who fit. Pick who to
                          reach out to.
                        </div>
                      </div>
                      <span className="ml-auto flex items-center gap-1.5 rounded-lg border border-warm-border px-2.5 py-1.5 text-xs font-semibold text-body">
                        <ExpandIcon /> Expand
                      </span>
                    </button>

                    <div className="max-h-[460px] overflow-auto p-4">
                      <FindsList opps={opps} selected={selected} toggle={toggle} />
                    </div>

                    <div className="flex flex-wrap items-center gap-3 border-t border-warm-border px-5 py-4">
                      <span className="text-sm text-body/80">
                        {selectedCount} selected
                      </span>
                      <button
                        onClick={runDraft}
                        disabled={drafting || selectedCount === 0}
                        className="ml-auto rounded-xl bg-brand-gradient px-5 py-2.5 text-sm font-bold text-white shadow-soft transition hover:opacity-95 disabled:opacity-50"
                      >
                        {drafting ? "Drafting…" : `Draft messages for ${selectedCount}`}
                      </button>
                    </div>
                  </div>
                </div>
              </section>
            )}

            {/* ---------------- Drafts ---------------- */}
            {drafts.length > 0 && (
              <section className="mt-12">
                <h2 className="mb-4 text-lg font-bold text-ink">
                  Messages ({drafts.length})
                </h2>
                <div className="space-y-4">
                  {drafts.map((d, i) => {
                    const opp = opps.find((o) => o.id === d.opportunityId);
                    return (
                      <div
                        key={i}
                        className="relative ml-auto max-w-3xl rounded-3xl rounded-tr-md border border-warm-border bg-white p-5 shadow-card"
                      >
                        <Tail side="right" />
                        <div className="mb-3 flex flex-wrap items-center gap-2">
                          <span className="font-semibold text-ink">
                            {opp?.name || "Draft"}
                          </span>
                          <span className="rounded-full bg-brand-gradient px-2.5 py-0.5 text-xs font-semibold text-white">
                            {d.channelType}
                          </span>
                          {d.to && (
                            <span className="text-xs text-body/70">→ {d.to}</span>
                          )}
                          <button
                            onClick={() =>
                              navigator.clipboard.writeText(
                                (d.subject ? `Subject: ${d.subject}\n\n` : "") + d.body
                              )
                            }
                            className="ml-auto rounded-lg border border-warm-border px-3 py-1 text-xs font-semibold text-body transition hover:bg-warm-bg"
                          >
                            Copy
                          </button>
                        </div>
                        {d.subject && (
                          <div className="mb-2.5 border-b border-warm-border pb-2.5 text-sm font-semibold text-ink">
                            {d.subject}
                          </div>
                        )}
                        <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-body">
                          {d.body}
                        </pre>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}
          </main>
        </>
      )}

      {tab === "templates" && (
        <TemplatesTab
          kinds={OUTREACH_KINDS}
          channel={mtChannel}
          setChannel={setMtChannel}
          text={mtText}
          setText={setMtText}
          add={addTemplate}
          list={myTemplates}
          remove={removeTemplate}
        />
      )}

      {tab === "profile" && (
        <ProfileTab profile={profile} onChange={persistProfile} />
      )}

      {/* ---------------- Footer ---------------- */}
      <footer className="border-t border-warm-border bg-white/70">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2 px-6 py-6 text-xs text-body/70">
          <Logo small />
          <span className="font-semibold text-ink">
            Cue <span className="brand-text">Connect</span>
          </span>
          <span className="ml-auto">
            Discover, draft, and connect, in your own voice.
          </span>
        </div>
      </footer>

      {/* ---------------- Full-screen finds ---------------- */}
      {expanded && opps.length > 0 && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-ink/40 p-3 backdrop-blur-sm sm:p-8"
          onClick={() => setExpanded(false)}
        >
          <div
            className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-3xl border border-warm-border bg-white shadow-soft"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 border-b border-warm-border px-6 py-4">
              <Avatar />
              <div>
                <div className="text-sm font-bold text-ink">Cue Connect</div>
                <div className="text-xs text-body/80">
                  {opps.length} {uc.targetNoun} who fit
                </div>
              </div>
              <button
                onClick={() => setExpanded(false)}
                className="ml-auto rounded-lg border border-warm-border px-3 py-1.5 text-xs font-semibold text-body transition hover:bg-warm-bg"
              >
                Close
              </button>
            </div>
            <div className="overflow-auto p-5 sm:p-6">
              <FindsList opps={opps} selected={selected} toggle={toggle} roomy />
            </div>
            <div className="flex flex-wrap items-center gap-3 border-t border-warm-border px-6 py-4">
              <span className="text-sm text-body/80">{selectedCount} selected</span>
              <button
                onClick={runDraft}
                disabled={drafting || selectedCount === 0}
                className="ml-auto rounded-xl bg-brand-gradient px-5 py-2.5 text-sm font-bold text-white shadow-soft transition hover:opacity-95 disabled:opacity-50"
              >
                {drafting ? "Drafting…" : `Draft messages for ${selectedCount}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- Finds list (used inline + full screen) ---------------- */
function FindsList({
  opps,
  selected,
  toggle,
  roomy = false,
}: {
  opps: Opportunity[];
  selected: Record<string, boolean>;
  toggle: (id: string, v: boolean) => void;
  roomy?: boolean;
}) {
  return (
    <div className={`grid gap-3 ${roomy ? "lg:grid-cols-2" : "grid-cols-1"}`}>
      {opps.map((o) => {
        const on = !!selected[o.id];
        return (
          <label
            key={o.id}
            className={`flex cursor-pointer gap-3 rounded-2xl border p-3.5 transition ${
              on
                ? "border-coral/40 bg-warm-bg/60"
                : "border-warm-border bg-white hover:bg-warm-bg/30"
            }`}
          >
            <input
              type="checkbox"
              checked={on}
              onChange={(e) => toggle(o.id, e.target.checked)}
              className="mt-1 h-4 w-4 accent-coral"
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-ink">
                  {o.url ? (
                    <a
                      href={o.url}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="transition hover:text-accent"
                    >
                      {o.name}
                    </a>
                  ) : (
                    o.name
                  )}
                </span>
                {o.fitScore != null && (
                  <span className="rounded-full bg-brand-gradient px-2 py-0.5 text-[10px] font-bold text-white">
                    {Math.round(o.fitScore * 100)}% fit
                  </span>
                )}
                <span className="rounded-full border border-warm-border bg-warm-bg px-2 py-0.5 text-[10px] font-medium text-body">
                  {o.channel}
                </span>
              </div>
              {(o.outlet || o.location) && (
                <div className="mt-0.5 text-xs text-body/80">
                  {[o.outlet, o.location].filter(Boolean).join(" · ")}
                </div>
              )}
              <div className="mt-1 text-xs">
                {o.contactEmail && (
                  <span className="font-semibold text-accent">{o.contactEmail}</span>
                )}
                {o.contactName && (
                  <span className="text-body">
                    {o.contactEmail ? "  ·  " : ""}
                    {o.contactName}
                    {o.contactRole ? ` (${o.contactRole})` : ""}
                  </span>
                )}
                {o.contactHandle && (
                  <span className="text-body/70">
                    {o.contactEmail || o.contactName ? "  ·  " : ""}
                    {o.contactHandle}
                  </span>
                )}
                {!o.contactEmail && !o.contactName && !o.contactHandle && (
                  <span className="text-body/40">no direct contact found yet</span>
                )}
              </div>
              {o.whyItFits && (
                <div className="mt-1.5 text-xs leading-relaxed text-body">
                  {o.whyItFits}
                </div>
              )}
            </div>
          </label>
        );
      })}
    </div>
  );
}

/* ---------------- Templates tab ---------------- */
function TemplatesTab({
  kinds,
  channel,
  setChannel,
  text,
  setText,
  add,
  list,
  remove,
}: {
  kinds: string[];
  channel: string;
  setChannel: (v: string) => void;
  text: string;
  setText: (v: string) => void;
  add: () => void;
  list: OutreachTemplate[];
  remove: (id: string) => void;
}) {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-3xl font-extrabold tracking-tight text-ink">
        Your <span className="brand-text">templates</span>
      </h1>
      <p className="mt-2 text-[15px] leading-relaxed text-body">
        Set up how each kind of message should sound, an email, a LinkedIn note, an
        Instagram DM. When Cue Connect drafts outreach, it uses the right format and
        your voice for each channel.
        <span className="text-body/60"> (Saved on this device.)</span>
      </p>

      <section className="mt-7 rounded-3xl border border-warm-border bg-white p-6 shadow-soft sm:p-8">
        <div className="grid gap-5 sm:grid-cols-[210px_1fr]">
          <div>
            <Label>Kind of outreach</Label>
            <select
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
              className="scout-select w-full rounded-xl border border-warm-border bg-white px-3.5 py-3 text-sm font-semibold text-ink outline-none transition focus:border-coral focus:ring-4 focus:ring-coral/15"
            >
              {kinds.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <p className="mt-2.5 text-xs leading-relaxed text-body/80">
              Cue Connect drafts this kind of message in the style you show it here.
            </p>
          </div>
          <div>
            <Label>Show us how you write it</Label>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={5}
              placeholder="Paste a real example, or write a sample of how you want this kind of message to sound. Hi! My name is... I came across your work and thought it was incredible. I would love to..."
              className="w-full resize-y rounded-xl border border-warm-border px-3.5 py-3 text-sm text-ink outline-none transition focus:border-coral focus:ring-4 focus:ring-coral/15"
            />
          </div>
        </div>
        <div className="mt-5">
          <button
            onClick={add}
            disabled={!text.trim()}
            className="rounded-xl bg-brand-gradient px-6 py-3 text-sm font-bold text-white shadow-soft transition hover:opacity-95 disabled:opacity-50"
          >
            Save template
          </button>
        </div>
      </section>

      <section className="mt-8">
        <h2 className="mb-4 text-lg font-bold text-ink">
          Your templates ({list.length})
        </h2>
        {list.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-warm-border bg-white/60 p-10 text-center text-sm text-body/70">
            No templates yet. Add one for email, a LinkedIn message, or an Instagram
            DM, and every draft will match that style.
          </div>
        ) : (
          <div className="space-y-3">
            {list.map((s) => (
              <div
                key={s.id}
                className="rounded-2xl border border-warm-border bg-white p-5 shadow-card"
              >
                <div className="mb-2.5 flex items-center gap-2">
                  <span className="rounded-full bg-brand-gradient px-2.5 py-0.5 text-xs font-semibold text-white">
                    {s.channel}
                  </span>
                  <button
                    onClick={() => remove(s.id)}
                    className="ml-auto text-xs font-semibold text-body/60 transition hover:text-accent"
                  >
                    Remove
                  </button>
                </div>
                <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-body">
                  {s.text}
                </pre>
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

/* ---------------- Profile tab ---------------- */
function ProfileTab({
  profile,
  onChange,
}: {
  profile: Profile;
  onChange: (p: Profile) => void;
}) {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-3xl font-extrabold tracking-tight text-ink">
        Your <span className="brand-text">profile</span>
      </h1>
      <p className="mt-2 text-[15px] leading-relaxed text-body">
        Tell Cue Connect who you are. Paste your resume, bio, or anything that
        describes you or your company. Every search and every draft uses this to sound
        like you and explain why you are reaching out.
        <span className="text-body/60"> (Saved on this device.)</span>
      </p>

      <section className="mt-7 rounded-3xl border border-warm-border bg-white p-6 shadow-soft sm:p-8">
        <Label>Your name or company</Label>
        <input
          value={profile.name}
          onChange={(e) => onChange({ ...profile, name: e.target.value })}
          placeholder="e.g. Kaitlyn Kasel, or Cue Creative"
          className="mb-5 w-full rounded-xl border border-warm-border px-3.5 py-3 text-sm text-ink outline-none transition focus:border-coral focus:ring-4 focus:ring-coral/15"
        />
        <Label>Paste your resume, bio, or company description</Label>
        <textarea
          value={profile.bio}
          onChange={(e) => onChange({ ...profile, bio: e.target.value })}
          rows={12}
          placeholder="Paste anything that tells us who you are: your resume, a short bio, your company's about page, your experience, what you do. The more you give, the more personal your outreach becomes."
          className="w-full resize-y rounded-xl border border-warm-border px-3.5 py-3 text-sm leading-relaxed text-ink outline-none transition focus:border-coral focus:ring-4 focus:ring-coral/15"
        />
        <p className="mt-3 text-xs text-body/70">
          Saved automatically as you type. Used to personalize every message, never
          shared.
        </p>
      </section>
    </main>
  );
}

/* ---------------- Small UI bits ---------------- */
function Label({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label
      className={`mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-body/60 ${className}`}
    >
      {children}
    </label>
  );
}

function Count({ n }: { n: number }) {
  return (
    <span className="ml-1.5 rounded-full bg-brand-gradient px-1.5 py-0.5 text-[10px] font-bold text-white">
      {n}
    </span>
  );
}
function Dot() {
  return <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-brand-gradient align-middle" />;
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="relative -mb-px px-1 pb-3 pt-1 text-sm font-bold transition"
    >
      <span className={active ? "text-ink" : "text-body/50 hover:text-body"}>
        {children}
      </span>
      {active && (
        <span className="absolute inset-x-0 -bottom-px h-[3px] rounded-full bg-brand-gradient" />
      )}
    </button>
  );
}

function Step({
  n,
  title,
  body,
  icon,
}: {
  n: string;
  title: string;
  body: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-warm-border bg-white p-5 shadow-card">
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-gradient text-white">
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {icon}
          </svg>
        </span>
        <span className="text-xs font-bold uppercase tracking-wider text-accent">
          Step {n}
        </span>
      </div>
      <h3 className="mt-3 text-[15px] font-bold text-ink">{title}</h3>
      <p className="mt-1.5 text-[13px] leading-relaxed text-body">{body}</p>
    </div>
  );
}

// The little triangle tail most chat bubbles have. A rotated square sitting half
// outside the bubble edge, bordered on its two outer sides to match the bubble.
function Tail({ side }: { side: "left" | "right" }) {
  return (
    <span
      aria-hidden
      className={`absolute top-4 h-3.5 w-3.5 rotate-45 bg-white ${
        side === "left"
          ? "-left-[7px] border-b border-l border-warm-border"
          : "-right-[7px] border-r border-t border-warm-border"
      }`}
    />
  );
}

function Avatar() {
  return (
    <span className="mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-gradient">
      <Logo white />
    </span>
  );
}

function ExpandIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M15 3h6v6 M9 21H3v-6 M21 3l-7 7 M3 21l7-7" />
    </svg>
  );
}

function HeroArt() {
  return (
    <div className="relative mx-auto h-56 w-full max-w-sm">
      <div className="absolute right-6 top-2 w-60 rounded-2xl rounded-tr-sm border border-warm-border bg-white p-3.5 shadow-soft">
        <span
          aria-hidden
          className="absolute -right-[6px] top-5 h-3 w-3 rotate-45 border-r border-t border-warm-border bg-white"
        />
        <div className="mb-2 flex items-center gap-2">
          <span className="h-6 w-6 rounded-full bg-brand-gradient" />
          <span className="text-xs font-bold text-ink">You</span>
          <span className="ml-auto text-[10px] font-semibold uppercase tracking-wide text-accent">
            Email
          </span>
        </div>
        <div className="h-2 w-full rounded-full bg-warm-bg" />
        <div className="mt-1.5 h-2 w-4/5 rounded-full bg-warm-bg" />
      </div>
      <div className="absolute left-2 top-24 w-52 rounded-2xl rounded-tl-sm bg-brand-gradient p-3.5 text-white shadow-soft">
        <span
          aria-hidden
          className="absolute -left-[6px] top-5 h-3 w-3 rotate-45 bg-[#ff8159]"
        />
        <div className="mb-2 flex items-center gap-2">
          <span className="h-6 w-6 rounded-full bg-white/30" />
          <span className="text-xs font-bold">Reply</span>
          <span className="ml-auto text-[10px] font-semibold uppercase tracking-wide text-white/80">
            LinkedIn
          </span>
        </div>
        <div className="h-2 w-full rounded-full bg-white/35" />
        <div className="mt-1.5 h-2 w-3/4 rounded-full bg-white/35" />
      </div>
      <div className="absolute bottom-1 right-10 flex items-center gap-1.5 rounded-full border border-warm-border bg-white px-3 py-2 shadow-card">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-coral" />
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-blush [animation-delay:150ms]" />
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-coral [animation-delay:300ms]" />
      </div>
    </div>
  );
}

function Logo({ small = false, white = false }: { small?: boolean; white?: boolean }) {
  const s = small ? 18 : 24;
  if (white) {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path
          d="M6 7.5h12a1 1 0 0 1 1 1V14a1 1 0 0 1-1 1h-6.5L8 17.6A.45.45 0 0 1 7.3 17.2V15H6a1 1 0 0 1-1-1V8.5a1 1 0 0 1 1-1Z"
          stroke="white"
          strokeWidth="1.6"
          fill="none"
          strokeLinejoin="round"
        />
        <path d="M8 10.2h8 M8 12.4h5" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" aria-hidden>
      <defs>
        <linearGradient id="cc-grad" x1="0" y1="0" x2="24" y2="24">
          <stop stopColor="#ff8a5b" />
          <stop offset="1" stopColor="#ff6f91" />
        </linearGradient>
      </defs>
      <rect width="24" height="24" rx="7" fill="url(#cc-grad)" />
      <path
        d="M6 7.5h12a1 1 0 0 1 1 1V14a1 1 0 0 1-1 1h-6.5L8 17.6A.45.45 0 0 1 7.3 17.2V15H6a1 1 0 0 1-1-1V8.5a1 1 0 0 1 1-1Z"
        stroke="white"
        strokeWidth="1.5"
        fill="none"
        strokeLinejoin="round"
      />
      <path d="M8 10.2h8 M8 12.4h5" stroke="white" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
