"use client";

import { useRef } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(useGSAP, ScrollTrigger);

/**
 * Text/entrance animations for the landing page. The markup is server-rendered
 * (see page.tsx), so we grab the `.scoutland` root from the DOM and animate real
 * nodes (no unscoped selectors). All work runs client-only inside useGSAP, which
 * reverts every tween + ScrollTrigger on unmount. Honors prefers-reduced-motion
 * by leaving everything in its natural, fully-visible state.
 */
export default function LandingMotion() {
  const guard = useRef<HTMLSpanElement>(null);

  useGSAP(() => {
    const root = document.querySelector<HTMLElement>(".scoutland");
    if (!root) return;

    // Respect reduced motion — do nothing, so the page renders statically.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const qa = (sel: string) => gsap.utils.toArray<HTMLElement>(root.querySelectorAll(sel));
    const q = (sel: string) => root.querySelector<HTMLElement>(sel);

    // ---- Hero: the one loud moment ----
    const tl = gsap.timeline({ defaults: { ease: "power3.out" } });
    tl.from(qa(".backword"), { opacity: 0, scale: 1.06, duration: 1.1, ease: "power2.out" }, 0)
      .from(
        qa(".headline .l"),
        { yPercent: 120, opacity: 0, duration: 0.95, stagger: 0.12, ease: "power4.out" },
        0.08
      )
      .from(qa(".eyebrow, .eyebrow2"), { opacity: 0, y: -8, duration: 0.6, stagger: 0.08 }, 0.25)
      .from(qa(".dog"), { opacity: 0, y: 40, scale: 0.98, duration: 0.9 }, 0.35)
      .from(qa(".ledechip"), { opacity: 0, y: 26, duration: 0.7 }, 0.5)
      .from(qa(".sticker"), { opacity: 0, scale: 0.8, duration: 0.5, ease: "back.out(2)" }, 0.75);

    // ---- Run band: seamless full-width "go fetch" marquee ----
    // The text is two identical halves, so shifting by exactly -50% loops with no
    // seam and no gap (each half is wider than the viewport). xPercent stays
    // correct even after the webfont swaps the text width; duration tracks the
    // measured width so the scroll speed stays constant across screen sizes.
    const big = q(".run .big");
    if (big) {
      const speed = 90; // px per second
      const dur = Math.max(20, big.scrollWidth / 2 / speed);
      gsap.to(big, { xPercent: -50, duration: dur, ease: "none", repeat: -1 });
    }

    // ---- Run band: the dog runs left → right, off-screen, once every 30s ----
    const dog = q(".run .dogrun");
    if (dog) {
      const band = dog.closest(".run") as HTMLElement | null;
      const bandW = band?.clientWidth || window.innerWidth;
      const off = 440; // start/end fully past the edges (band clips overflow)
      const startX = -off;
      const endX = bandW + off;
      const dogSpeed = 220; // px/s — a natural trot, constant across screen sizes
      const cross = (endX - startX) / dogSpeed;
      gsap.set(dog, { x: startX });
      gsap.to(dog, {
        x: endX,
        duration: cross,
        ease: "none",
        repeat: -1,
        repeatDelay: Math.max(0, 30 - cross), // hold off-screen so each run is 30s apart
      });
    }

    // ---- Scroll reveals: headings, kickers, and content rise as they enter ----
    const reveal = (sel: string, opts: gsap.TweenVars = {}) =>
      qa(sel).forEach((el) =>
        gsap.from(el, {
          y: 26,
          opacity: 0,
          duration: 0.75,
          ease: "power3.out",
          scrollTrigger: { trigger: el, start: "top 88%" },
          ...opts,
        })
      );

    // Section headings: reveal per word for a bit more character.
    qa(".sec .h2, .contact h2").forEach((h) => {
      const words = h.querySelectorAll("em");
      gsap.from(h, {
        y: 30,
        opacity: 0,
        duration: 0.8,
        ease: "power4.out",
        scrollTrigger: { trigger: h, start: "top 86%" },
      });
      // nudge the accent word a touch later for a layered feel
      if (words.length)
        gsap.from(words, {
          opacity: 0,
          duration: 0.6,
          delay: 0.15,
          ease: "power2.out",
          scrollTrigger: { trigger: h, start: "top 86%" },
        });
    });

    reveal(".kicker");
    reveal(".howrow", { stagger: 0.08 });
    reveal(".card", { y: 34, stagger: 0.1 });
    reveal(".exrow", { y: 18, stagger: 0.06 });
    reveal(".step", { stagger: 0.1 });
    reveal(".st", { y: 34, stagger: 0.1 });
    reveal(".vbul .b", { stagger: 0.1 });
    reveal(".msg", { y: 30, stagger: 0.12 });
    reveal(".member", { y: 34, stagger: 0.1 });
    reveal(".packrow .p", { y: 20, stagger: 0.08 });
    reveal(".form", {});
  });

  // Invisible marker; the component renders nothing meaningful itself.
  return <span ref={guard} hidden aria-hidden />;
}
