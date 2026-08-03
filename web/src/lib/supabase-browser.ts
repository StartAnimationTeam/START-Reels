'use client'

import { useSession } from '@clerk/nextjs'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { useMemo } from 'react'

import type { Database } from './database.types'

/**
 * RLS-scoped Supabase client for Client Components.
 *
 * Same contract as the server version: the `accessToken` callback supplies the
 * Clerk JWT, and RLS policies read it via `auth.jwt()->>'sub'`. Without it,
 * reads silently return empty rather than failing — see supabase-server.ts.
 *
 * Prefer Server Components for reads. Reach for this only where the browser
 * genuinely needs to re-query without a navigation: search-as-you-type,
 * infinite scroll, optimistic favorites.
 */
export function useSupabase(): SupabaseClient<Database> | null {
  const { session } = useSession()

  return useMemo(() => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    if (!url || !key) return null

    return createClient<Database>(url, key, {
      accessToken: async () => (await session?.getToken()) ?? null,
      auth: { persistSession: false, autoRefreshToken: false },
    })
  }, [session])
}
