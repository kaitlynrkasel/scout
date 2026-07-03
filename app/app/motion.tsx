"use client";

import { ElementType, useRef } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useGSAP } from "@gsap/react";

gsap.registerPlugin(ScrollTrigger, useGSAP);

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Reveal — fades and lifts its direct children into view with a small stagger the
 * first time the group scrolls into the viewport. Renders as `as` (default div)
 * so it can stand in for a section/grid without changing layout. Respects
 * prefers-reduced-motion (renders statically).
 */
export function Reveal({
  as,
  children,
  y = 18,
  stagger = 0.07,
  ...rest
}: {
  as?: ElementType;
  children: React.ReactNode;
  y?: number;
  stagger?: number;
  className?: string;
}) {
  const Tag = (as || "div") as ElementType;
  const ref = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      const el = ref.current;
      if (!el || prefersReducedMotion() || el.children.length === 0) return;
      gsap.from(el.children, {
        opacity: 0,
        y,
        duration: 0.5,
        stagger,
        ease: "power2.out",
        scrollTrigger: { trigger: el, start: "top 88%", once: true },
      });
    },
    { scope: ref },
  );

  return (
    <Tag ref={ref} {...rest}>
      {children}
    </Tag>
  );
}

/**
 * FadeIn — fades and lifts a single element in as one block when it scrolls into
 * view (no per-child stagger). Good for forms/cards where staggering fields would
 * feel gimmicky. Respects prefers-reduced-motion.
 */
export function FadeIn({
  as,
  children,
  y = 16,
  ...rest
}: {
  as?: ElementType;
  children: React.ReactNode;
  y?: number;
  className?: string;
}) {
  const Tag = (as || "div") as ElementType;
  const ref = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      const el = ref.current;
      if (!el || prefersReducedMotion()) return;
      gsap.from(el, {
        opacity: 0,
        y,
        duration: 0.5,
        ease: "power2.out",
        scrollTrigger: { trigger: el, start: "top 90%", once: true },
      });
    },
    { scope: ref },
  );

  return (
    <Tag ref={ref} {...rest}>
      {children}
    </Tag>
  );
}

/**
 * CountUp — animates a number from 0 to `value` once it scrolls into view.
 * Falls back to the final value immediately under reduced-motion.
 */
export function CountUp({
  value,
  suffix = "",
  className,
}: {
  value: number;
  suffix?: string;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);

  useGSAP(
    () => {
      const el = ref.current;
      if (!el) return;
      if (prefersReducedMotion()) {
        el.textContent = `${value}${suffix}`;
        return;
      }
      const obj = { v: 0 };
      gsap.to(obj, {
        v: value,
        duration: 0.9,
        ease: "power2.out",
        scrollTrigger: { trigger: el, start: "top 92%", once: true },
        onUpdate: () => {
          el.textContent = `${Math.round(obj.v)}${suffix}`;
        },
      });
    },
    { scope: ref, dependencies: [value, suffix] },
  );

  return (
    <span ref={ref} className={className}>
      {value}
      {suffix}
    </span>
  );
}
