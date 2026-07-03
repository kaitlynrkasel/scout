"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Scout the dog — a small mascot with a fixed resting spot at the bottom-left of
 * each tab, sitting in the tan just above the footer row (it's rendered inside
 * the footer and lifted up, so it does not ride the viewport). You only see it
 * once you scroll to the bottom of a tab. The first time it comes into view it
 * wags its tail, then rests 30s and wags again for 5s, repeating.
 */
export default function CornerDog() {
  const ref = useRef<HTMLImageElement>(null);
  const [seen, setSeen] = useState(false);
  const [wagging, setWagging] = useState(false);
  const started = useRef(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const startWagging = () => {
      if (started.current) return;
      started.current = true;
      const wag = () => {
        setWagging(true);
        timers.current.push(
          setTimeout(() => {
            setWagging(false);
            timers.current.push(setTimeout(wag, 30000)); // rest 30s
          }, 5000), // wag 5s
        );
      };
      wag();
    };

    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          startWagging();
        }
      },
      { threshold: 0.4 },
    );
    io.observe(el);

    return () => {
      io.disconnect();
      timers.current.forEach(clearTimeout);
    };
  }, []);

  return (
    <img
      ref={ref}
      src={wagging ? "/scout-dog-wag.gif" : "/scout-dog.png"}
      alt=""
      aria-hidden="true"
      className={`pointer-events-none absolute -top-16 left-4 z-10 hidden w-14 select-none transition-opacity duration-500 ease-out sm:block ${
        seen ? "opacity-90" : "opacity-0"
      }`}
    />
  );
}
