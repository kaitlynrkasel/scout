"use client";

import { useState, useEffect, useRef } from "react";

export function joinSpoken(prev: string, add: string): string {
  const a = String(prev || "");
  const b = String(add || "").trim();
  if (!b) return a;
  return (a && !/\s$/.test(a) ? a + " " : a) + b;
}

// Voice dictation button using the browser's built-in Web Speech API (no external
// service). Renders nothing on browsers that don't support it. Calls onAppend with
// each finalized phrase so the caller can add it to a text field.
export function MicButton({
  onAppend,
  className = "",
}: {
  onAppend: (text: string) => void;
  className?: string;
}) {
  const [listening, setListening] = useState(false);
  const [supported, setSupported] = useState(false);
  const recRef = useRef<any>(null);

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
    rec.interimResults = false; // append only finalized phrases, once each
    rec.lang = "en-US";
    rec.onresult = (e: any) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal && r[0]?.transcript) onAppend(r[0].transcript.trim());
      }
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recRef.current = rec;
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
          ? "border-coral bg-coral/10 text-accent"
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
