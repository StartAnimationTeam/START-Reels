import { auth } from '@clerk/nextjs/server'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

import type { Database } from './database.types'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

/**
 * RLS-scoped Supabase client for Server Components.
 *
 * The `accessToken` callback is the entire integration: it hands Supabase the
 * Clerk session JWT, Supabase validates it against Clerk's JWKS, and every
 * policy then sees the Clerk id at `auth.jwt()->>'sub'`.
 *
 * ── The trap this file exists to make visible ──────────────────────────────
 * If the Clerk↔Supabase third-party auth integration is NOT enabled in the
 * Supabase dashboard, or this callback is omitted, RLS does not error. Every
 * read just returns an EMPTY ARRAY. It looks like "this user has no data" and
 * it is actually "auth is broken." `scripts/test-rls.mjs` exists to catch that,
 * and Phase 0 is not complete until it passes.
 *
 * Use this for anything the user merely LOOKS AT — catalog, own history,
 * favorites, own balance. Anything that MOVES VALUE OR STATE (unlock, playback
 * token, settlement, moderation, admin) goes through an Edge Function with the
 * service role instead. That split is deliberate; do not collapse it.
 */
export async function createServerSupabase(): Promise<SupabaseClient<Database>> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error(
      'Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and ' +
        'NEXT_PUBLIC_SUPABASE_ANON_KEY in web/.env.local.',
    )
  }

  const { getToken } = await auth()

  return createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
    accessToken: async () => (await getToken()) ?? null,
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

/**
 * Anonymous client for genuinely public reads (the logged-out catalog).
 *
 * Carries no user token, so it sees exactly what the `anon` role's policies
 * allow — published videos and active categories, nothing else. Kept separate
 * from the function above so "this read is public" is a visible decision at the
 * call site rather than an accident of a missing session.
 */
export function createAnonSupabase(): SupabaseClient<Database> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('Supabase is not configured. See web/.env.local.example.')
  }

  return createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}
