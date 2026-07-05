import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

// Inter — a clean, neutral, highly legible UI sans in the spirit of Claude's
// interface (whose actual face, Styrene, is proprietary). Full weight range,
// self-hosted by next/font at build time.
const sans = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
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
    <html lang="en" className={sans.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
