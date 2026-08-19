// Shared public-site chrome (server components) for the landing + analytics pages.

export function Logo({ size = 24 }: { size?: number }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src="/scout-logo.png" alt="Scout" width={size} height={size} />
  );
}

export function Nav() {
  return (
    <header className="sticky top-0 z-20 border-b border-warm-border bg-surface/85 backdrop-blur-md">
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3 sm:px-6">
        <a href="/" className="flex items-center gap-2">
          <Logo />
          <span className="text-[16px] font-extrabold tracking-tight">
            <span className="brand-text">Scout</span>
          </span>
        </a>
        <nav className="ml-auto hidden items-center gap-6 text-sm font-semibold text-body md:flex">
          <a href="/#how" className="transition hover:text-ink">
            How it works
          </a>
          <a href="/#features" className="transition hover:text-ink">
            Features
          </a>
          <a href="/#pricing" className="transition hover:text-ink">
            Pricing
          </a>
          <a href="/#team" className="transition hover:text-ink">
            Team
          </a>
          <a href="/analytics" className="transition hover:text-ink">
            Proof
          </a>
        </nav>
        <a
          href="/app"
          className="ml-auto rounded-xl bg-brand-gradient px-3.5 py-2 text-sm font-bold text-white shadow-soft transition hover:opacity-95 md:ml-4"
        >
          Open Scout
        </a>
      </div>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="border-t border-warm-border bg-surface/70">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-2 px-4 py-8 text-xs text-body/70 sm:px-6">
        <Logo size={18} />
        <span className="font-semibold">
          <span className="brand-text">Scout</span>
        </span>
        <span className="text-body/50">Reach the right people, in your own voice.</span>
        <nav className="flex flex-wrap gap-x-5 gap-y-1 font-semibold text-body sm:ml-auto">
          <a href="/analytics" className="py-1.5 hover:text-ink">
            Proof
          </a>
          <a href="/privacy" className="py-1.5 hover:text-ink">
            Privacy
          </a>
          <a href="/terms" className="py-1.5 hover:text-ink">
            Terms
          </a>
          <a href="/app" className="py-1.5 hover:text-ink">
            Open Scout
          </a>
        </nav>
      </div>
    </footer>
  );
}
