/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Keep pdf.js out of the server bundle so its runtime fake-worker import
  // resolves against node_modules (server-side PDF text extraction).
  experimental: {
    serverComponentsExternalPackages: ["pdfjs-dist"],
  },
};
module.exports = nextConfig;
