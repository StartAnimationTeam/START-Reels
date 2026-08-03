import { AuthError, requireUser } from '../_shared/auth.ts'
import { corsHeaders, fail, handlePreflight, json } from '../_shared/cors.ts'
import { serviceClient } from '../_shared/db.ts'

/**
 * POST { sessionId, seconds, position, ended? } → { credited, settled, ... }
 *
 * Fired every 15s by useHeartbeat, plus a final navigator.sendBeacon on
 * pagehide. All validation — wall-clock clamping, the forward-position rule,
 * the length cap, settle-at-30s — is in record_heartbeat() in the database.
 * The client's numbers are CLAIMS; nothing here trusts them.
 *
 * sendBeacon caveat: beacons send Content-Type text/plain and CANNOT carry an
 * Authorization header. So a beacon-shaped request (no auth header) is
 * accepted ONLY for `ended: true` with a valid session UUID — closing a
 * session early is the one thing an attacker could do with it, and that is
 * harmless (it stops crediting sooner). Anything that CREDITS time still
 * requires the JWT.
 */
Deno.serve(async (req) => {
  const preflight = handlePreflight(req)
  if (preflight) return preflight
  if (req.method !== 'POST') return fail(req, 'method_not_allowed', 405)

  let body: { sessionId?: string; seconds?: number; position?: number; ended?: boolean }
  try {
    body = await req.json()
  } catch {
    return fail(req, 'bad_request', 400)
  }

  const sessionId = body?.sessionId
  if (typeof sessionId !== 'string' || !/^[0-9a-f-]{36}$/.test(sessionId)) {
    return fail(req, 'bad_request', 400)
  }

  const db = serviceClient()

  let userId: string | null = null
  try {
    userId = await requireUser(req)
  } catch (err) {
    if (!(err instanceof AuthError)) return fail(req, 'unauthorized', 401)
    // No JWT. Beacon path: allowed only to CLOSE a session, never to credit.
    if (body?.ended === true) {
      const { data: session } = await db
        .from('watch_sessions')
        .select('user_id')
        .eq('id', sessionId)
        .maybeSingle()
      if (!session) return fail(req, 'not_found', 404)

      await db.rpc('record_heartbeat', {
        p_user_id: session.user_id,
        p_session_id: sessionId,
        p_claimed_seconds: 0,          // a beacon without auth credits NOTHING
        p_position_seconds: typeof body?.position === 'number' ? Math.floor(body.position) : null,
        p_ended: true,
      })
      return new Response(null, { status: 204, headers: corsHeaders(req) })
    }
    return fail(req, 'unauthorized', 401)
  }

  const seconds = Number.isFinite(body?.seconds) ? Math.floor(body!.seconds!) : 0
  const position = Number.isFinite(body?.position) ? Math.floor(body!.position!) : null

  const { data, error } = await db.rpc('record_heartbeat', {
    p_user_id: userId,
    p_session_id: sessionId,
    p_claimed_seconds: seconds,
    p_position_seconds: position,
    p_ended: body?.ended === true,
  })

  if (error) {
    const code = (error.message ?? '').split(':')[0].trim()
    return fail(req, code || 'heartbeat_failed', code === 'not_found' ? 404 : 500)
  }

  return json(req, data)
})
