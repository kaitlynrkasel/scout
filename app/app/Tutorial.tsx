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
  const cardRef = useRef<HTMLDivElement | null>(null);

  const step = steps[i];
  const isFirst = i === 0;
  const isLast = i === steps.length - 1;

  // Reset to the first step every time the tour is (re)opened.
  useEffect(() => {
    if (open) setI(0);
  }, [open]);

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

  // Card placement: to the right of the spotlight when there's room (sidebar
  // targets), otherwise centered. Falls back to centered when there's no target.
  let cardStyle: React.CSSProperties;
  if (rect) {
    const spaceRight =
      typeof window !== "undefined" ? window.innerWidth - (rect.left + rect.width) : 0;
    if (spaceRight > 360) {
      cardStyle = {
        top: Math.max(16, rect.top - 8),
        left: rect.left + rect.width + PAD + 14,
      };
    } else {
      // place below the target
      cardStyle = {
        top: rect.top + rect.height + PAD + 14,
        left: Math.max(16, rect.left),
      };
    }
  } else {
    cardStyle = { top: "50%", left: "50%", transform: "translate(-50%, -50%)" };
  }

  return (
    <div className="fixed inset-0 z-[100]" aria-modal="true" role="dialog">
      {/* Dim + spotlight. The lit box uses a huge box-shadow to darken everything
          around it, so clicks on the rest of the page are blocked by this layer. */}
      {rect ? (
        <div
          className="pointer-events-auto absolute rounded-xl transition-all duration-300"
          style={{
            top: rect.top - PAD,
            left: rect.left - PAD,
            width: rect.width + PAD * 2,
            height: rect.height + PAD * 2,
            boxShadow: "0 0 0 9999px rgba(41, 30, 22, 0.62)",
            outline: "2px solid rgba(255,255,255,0.9)",
            outlineOffset: 2,
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
        className="pointer-events-auto absolute w-[320px] max-w-[calc(100vw-32px)] rounded-2xl border border-warm-border bg-white p-5 shadow-2xl"
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
