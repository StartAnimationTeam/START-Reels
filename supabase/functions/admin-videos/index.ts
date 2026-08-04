import { AuthError } from '../_shared/auth.ts'
import { audit, requireStaffContext } from '../_shared/admin.ts'
import { deleteVideo, isConfigured } from '../_shared/bunny.ts'
import { fail, handlePreflight, json } from '../_shared/cors.ts'
import { serviceClient } from '../_shared/db.ts'

/**
 * POST { action, videoId, ... } — video administration.
 *
 *   update_meta   title / description / tier+cost (moderator+)
 *   set_featured  featured flag + rank            (moderator+)
 *   publish       processing|pending_review|rejected → published (moderator+)
 *   reject        → rejected, with reason         (moderator+)
 *   remove        → removed + REVOKE-AND-REFUND   (administrator)
 *
 * `remove` is the one that touches money: revoke_video_entitlements reverses
 * pending holds and refunds committed spends (CLAUDE.md trap #13 — deleting a
 * paid video must never silently destroy access people paid for). It is
 * admin-only for exactly that reason.
 *
 * The tier<->cost CHECK constraint is the real validator for update_meta —
 * this function just turns its violation into a 400 instead of a 500.
 */

interface Body {
  action?: string
  videoId?: string
  title?: string
  description?: string
  accessTier?: 'free' | 'premium' | 'exclusive'
  creditCost?: number
  featured?: boolean
  rank?: number
  reason?: string
  episodeNumber?: number
}

Deno.serve(async (req) => {
  const preflight = handlePreflight(req)
  if (preflight) return preflight
  if (req.method !== 'POST') return fail(req, 'method_not_allowed', 405)

  const db = serviceClient()

  let ctx
  try {
    ctx = await requireStaffContext(req, db)
  } catch (err) {
    const code = err instanceof AuthError ? err.code : 'unauthorized'
    return fail(req, code, code === 'forbidden' ? 403 : 401)
  }

  let body: Body
  try {
    body = await req.json()
  } catch {
    return fail(req, 'bad_request', 400)
  }

  const videoId = body.videoId
  if (typeof videoId !== 'string' || !/^[0-9a-f-]{36}$/.test(videoId)) {
    return fail(req, 'bad_request', 400)
  }

  const { data: before } = await db
    .from('videos')
    .select('id, title, description, status, access_tier, credit_cost, is_featured, featured_rank, provider_asset_id, duration_seconds')
    .eq('id', videoId)
    .maybeSingle()
  if (!before) return fail(req, 'not_found', 404)

  const patch: Record<string, unknown> = {}
  let auditAction = ''
  let refunded: number | null = null

  switch (body.action) {
    case 'update_meta': {
      if (typeof body.title === 'string' && body.title.trim()) patch.title = body.title.trim().slice(0, 200)
      if (typeof body.description === 'string') patch.description = body.description.slice(0, 5000)
      // Renumbering an episode: the partial unique index referees a taken
      // slot (translated to 409 below). Free-window pricing follows the
      // NUMBER, so unlock_video resolves the new position automatically.
      if (Number.isInteger(body.episodeNumber) && body.episodeNumber! >= 1) {
        patch.episode_number = body.episodeNumber
      }
      if (body.accessTier) {
        patch.access_tier = body.accessTier
        patch.credit_cost =
          typeof body.creditCost === 'number' ? body.creditCost
          : body.accessTier === 'premium' ? 1
          : body.accessTier === 'free' ? 0
          : before.credit_cost
      }
      auditAction = 'video.update_meta'
      break
    }
    case 'set_featured': {
      patch.is_featured = body.featured === true
      patch.featured_rank = body.featured === true ? (Number.isInteger(body.rank) ? body.rank : 100) : null
      auditAction = 'video.set_featured'
      break
    }
    case 'publish': {
      if (!before.provider_asset_id || !before.duration_seconds) {
        // Publishing a video with no playable asset produces a card that
        // 409s on every play — refuse rather than let the catalog lie.
        return fail(req, 'video_not_ready', 409)
      }
      patch.status = 'published'
      patch.published_at = new Date().toISOString()
      patch.rejection_reason = null
      auditAction = 'video.publish'
      break
    }
    case 'reject': {
      patch.status = 'rejected'
      patch.rejection_reason = (body.reason ?? 'rejected').slice(0, 500)
      auditAction = 'video.reject'
      break
    }
    case 'remove': {
      if (!ctx.isAdmin) return fail(req, 'forbidden', 403)
      const { data: revoked, error: revokeErr } = await db.rpc('revoke_video_entitlements', {
        p_video_id: videoId,
        p_reason: (body.reason ?? 'removed_by_admin').slice(0, 200),
      })
      if (revokeErr) return fail(req, 'revoke_failed', 500, revokeErr.message)
      refunded = revoked as number
      patch.status = 'removed'
      patch.deleted_at = new Date().toISOString()
      auditAction = 'video.remove'
      break
    }
    default:
      return fail(req, 'bad_request', 400)
  }

  const { data: after, error: updateErr } = await db
    .from('videos')
    .update(patch)
    .eq('id', videoId)
    .select('id, title, status, access_tier, credit_cost, is_featured, featured_rank')
    .single()

  if (updateErr) {
    // 23514 = check_violation: the tier<->cost invariant said no.
    if (updateErr.code === '23514') return fail(req, 'bad_request', 400, 'tier_cost_mismatch')
    // 23505 on the (series, episode) index: that number is already taken.
    if (updateErr.code === '23505' && updateErr.message.includes('videos_series_episode_idx')) {
      return fail(req, 'episode_number_taken', 409)
    }
    return fail(req, 'update_failed', 500, updateErr.message)
  }

  // Removal also deletes the Bunny OBJECT — stored GB bills forever
  // otherwise (trap #1). After the refunds and the row update, best-effort:
  // a Bunny hiccup must not undo a completed removal, and the soft-deleted
  // row keeps its GUID so an orphan stays findable.
  let bunnyDeleted: boolean | null = null
  if (body.action === 'remove' && before.provider_asset_id && isConfigured()) {
    try {
      bunnyDeleted = await deleteVideo(before.provider_asset_id)
    } catch {
      bunnyDeleted = false
    }
  }

  const { provider_asset_id: _guid, ...beforeSafe } = before
  await audit(db, ctx.userId, auditAction, 'video', videoId, beforeSafe, {
    ...after,
    ...(refunded !== null ? { entitlements_revoked: refunded } : {}),
    ...(bunnyDeleted !== null ? { bunny_deleted: bunnyDeleted } : {}),
  })

  return json(req, {
    ok: true,
    video: after,
    ...(refunded !== null ? { entitlements_revoked: refunded } : {}),
    ...(bunnyDeleted !== null ? { bunny_deleted: bunnyDeleted } : {}),
  })
})
