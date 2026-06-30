// Shared public-site chrome (server components) for the landing + analytics pages.

export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <defs>
        <linearGradient id="scout-grad" x1="0" y1="0" x2="24" y2="24">
          <stop stopColor="#ff8a5b" />
          <stop offset="1" stopColor="#ff6f91" />
        </linearGradient>
      </defs>
      <rect width="24" height="24" rx="7" fill="url(#scout-grad)" />
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

export function Nav() {
  return (
    <header className="sticky top-0 z-20 border-b border-warm-border bg-white/85 backdrop-blur-md">
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-6 py-3">
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
          <a href="/analytics" className="transition hover:text-ink">
            Proof
          </a>
        </nav>
        <a
          href="/app"
          className="ml-4 rounded-xl bg-brand-gradient px-4 py-2 text-sm font-bold text-white shadow-soft transition hover:opacity-95"
        >
          Open Scout
        </a>
      </div>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="border-t border-warm-border bg-white/70">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-2 px-6 py-8 text-xs text-body/70">
        <Logo size={18} />
        <span className="font-semibold">
          <span className="brand-text">Scout</span>
        </span>
        <span className="text-body/50">Reach the right people, in your own voice.</span>
        <nav className="ml-auto flex gap-5 font-semibold text-body">
          <a href="/analytics" className="hover:text-ink">
            Proof
          </a>
          <a href="/app" className="hover:text-ink">
            Open Scout
          </a>
        </nav>
      </div>
    </footer>
  );
}
