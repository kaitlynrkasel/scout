"use client";

import { useState, useEffect, useRef } from "react";

export function joinSpoken(prev: string, add: string): string {
  const a = String(prev || "");
  const b = String(add || "").trim();
  if (!b) return a;
  return (a && !/\s$/.test(a) ? a + " " : a) + b;
}

// Voice dictation button using the browser's built-in Web Speech API (no external
// service). Renders nothing on browsers that don't support it.
//
// The button drives the FIELD, not itself. It used to take an onAppend callback
// that fired only on finalized phrases, and painted the in-progress words into
// its own label beside the mic icon — so you watched your sentence form next to
// the button instead of in the box you were dictating into, and whatever hadn't
// finalized when recognition stopped was thrown away.
//
// Taking `value` + `onChange` instead fixes both. The committed text is held in
// baseRef; every result re-emits base + the live interim, so revisions from the
// speech engine replace cleanly rather than duplicating, the words appear in the
// field as you speak, and they are ordinary field text — they stay until you
// delete them.
export function MicButton({
  value,
  onChange,
  className = "",
  light = false,
}: {
  value: string;
  onChange: (next: string) => void;
  className?: string;
  // For dark grounds (the Scout stage): light strokes instead of the warm greys.
  light?: boolean;
}) {
  const [listening, setListening] = useState(false);
  const [supported, setSupported] = useState(false);
  const recRef = useRef<any>(null);
  // Text as it stood before the current phrase — finals are folded in here, and
  // the live interim is appended to it on every emit.
  const baseRef = useRef("");
  const interimRef = useRef("");
  // The field's current value, readable from inside the recognition callbacks
  // without making them stale.
  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const SR =
      typeof window !== "undefined" &&
      ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
    setSupported(!!SR);
    return () => {
      try {
        recRef.current?.stop();
      } catch {}
    };
  }, []);

  function start() {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return;
    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true; // live words while speaking, so it visibly works
    rec.lang = "en-US";
    rec.onresult = (e: any) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal && r[0]?.transcript) {
          baseRef.current = joinSpoken(baseRef.current, r[0].transcript.trim());
          interim = "";
        } else if (r[0]?.transcript) {
          interim += r[0].transcript;
        }
      }
      interimRef.current = interim.trim();
      // Always emit base + interim, never an append. The speech engine revises
      // interim results as it hears more, so appending would stack every draft
      // of the phrase on top of the last.
      onChangeRef.current(joinSpoken(baseRef.current, interimRef.current));
    };
    // Recognition stops on its own after a pause. Anything still interim at that
    // moment is real speech the user said, so it's committed rather than dropped.
    const settle = () => {
      if (interimRef.current) {
        baseRef.current = joinSpoken(baseRef.current, interimRef.current);
        interimRef.current = "";
        onChangeRef.current(baseRef.current);
      }
      setListening(false);
    };
    rec.onend = settle;
    rec.onerror = settle;
    recRef.current = rec;
    baseRef.current = valueRef.current || "";
    interimRef.current = "";
    try {
      rec.start();
      setListening(true);
    } catch {}
  }
  function stop() {
    try {
      recRef.current?.stop();
    } catch {}
    setListening(false);
  }

  if (!supported) return null;
  return (
    <button
      type="button"
      onClick={() => (listening ? stop() : start())}
      title={listening ? "Stop dictation" : "Dictate with your voice"}
      aria-label={listening ? "Stop dictation" : "Dictate with your voice"}
      aria-pressed={listening}
      className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-semibold transition ${
        listening
          ? light
            ? "border-white/60 bg-white/15 text-white"
            : "border-coral bg-coral/10 text-accent"
          : light
            ? "border-white/25 text-white/70 hover:bg-white/10 hover:text-white"
            : "border-warm-border text-body/70 hover:bg-warm-bg"
      } ${className}`}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={listening ? "animate-pulse" : ""}
      >
        <rect x="9" y="2" width="6" height="12" rx="3" />
        <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
      </svg>
      {listening ? "Listening…" : "Dictate"}
    </button>
  );
}
