"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Scout the dog — a small mascot that sits in the bottom-left corner of the main
 * content area on every tab. It's hidden at the top of a page and fades in once
 * you scroll down. The first time it appears it wags its tail, then rests 30s
 * and wags again for 5s, repeating.
 */
export default function CornerDog() {
  const [shown, setShown] = useState(false);
  const [wagging, setWagging] = useState(false);
  const started = useRef(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Reveal on scroll.
  useEffect(() => {
    const onScroll = () => setShown(window.scrollY > 140);
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Kick off the wag rhythm the first time the dog is seen: wag 5s, rest 30s, repeat.
  useEffect(() => {
    if (!shown || started.current) return;
    started.current = true;
    const wag = () => {
      setWagging(true);
      timers.current.push(
        setTimeout(() => {
          setWagging(false);
          timers.current.push(setTimeout(wag, 30000));
        }, 5000),
      );
    };
    wag();
  }, [shown]);

  // Clean up any pending timers on unmount.
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  return (
    <img
      src={wagging ? "/scout-dog-wag.gif" : "/scout-dog.png"}
      alt=""
      aria-hidden="true"
      className={`pointer-events-none fixed bottom-6 left-[244px] z-40 hidden w-14 select-none transition-all duration-300 ease-out sm:block ${
        shown ? "translate-y-0 opacity-90" : "translate-y-2 opacity-0"
      }`}
    />
  );
}
