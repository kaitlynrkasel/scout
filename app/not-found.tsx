import Link from "next/link";

// A wrong address gets a Scout page with a way home, not the framework's
// bare default.
export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-warm-bg px-6 text-center">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/scout-dog.png" alt="" width={120} height={92} className="w-28 opacity-80" />
      <h1 className="mt-6 font-display text-3xl font-bold tracking-tight text-ink">
        This trail goes nowhere
      </h1>
      <p className="mt-2 max-w-sm text-sm leading-relaxed text-body">
        The page you were after does not exist, or its address changed. Scout
        checked twice.
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <Link
          href="/"
          className="rounded-xl bg-brown px-5 py-2.5 text-sm font-bold text-white shadow-soft transition hover:bg-brown-deep"
        >
          Back to the front page
        </Link>
        <Link
          href="/app"
          className="rounded-xl border border-warm-border bg-surface px-5 py-2.5 text-sm font-semibold text-body transition hover:bg-warm-bg"
        >
          Open the app
        </Link>
      </div>
    </main>
  );
}
