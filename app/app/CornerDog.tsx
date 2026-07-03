"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Scout the dog — a small mascot pinned to the bottom-left of the main content
 * area. Hidden at the top of a page, it fades in once you scroll down, and
 * every ~40s it wags its tail for 5s (paused while the tab is hidden).
 */
export default function CornerDog() {
  const [shown, setShown] = useState(false);
  const [wagging, setWagging] = useState(false);
  const wagTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reveal on scroll.
  useEffect(() => {
    const onScroll = () => setShown(window.scrollY > 140);
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Tail-wag loop — skip a beat when the tab isn't visible.
  useEffect(() => {
    const loop = setInterval(() => {
      if (document.hidden) return;
      setWagging(true);
      wagTimeout.current = setTimeout(() => setWagging(false), 5000);
    }, 40000);
    return () => {
      clearInterval(loop);
      if (wagTimeout.current) clearTimeout(wagTimeout.current);
    };
  }, []);

  return (
    <img
      src={wagging ? "/scout-dog-wag.gif" : "/scout-dog.png"}
      alt=""
      aria-hidden="true"
      className={`pointer-events-none fixed bottom-4 left-[244px] z-40 hidden w-14 select-none transition-all duration-300 ease-out sm:block ${
        shown ? "translate-y-0 opacity-90" : "translate-y-2 opacity-0"
      }`}
    />
  );
}
