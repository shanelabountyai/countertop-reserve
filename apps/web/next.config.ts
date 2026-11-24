import type { NextConfig } from "next";

// Security headers on every response (scorecard K7 / SEC-05), the
// foundation's set. HSTS is inert over http (localhost) and enforced on the
// hosted demo. Framing is refused outright: nothing here is meant to be
// embedded, and the /host floor's cancel and assign buttons are exactly what
// clickjacking wants.
const securityHeaders = [
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  // The workspace packages ship TypeScript SOURCE, not a build output — that
  // is what keeps packages/core directly runnable by vitest and readable by
  // tsc. Next has to transpile them itself.
  transpilePackages: ["@reserve/core", "@reserve/db"],

  // Default Prisma client output (never a custom `output` path in
  // schema.prisma — see packages/db/prisma/schema.prisma). Naming the
  // package here means Turbopack never bundles it, which is what a custom
  // output path defeats: a bundled Prisma client cannot find its own query
  // engine at runtime, and that only fails on deploy, never locally. This is
  // inherited as a lesson, not a discovery — Countertop paid for it at C-045.
  serverExternalPackages: ["@prisma/client"],

  poweredByHeader: false,

  headers: async () => [
    { source: "/:path*", headers: securityHeaders },
    // The manage link (scorecard K6 / SEC-03). The token in the path is the
    // guest's whole credential: it must never leave in a Referer header, sit
    // in a shared cache, or be indexed. Listed last, so its Referrer-Policy
    // overrides the global one.
    {
      source: "/m/:path*",
      headers: [
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "X-Robots-Tag", value: "noindex, nofollow" },
        { key: "Cache-Control", value: "private, no-store, max-age=0" },
      ],
    },
  ],
};

export default nextConfig;
