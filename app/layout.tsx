import type { Metadata } from "next";
import localFont from "next/font/local";
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

// Young Serif — warm, field-guide display face used for headings only.
const youngSerif = localFont({
  src: [{ path: "./fonts/YoungSerif-Regular.ttf", weight: "400", style: "normal" }],
  variable: "--font-serif",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Scout — AI Outreach Engine",
  description:
    "Find the right people, get their contacts, and draft personalized outreach in your voice.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${youngSerif.variable}`}>
      <body>{children}</body>
    </html>
  );
}
