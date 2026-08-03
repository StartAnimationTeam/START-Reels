import { createRemoteJWKSet, jwtVerify } from 'npm:jose@5.9.6'

/**
 * Clerk JWT verification for Edge Functions.
 *
 * These functions set verify_jwt = false (the platform gate only understands
 * Supabase-issued JWTs), so THIS is the only authentication they have. Every
 * request must present a Clerk session token; we verify it against Clerk's
 * JWKS and extract the subject.
 *
 * The JWKS is fetched once per isolate and cached by jose — no per-request
 * round-trip to Clerk.
 */

const ISSUER = Deno.env.get('CLERK_ISSUER')

const jwks = ISSUER
  ? createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`))
  : null

export class AuthError extends Error {
  constructor(public code: string) {
    super(code)
  }
}

/** Returns the Clerk user id, or throws AuthError('unauthorized'). */
export async function requireUser(req: Request): Promise<string> {
  if (!ISSUER || !jwks) throw new AuthError('auth_not_configured')

  const header = req.headers.get('authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  if (!token) throw new AuthError('unauthorized')

  try {
    const { payload } = await jwtVerify(token, jwks, { issuer: ISSUER })
    const sub = payload.sub
    if (!sub) throw new AuthError('unauthorized')
    return sub
  } catch {
    throw new AuthError('unauthorized')
  }
}

/**
 * SHA-256 of the caller's IP, for watch_sessions.ip_hash.
 * The raw IP is never stored — the hash is enough for "same client?" checks
 * and abuse correlation without keeping PII in a table that lives forever.
 */
export async function ipHash(req: Request): Promise<string | null> {
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('cf-connecting-ip')
  if (!ip) return null
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip))
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32)
}
