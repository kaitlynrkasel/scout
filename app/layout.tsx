import type { Metadata } from "next";
import { Inter } from "next/font/google";
import localFont from "next/font/local";
import "./globals.css";

// Inter, a clean, neutral, highly legible UI sans in the spirit of Claude's
// interface (whose actual face, Styrene, is proprietary). Full weight range,
// self-hosted by next/font at build time.
const sans = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

// Bricolage Grotesque — the landing page's display face. Loaded app-wide so the
// product UI shares the landing's editorial voice: big, tight-tracked headings
// over the Inter body. Applied to h1/h2/h3 + .font-display in globals.css.
const display = localFont({
  variable: "--font-display",
  display: "swap",
  src: [
    { path: "./fonts/bricolage-500.woff2", weight: "500", style: "normal" },
    { path: "./fonts/bricolage-700.woff2", weight: "700", style: "normal" },
  ],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://scout-source.com"),
  title: "Scout | Find Your People",
  description:
    "Find the right people, get their contacts, and draft personalized outreach in your voice.",
};

// Apply the saved theme before first paint so dark mode doesn't flash light.
// Runs synchronously in <head>; reads the same key the Settings toggle writes.
const themeScript = `(function(){try{if(localStorage.getItem('scout_theme')==='dark'){document.documentElement.classList.add('dark');}}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${display.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
