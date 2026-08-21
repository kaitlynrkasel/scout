import type { MetadataRoute } from "next";

// What crawlers may index. The app itself is a signed-in surface, so only the
// public pages are offered; /app, /admin, and the APIs are asked to stay out.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/app", "/admin", "/api/", "/auto/", "/readiness"],
      },
    ],
    sitemap: "https://scout-source.com/sitemap.xml",
  };
}
