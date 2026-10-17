import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import localFont from "next/font/local";
import "./globals.css";
import { Pwa } from "./pwa";
import { UpdateBanner } from "./UpdateBanner";

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

// Anton — the landing's loud, condensed poster face. Loaded app-wide as
// --font-anton so the dashboard's greeting headline and big stat numbers carry
// the same editorial punch as the landing hero.
const poster = localFont({
  variable: "--font-anton",
  display: "swap",
  src: [{ path: "./fonts/anton.woff2", weight: "400", style: "normal" }],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://scout-source.com"),
  title: "Scout | Find Your People",
  description:
    "Find the right people, get their contacts, and draft personalized outreach in your voice.",
  applicationName: "Scout",
  // Link previews: app/opengraph-image.png is picked up automatically by the
  // metadata route convention; these fill in the text halves of the card.
  openGraph: {
    title: "Scout | Find Your People",
    description:
      "Scout finds who to reach and writes the first note in your voice.",
    url: "https://scout-source.com",
    siteName: "Scout",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Scout | Find Your People",
    description:
      "Scout finds who to reach and writes the first note in your voice.",
  },
  // Installed to an iOS home screen, Scout launches without Safari's chrome and
  // draws its own title bar. "default" keeps the status bar legible on the cream
  // canvas; the tint itself is the theme-color below, kept in sync by <Pwa />.
  appleWebApp: {
    capable: true,
    title: "Scout",
    statusBarStyle: "default",
  },
};

// viewportFit: "cover" lets the layout reach under the notch and the home
// indicator; the chrome that sits there pads itself back out with
// env(safe-area-inset-*). Without it, installed iOS runs letterbox the app.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#f8f7f5",
};

// Apply the saved theme before first paint so dark mode doesn't flash light.
// Runs synchronously in <head>; reads the same key the Settings toggle writes.
const themeScript = `(function(){try{if(localStorage.getItem('scout_theme')==='dark'){document.documentElement.classList.add('dark');}}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${sans.variable} ${display.variable} ${poster.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        {children}
        <Pwa />
        <UpdateBanner />
      </body>
    </html>
  );
}
