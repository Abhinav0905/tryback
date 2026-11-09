import type { NextConfig } from "next";

/**
 * Sent on every response (pages, API routes, static files). These override a header of the same
 * name set by a route handler, so stricter per-route values are re-applied by later rules below.
 */
const SECURITY_HEADERS = [
  // /demo frames /r from the same origin; nothing else may frame the app (clickjacking).
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // The shopper camera runs on this origin, also inside /demo's same-origin iframe
  // (allow="camera"); everything else that could reach a person's devices is off.
  { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=(), browsing-topics=()" },
  // Ignored over plain HTTP (local runs); on the deployed HTTPS URL it pins HTTPS.
  { key: "Strict-Transport-Security", value: "max-age=31536000" },
  // A hackathon demo with photos of people: keep it out of search results.
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
];

const nextConfig: NextConfig = {
  // Lets several local servers/builds coexist (e.g. NEXT_DIST_DIR=.next-rec). Default .next.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Self-contained server for the Docker image (docs/DEPLOY.md): <distDir>/standalone/server.js
  // plus the traced node_modules (sharp included). public/ and <distDir>/static are copied
  // next to it by the Dockerfile.
  output: "standalone",
  // The photo/render paths are built from TRYBACK_DATA_DIR at runtime, so the tracer
  // over-approximates and copies project images and data files into the standalone output.
  // Keep probe photos of people, local data, video output and raw catalogue sources out of it.
  // "**" (not "/*") so the key also matches the instrumentation entry, not just routes.
  outputFileTracingExcludes: {
    "**": ["./probe/**/*", "./out/**/*", "./assets-src/**/*", "./.data/**/*", "./.data-*/**/*", "./tests/**/*"],
  },
  poweredByHeader: false,
  // Classic (non-Cache-Components) rendering model: every page in this app is
  // request-time and most UI is client-side, so we keep the simpler semantics.
  serverExternalPackages: ["sharp"],
  async headers() {
    return [
      { source: "/:path*", headers: SECURITY_HEADERS },
      // Shopper photos: the route asks for no-referrer; keep it (the last matching rule wins).
      { source: "/api/photos/:path*", headers: [{ key: "Referrer-Policy", value: "no-referrer" }] },
    ];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
