"use client";

import { useEffect, useState } from "react";

/**
 * Scout the dog — a small mascot that constantly sits in the bottom-left of the
 * main content area on every tab. The moment it's on screen it wags its tail,
 * then rests 30s and wags again for 5s, repeating.
 */
export default function CornerDog() {
  const [wagging, setWagging] = useState(true); // starts wagging the moment it's seen

  useEffect(() => {
    let stopTimer: ReturnType<typeof setTimeout>;
    let restTimer: ReturnType<typeof setTimeout>;
    const wag = () => {
      setWagging(true);
      stopTimer = setTimeout(() => {
        setWagging(false);
        restTimer = setTimeout(wag, 30000); // rest 30s
      }, 5000); // wag for 5s
    };
    wag();
    return () => {
      clearTimeout(stopTimer);
      clearTimeout(restTimer);
    };
  }, []);

  return (
    <img
      src={wagging ? "/scout-dog-wag.gif" : "/scout-dog.png"}
      alt=""
      aria-hidden="true"
      className="pointer-events-none fixed bottom-28 left-[244px] z-40 hidden w-14 select-none sm:block"
    />
  );
}
