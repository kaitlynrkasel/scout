"use client";

import { useEffect, useRef, useState } from "react";

/**
 * An editable combobox: a normal text input with a type-to-filter dropdown of
 * suggestions beneath it. Picking a suggestion fills the field, but the field
 * stays free-text, anything not in the list can still be typed. Keyboard:
 * ↑/↓ move the highlight, Enter selects it, Esc closes. Matches the app's input
 * styling so it drops in for a plain <input>.
 */
export default function ComboInput({
  value,
  onChange,
  options,
  placeholder,
  maxResults = 8,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder?: string;
  maxResults?: number;
}) {
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(-1);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const q = value.trim().toLowerCase();
  // Rank matches: whole-string prefix first, then substring, then token match
  // (every typed word is a prefix of some word in the option, so "univ cal"
  // finds "University of California"). Skip an exact match, nothing to suggest
  // once the field already equals a suggestion.
  const matches: string[] = [];
  if (q) {
    const tokens = q.split(/[\s,]+/).filter(Boolean);
    const scored: { o: string; s: number }[] = [];
    for (const o of options) {
      const lo = o.toLowerCase();
      if (lo === q) continue;
      let s = -1;
      if (lo.startsWith(q)) s = 0;
      else if (lo.includes(q)) s = 1;
      else {
        const words = lo.split(/[\s,]+/).filter(Boolean);
        if (tokens.every((t) => words.some((w) => w.startsWith(t)))) s = 2;
      }
      if (s >= 0) scored.push({ o, s });
    }
    scored.sort((a, b) => a.s - b.s || a.o.length - b.o.length);
    for (const { o } of scored.slice(0, maxResults)) matches.push(o);
  }
  const show = open && matches.length > 0;

  // Close when clicking outside.
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        setHi(-1);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  // Keep the highlighted option in view.
  useEffect(() => {
    if (!show || hi < 0) return;
    const el = listRef.current?.children[hi] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [hi, show]);

  const pick = (v: string) => {
    onChange(v);
    setOpen(false);
    setHi(-1);
  };

  return (
    <div ref={wrapRef} className="relative">
      <input
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setHi(-1);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            if (!show) setOpen(true);
            else setHi((h) => Math.min(h + 1, matches.length - 1));
          } else if (e.key === "ArrowUp") {
            if (!show) return;
            e.preventDefault();
            setHi((h) => Math.max(h - 1, 0));
          } else if (e.key === "Enter" && show && hi >= 0) {
            e.preventDefault();
            pick(matches[hi]);
          } else if (e.key === "Escape") {
            setOpen(false);
            setHi(-1);
          }
        }}
        placeholder={placeholder}
        role="combobox"
        aria-expanded={show}
        aria-autocomplete="list"
        autoComplete="off"
        className="w-full rounded-xl border border-warm-border px-3.5 py-3 text-sm text-ink outline-none transition focus:border-coral focus:ring-4 focus:ring-coral/15"
      />
      {show && (
        <ul
          ref={listRef}
          role="listbox"
          className="absolute z-30 mt-1.5 max-h-60 w-full overflow-auto rounded-xl border border-warm-border bg-surface py-1 shadow-float"
        >
          {matches.map((m, idx) => (
            <li
              key={m}
              role="option"
              aria-selected={idx === hi}
              onMouseEnter={() => setHi(idx)}
              // mousedown (not click) so selecting fires before the input blurs.
              onMouseDown={(e) => {
                e.preventDefault();
                pick(m);
              }}
              className={`cursor-pointer px-3.5 py-2 text-sm transition ${
                idx === hi ? "bg-warm-bg text-ink" : "text-body"
              }`}
            >
              {m}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
