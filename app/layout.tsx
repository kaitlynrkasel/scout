import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Scout — AI Outreach Engine",
  description:
    "Find the right people, get their contacts, and draft personalized outreach in your voice.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
