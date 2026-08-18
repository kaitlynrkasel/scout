/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Keep pdf.js out of the server bundle so its runtime fake-worker import
  // resolves against node_modules (server-side PDF text extraction).
  experimental: {
    serverComponentsExternalPackages: ["pdfjs-dist"],
  },
  // Security headers on app pages. API routes are excluded: /api/site-preview
  // serves third-party HTML whose assets a page CSP would break, and the other
  // routes return JSON where these headers don't apply. The CSP allows inline
  // script/style (Next's hydration bootstrap needs it) but pins scripts to our
  // own origin, so injected external <script src> can't load, and locks
  // framing to ourselves (the preview iframes are same-origin routes).
  async headers() {
    return [
      {
        source: "/((?!api/).*)",
        headers: [
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob: https:",
              "font-src 'self' data:",
              "connect-src 'self' https://*.supabase.co",
              "frame-src 'self'",
              "frame-ancestors 'self'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join("; "),
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Permissions-Policy", value: "camera=(), geolocation=(), payment=()" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains",
          },
        ],
      },
    ];
  },
};
module.exports = nextConfig;
