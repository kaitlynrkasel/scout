import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

// Outfit — geometric, contemporary sans. Loaded locally (no runtime font CDN)
// so the whole app renders the same typeface everywhere.
const outfit = localFont({
  src: [
    { path: "./fonts/Outfit-Regular.ttf", weight: "400", style: "normal" },
    { path: "./fonts/Outfit-Bold.ttf", weight: "700", style: "normal" },
  ],
  variable: "--font-outfit",
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
    <html lang="en" className={`${outfit.variable} ${youngSerif.variable}`}>
      <body>{children}</body>
    </html>
  );
}
