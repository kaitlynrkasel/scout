"use client";

import { useEffect } from "react";

// Canvas colors behind the status bar when Scout runs installed (standalone).
// These are --c-cream in each theme; keep them in sync with globals.css.
const THEME_COLOR = { light: "#f8f7f5", dark: "#1c1915" };

/* Client-side bits that only matter once Scout is installed to a home screen:
 * registering the service worker, and keeping the status-bar tint in step with
 * the theme. Renders nothing. */
export function Pwa() {
  useEffect(() => {
    // The theme is a .dark class on <html> driven by localStorage, not by the
    // OS preference, so a media-query theme-color would guess wrong half the
    // time. Mirror the class instead, on every toggle.
    const root = document.documentElement;
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (meta) {
      const sync = () => {
        meta.content = root.classList.contains("dark")
          ? THEME_COLOR.dark
          : THEME_COLOR.light;
      };
      sync();
      const observer = new MutationObserver(sync);
      observer.observe(root, { attributes: true, attributeFilter: ["class"] });
      return () => observer.disconnect();
    }
  }, []);

  useEffect(() => {
    // Dev runs skip this: a cached shell from a previous session is a confusing
    // thing to debug against `next dev`.
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;
    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // An unavailable service worker costs offline support and nothing else,
        // so a failure here should never surface to the user.
      });
    };
    if (document.readyState === "complete") register();
    else {
      window.addEventListener("load", register);
      return () => window.removeEventListener("load", register);
    }
  }, []);

  return null;
}
