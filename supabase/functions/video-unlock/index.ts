import { AuthError, requireUser } from '../_shared/auth.ts'
import { fail, handlePreflight, json } from '../_shared/cors.ts'
import { serviceClient } from '../_shared/db.ts'
import { maintenanceBlocks } from '../_shared/maintenance.ts'

/**
 * POST { videoId } → unlock (or return the existing entitlement).
 *
 * Thin on purpose. Every rule — idempotency, the advisory lock, tier pricing,
 * the suspended check, the reserve — lives in unlock_video() in the database,
 * because this is not its only caller and a rule in one HTTP handler is a rule
 * the others skip. This function only authenticates the user and translates
 * DB exceptions into stable error codes for lib/labels.ts.
 */
Deno.serve(async (req) => {
  const preflight = handlePreflight(req)
  if (preflight) return preflight
  if (req.method !== 'POST') return fail(req, 'method_not_allowed', 405)

  let userId: string
  try {
    userId = await requireUser(req)
  } catch (err) {
    return fail(req, err instanceof AuthError ? err.code : 'unauthorized', 401)
  }

  let videoId: string
  try {
    const body = await req.json()
    videoId = body?.videoId
    if (typeof videoId !== 'string' || !/^[0-9a-f-]{36}$/.test(videoId)) {
      return fail(req, 'bad_request', 400)
    }
  } catch {
    return fail(req, 'bad_request', 400)
  }

  const db = serviceClient()

  // 20 unlocks/min per user: generous for humans (idempotent re-unlocks are
  // cheap and common), hostile to scripted entitlement farming.
  const { data: allowed } = await db.rpc('check_rate_limit', {
    p_key: `unlock:${userId}`,
    p_limit: 20,
    p_window_seconds: 60,
  })
  if (allowed === false) return fail(req, 'rate_limited', 429)

  if (await maintenanceBlocks(db, userId)) {
    return fail(req, 'maintenance_mode', 503)
  }

  const { data, error } = await db.rpc('unlock_video', {
    p_user_id: userId,
    p_video_id: videoId,
  })

  if (error) {
    // DB exceptions arrive as "insufficient_credits: have 0, need 1" — strip
    // to the stable code; numbers and details never reach the client.
    const code = (error.message ?? '').split(':')[0].trim()
    const status =
      code === 'insufficient_credits' ? 402
      : code === 'not_found' ? 404
      : code === 'video_not_published' ? 404
      : code === 'account_suspended' ? 403
      : 500
    return fail(req, code || 'unlock_failed', status)
  }

  return json(req, data)
})
