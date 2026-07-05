"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Scout guided tour — a first-run introduction that walks a new user through the
 * app. It dims the screen, spotlights one element at a time (matched by a
 * `data-tour="<id>"` attribute), and shows a coach-mark card with Back / Next /
 * Skip. Steps can also switch the active tab so the real screen shows behind the
 * spotlight. Whether the user finishes or skips, we never auto-launch again
 * (the caller persists a "seen" flag); it can always be replayed from the menu.
 */

export type TourStep = {
  /** Tab to switch to before showing this step (optional). */
  tab?: string;
  /** `data-tour` id of the element to spotlight. Omit for a centered card. */
  target?: string;
  title: string;
  body: string;
};

type Rect = { top: number; left: number; width: number; height: number };

export default function Tutorial({
  open,
  steps,
  setTab,
  onClose,
  onFinish,
}: {
  open: boolean;
  steps: TourStep[];
  setTab: (t: string) => void;
  /** Called when the user skips or closes without finishing. */
  onClose: () => void;
  /** Called when the user reaches the end of the tour. */
  onFinish: () => void;
}) {
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const [cardH, setCardH] = useState(0);
  const [reduceMotion, setReduceMotion] = useState(false);
  const cardRef = useRef<HTMLDivElement | null>(null);

  const step = steps[i];
  const isFirst = i === 0;
  const isLast = i === steps.length - 1;

  // Reset to the first step every time the tour is (re)opened.
  useEffect(() => {
    if (open) setI(0);
  }, [open]);

  // Honor the OS "reduce motion" preference (no glide, just place the card).
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduceMotion(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  // Measure the card so we can center it (and keep it on-screen) precisely.
  // useLayoutEffect runs before paint, so the correct position is used from the
  // first frame and the glide never starts from a wrong spot.
  useLayoutEffect(() => {
    if (open && cardRef.current) setCardH(cardRef.current.offsetHeight);
  }, [open, i, rect]);

  // Switch tab for the current step so the real screen shows behind the dim.
  useEffect(() => {
    if (open && step?.tab) setTab(step.tab);
  }, [open, i, step?.tab, setTab]);

  // Measure the spotlight target (re-measures on step change, resize, scroll).
  useLayoutEffect(() => {
    if (!open) return;
    let raf = 0;
    const measure = () => {
      if (!step?.target) {
        setRect(null);
        return;
      }
      const el = document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`);
      if (!el) {
        setRect(null);
        return;
      }
      const r = el.getBoundingClientRect();
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    };
    // Two rAFs: let the tab switch above paint before we measure.
    raf = requestAnimationFrame(() => requestAnimationFrame(measure));
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open, i, step?.target, step?.tab]);

  // Keyboard: Esc skips, arrows / Enter navigate.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight" || e.key === "Enter") next();
      else if (e.key === "ArrowLeft") setI((v) => Math.max(0, v - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, i]);

  if (!open || !step) return null;

  const next = () => {
    if (isLast) onFinish();
    else setI((v) => Math.min(steps.length - 1, v + 1));
  };

  const PAD = 8; // spotlight breathing room around the target

  // Card placement. Everything is expressed as a pixel offset from a fixed 0,0
  // origin and applied via a GPU `translate`, so moving between the centered
  // intro and a spotlighted target is one smooth glide instead of a snap (and
  // it never triggers layout). Beside the target when there's room, else below,
  // else dead-center. Clamped to stay fully on screen.
  const vw = typeof window !== "undefined" ? window.innerWidth : 1200;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const cardW = Math.min(320, vw - 32);
  let tx: number;
  let ty: number;
  if (rect) {
    const spaceRight = vw - (rect.left + rect.width);
    if (spaceRight > 360) {
      tx = rect.left + rect.width + PAD + 14;
      ty = Math.max(16, rect.top - 8);
    } else {
      tx = Math.max(16, rect.left);
      ty = rect.top + rect.height + PAD + 14;
    }
    tx = Math.min(tx, Math.max(16, vw - cardW - 16));
    ty = Math.min(ty, Math.max(16, vh - cardH - 16));
  } else {
    tx = (vw - cardW) / 2;
    ty = Math.max(16, (vh - cardH) / 2);
  }
  const cardStyle: React.CSSProperties = {
    top: 0,
    left: 0,
    width: cardW,
    transform: `translate3d(${Math.round(tx)}px, ${Math.round(ty)}px, 0)`,
    transition: reduceMotion
      ? undefined
      : "transform 480ms cubic-bezier(0.22, 1, 0.36, 1)",
    willChange: "transform",
  };

  return (
    <div className="fixed inset-0 z-[100]" aria-modal="true" role="dialog">
      {/* Dim + spotlight. The lit box uses a huge box-shadow to darken everything
          around it, so clicks on the rest of the page are blocked by this layer. */}
      {rect ? (
        <div
          className="pointer-events-auto absolute rounded-xl"
          style={{
            top: rect.top - PAD,
            left: rect.left - PAD,
            width: rect.width + PAD * 2,
            height: rect.height + PAD * 2,
            boxShadow: "0 0 0 9999px rgba(41, 30, 22, 0.62)",
            outline: "2px solid rgba(255,255,255,0.9)",
            outlineOffset: 2,
            // Glide the spotlight with the same easing/timing as the card so the
            // dim window and the coach-mark move together, not at different rates.
            transition: reduceMotion
              ? undefined
              : "top 480ms cubic-bezier(0.22, 1, 0.36, 1), left 480ms cubic-bezier(0.22, 1, 0.36, 1), width 480ms cubic-bezier(0.22, 1, 0.36, 1), height 480ms cubic-bezier(0.22, 1, 0.36, 1)",
          }}
        />
      ) : (
        <div
          className="pointer-events-auto absolute inset-0"
          style={{ background: "rgba(41, 30, 22, 0.62)" }}
        />
      )}

      {/* Coach-mark card */}
      <div
        ref={cardRef}
        className="pointer-events-auto absolute rounded-2xl border border-warm-border bg-white p-5 shadow-2xl"
        style={cardStyle}
      >
        <div className="mb-2 flex items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/scout-logo.png" alt="" width={22} height={22} className="h-[22px] w-[22px]" />
          <span className="text-[11px] font-bold uppercase tracking-[0.09em] text-muted">
            Tour · {i + 1} of {steps.length}
          </span>
          <button
            onClick={onClose}
            aria-label="Skip tour"
            className="ml-auto rounded-lg px-2 py-1 text-xs font-semibold text-body/60 transition hover:bg-brown-tint hover:text-brown-deep"
          >
            Skip
          </button>
        </div>

        <h3 className="text-base font-extrabold tracking-tight text-ink">{step.title}</h3>
        <p className="mt-1.5 text-sm leading-relaxed text-body">{step.body}</p>

        {/* Progress dots */}
        <div className="mt-4 flex items-center gap-1.5">
          {steps.map((_, idx) => (
            <span
              key={idx}
              className={`h-1.5 rounded-full transition-all ${
                idx === i ? "w-4 bg-brown" : "w-1.5 bg-warm-border"
              }`}
            />
          ))}
        </div>

        <div className="mt-4 flex items-center gap-2">
          {!isFirst && (
            <button
              onClick={() => setI((v) => Math.max(0, v - 1))}
              className="rounded-xl border border-warm-border px-3.5 py-2 text-sm font-semibold text-body transition hover:bg-brown-tint"
            >
              Back
            </button>
          )}
          <button
            onClick={next}
            className="ml-auto rounded-xl bg-brown px-4 py-2 text-sm font-bold text-white shadow-soft transition hover:opacity-90"
          >
            {isLast ? "Get started" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}
