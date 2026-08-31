import type { NextConfig } from "next";

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
};

export default nextConfig;
