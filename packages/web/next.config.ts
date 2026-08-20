import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // Trims the Docker runner image to only the files the server actually needs (P2-10) instead of
  // shipping the full node_modules tree. Root points at the monorepo root, not this package,
  // because packages/core is a sibling workspace whose compiled `dist/` the traced server.js must
  // be able to resolve — the default project-root tracing would miss it entirely.
  output: 'standalone',
  outputFileTracingRoot: path.join(__dirname, '../../'),
  serverExternalPackages: ['better-sqlite3', 'nodemailer'],
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          // RuleBeat has destructive admin actions behind plain buttons (delete a dashboard,
          // remove a user), so framing it is worth denying outright — nothing here is meant to
          // be embedded.
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          // Findings URLs carry subscription ids and resource names in query params. Send them
          // to same-origin requests only, never to an external site in a Referer header.
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
  async redirects() {
    return [
      { source: '/categories/:slug', destination: '/scans?category=:slug', permanent: false },
      { source: '/findings', destination: '/scans?category=all&tab=results', permanent: false },
    ];
  },
};

export default nextConfig;
