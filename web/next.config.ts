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
}

export default nextConfig
