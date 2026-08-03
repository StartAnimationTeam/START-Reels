import { fail, handlePreflight, json } from '../_shared/cors.ts'
import { serviceClient } from '../_shared/db.ts'

/**
 * Manual/scheduled trigger for sweep_stale_holds().
 *
 * The primary schedule is pg_cron inside the database (0007), which needs no
 * HTTP at all. This endpoint exists for ops — "run the sweep now" during an
 * incident, or an external scheduler if pg_cron is ever unavailable.
 *
 * Guarded by a shared secret rather than a user JWT: no user may trigger a
 * sweep, and the service key must never leave the server side. Set
 * SWEEP_TRIGGER_SECRET in the function secrets; absent, the endpoint refuses
 * everything (fail closed, same rule as the webhook).
 */
Deno.serve(async (req) => {
  const preflight = handlePreflight(req)
  if (preflight) return preflight
  if (req.method !== 'POST') return fail(req, 'method_not_allowed', 405)

  const secret = Deno.env.get('SWEEP_TRIGGER_SECRET')
  if (!secret) return fail(req, 'sweep_not_configured', 500)

  const presented = req.headers.get('x-sweep-secret')
  if (!presented || presented !== secret) return fail(req, 'unauthorized', 401)

  const db = serviceClient()
  const { data, error } = await db.rpc('sweep_stale_holds')
  if (error) return fail(req, 'sweep_failed', 500, error.message)

  return json(req, data)
})
