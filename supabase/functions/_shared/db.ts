import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'

/**
 * Service-role Supabase client.
 *
 * SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are auto-injected by the platform.
 * Do NOT add them to supabase/.env — Supabase rejects any secret name starting
 * with `SUPABASE_`, and the deploy fails with a message that does not explain
 * why.
 *
 * This client BYPASSES RLS. It belongs only in functions that move value or
 * state. Anything the user merely looks at should be read from a Server
 * Component through the RLS-scoped client instead — see
 * web/src/lib/supabase-server.ts.
 */
export function serviceClient(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL')
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

  if (!url || !key) {
    throw new Error(
      'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing. These are injected by ' +
        'the platform; if they are absent the function is running outside Supabase.',
    )
  }

  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}
