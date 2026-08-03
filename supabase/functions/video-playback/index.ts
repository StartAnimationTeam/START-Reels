import { AuthError, ipHash, requireUser } from '../_shared/auth.ts'
import { isConfigured, signPlaybackUrl } from '../_shared/bunny.ts'
import { fail, handlePreflight, json } from '../_shared/cors.ts'
import { serviceClient } from '../_shared/db.ts'

/**
 * POST { videoId } → { url, sessionId, expires }
 *
 * The hottest path in the product, and the one the paywall hangs off:
 *
 *   verify Clerk JWT
 *     → find a LIVE entitlement (none → 402 needs_unlock)
 *     → start a watch session (cap enforced in the DB → 429 too_many_streams)
 *     → sign a path-scoped Bunny URL, TTL = video duration + grace
 *
 * `provider_asset_id` is read here with the service role and leaves this
 * function only INSIDE the signed URL. There is no unsigned URL to leak,
 * because there is no unsigned URL.
 *
 * The signed URL is a bearer token, not DRM: within its TTL, whoever holds it
 * can play. Short TTL + per-request minting behind the entitlement check + the
 * session cap is the correct answer at this scale, and the docs say so out
 * loud (CLAUDE.md trap #16).
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
  let device: string | null
  try {
    const body = await req.json()
    videoId = body?.videoId
    device = typeof body?.device === 'string' ? body.device.slice(0, 40) : null
    if (typeof videoId !== 'string' || !/^[0-9a-f-]{36}$/.test(videoId)) {
      return fail(req, 'bad_request', 400)
    }
  } catch {
    return fail(req, 'bad_request', 400)
  }

  const db = serviceClient()

  // 1. Live entitlement, or 402. The client turns needs_unlock into the
  //    unlock gate — this response is the paywall speaking.
  const { data: ents, error: entErr } = await db
    .from('video_entitlements')
    .select('id, expires_at')
    .eq('user_id', userId)
    .eq('video_id', videoId)
    .is('revoked_at', null)
    .gt('expires_at', new Date().toISOString())
    .order('expires_at', { ascending: false })
    .limit(1)

  if (entErr) return fail(req, 'playback_failed', 500)
  const entitlement = ents?.[0]
  if (!entitlement) return fail(req, 'needs_unlock', 402)

  // 2. The video must still be playable and must have an asset.
  const { data: video } = await db
    .from('videos')
    .select('provider_asset_id, status, duration_seconds, deleted_at, creator_id')
    .eq('id', videoId)
    .maybeSingle()

  if (!video || video.deleted_at) return fail(req, 'not_found', 404)
  if (video.status !== 'published' && video.creator_id !== userId) {
    return fail(req, 'video_not_published', 404)
  }
  if (!video.provider_asset_id) return fail(req, 'video_not_ready', 409)

  // 3. Session before URL: the cap check must precede the grant, or the third
  //    tab gets a working URL and a 429 that means nothing.
  const { data: session, error: sessErr } = await db.rpc('start_watch_session', {
    p_user_id: userId,
    p_video_id: videoId,
    p_entitlement_id: entitlement.id,
    p_device: device,
    p_ip_hash: await ipHash(req),
  })

  if (sessErr) {
    const code = (sessErr.message ?? '').split(':')[0].trim()
    return fail(req, code || 'playback_failed', code === 'too_many_streams' ? 429 : code === 'needs_unlock' ? 402 : 500)
  }

  // 4. Sign. TTL = duration + grace, not 24h — a shared link dies within one
  //    viewing (trap #16).
  if (!isConfigured()) {
    // Bunny credentials not wired yet (pre-Phase-1-setup). Everything above —
    // the paywall — already ran for real; only the URL is missing.
    return fail(req, 'bunny_not_configured', 503)
  }

  const grace = 900 // playback_token_grace_seconds default; settings read is not worth a round-trip here
  const ttl = (video.duration_seconds ?? 3600) + grace
  const { url, expires } = await signPlaybackUrl(video.provider_asset_id, ttl)

  return json(req, {
    url,
    expires,
    sessionId: (session as { session_id: string }).session_id,
    durationSeconds: video.duration_seconds,
  })
})
