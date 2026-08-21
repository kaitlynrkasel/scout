import type { MetadataRoute } from "next";

// Only the pages a stranger should land on. The app is behind sign-in and has
// no business in a search index.
export default function sitemap(): MetadataRoute.Sitemap {
  const base = "https://scout-source.com";
  return [
    { url: `${base}/`, changeFrequency: "weekly", priority: 1 },
    { url: `${base}/privacy`, changeFrequency: "monthly", priority: 0.3 },
    { url: `${base}/terms`, changeFrequency: "monthly", priority: 0.3 },
  ];
}
