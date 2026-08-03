import path from 'node:path'
import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  turbopack: {
    // There are two lockfiles — the repo root (Node scripts + Supabase CLI) and
    // web/ (the app). Turbopack infers the workspace root from the nearest one
    // and picked the repo root, which puts scripts/ and supabase/ inside the
    // watched tree. Pin it to web/ so the app's root is a decision rather than
    // an inference that changes if a lockfile moves.
    root: path.join(__dirname),
  },

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          // Clickjacking: nothing here belongs in an iframe — the paywall UI
          // least of all.
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          // No camera/mic/geolocation anywhere in this product.
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          // CSP note: a meaningful policy needs Clerk's, Supabase's and
          // Bunny's exact origins plus nonce plumbing through Next — done at
          // production-domain time (Phase 8 runbook), not as a localhost
          // wildcard that teaches nothing and breaks silently later.
        ],
      },
    ]
  },
}

export default nextConfig
