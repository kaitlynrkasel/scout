import type { MetadataRoute } from "next";

// Web app manifest — this is what lets Scout be installed to a phone's home
// screen and launch without browser chrome. Next serves it at
// /manifest.webmanifest and links it from every page automatically.
//
// Icons are generated from the one master mark at app/icon.png; regenerate them
// with scripts/generate-pwa-icons.py after replacing it.
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/app",
    name: "Scout — Find Your People",
    short_name: "Scout",
    description:
      "Find the right people, get their contacts, and draft personalized outreach in your voice.",
    // Launch straight into the product, not the marketing landing page. Scope
    // stays at the root so /privacy and /terms open in-app rather than kicking
    // the user out to a browser tab.
    start_url: "/app",
    scope: "/",
    display: "standalone",
    background_color: "#f8f7f5", // --c-cream, so the splash matches the canvas
    theme_color: "#f8f7f5",
    orientation: "any",
    categories: ["productivity", "business"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      // Inset copy for Android's adaptive shapes, which crop the edges.
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
