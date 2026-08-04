import { AuthError, requireUser } from '../_shared/auth.ts'
import { audit } from '../_shared/admin.ts'
import { fail, handlePreflight, json } from '../_shared/cors.ts'
import { serviceClient } from '../_shared/db.ts'

/**
 * POST { action, ... } — series lifecycle. The one function that writes the
 * series table.
 *
 *   create_series   { title, synopsis?, freeEpisodeCount?, episodeCreditCost?,
 *                     isMembersOnly?, categoryIds?, tagIds? }     creator or staff
 *   update_series   { seriesId, ...same fields }   owner (while draft) or staff
 *   set_cover       { seriesId, imageBase64, contentType }        owner-draft/staff
 *   set_featured    { seriesId, featured, rank? }                 staff
 *   publish_series  { seriesId }                                  staff
 *   remove_series   { seriesId, reason? }                         ADMINISTRATOR
 *
 * Why not admin-videos: that function's contract is one videoId per action,
 * and its gate is requireStaffContext — creators must be able to assemble
 * their own drafts here without inheriting staff powers.
 *
 * remove_series is the money one (trap #14): every LIVE episode runs through
 * revoke_video_entitlements — pending holds reversed, committed spends
 * refunded — before the series row is marked removed. videos.series_id is
 * ON DELETE RESTRICT precisely so nothing can bypass this path.
 */

interface Body {
  action?: string
  seriesId?: string
  title?: string
  synopsis?: string
  freeEpisodeCount?: number
  episodeCreditCost?: number
  isMembersOnly?: boolean
  categoryIds?: string[]
  tagIds?: string[]
  imageBase64?: string
  contentType?: string
  featured?: boolean
  rank?: number
  reason?: string
}

const UUID = /^[0-9a-f-]{36}$/

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'series'
}

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

  const db = serviceClient()

  const { data: roleRows } = await db.from('user_roles').select('role').eq('user_id', userId)
  const roles = (roleRows ?? []).map((r: { role: string }) => r.role)
  const isAdmin = roles.includes('administrator')
  const isStaff = isAdmin || roles.includes('moderator')
  const isCreator = isStaff || roles.includes('creator')

  let body: Body
  try {
    body = await req.json()
  } catch {
    return fail(req, 'bad_request', 400)
  }

  // ── field validation shared by create/update ─────────────────────────
  const readPricing = () => {
    const free = body.freeEpisodeCount
    const cost = body.episodeCreditCost
    if (free !== undefined && (!Number.isInteger(free) || free < 0 || free > 500)) return null
    if (cost !== undefined && (!Number.isInteger(cost) || cost < 0 || cost > 20)) return null
    return { free, cost }
  }

  const writeJoins = async (seriesId: string) => {
    if (Array.isArray(body.categoryIds)) {
      const ids = body.categoryIds.filter((c) => UUID.test(String(c))).slice(0, 10)
      await db.from('series_categories').delete().eq('series_id', seriesId)
      if (ids.length) {
        await db.from('series_categories').insert(
          ids.map((category_id, i) => ({ series_id: seriesId, category_id, is_primary: i === 0 })),
        )
      }
    }
    if (Array.isArray(body.tagIds)) {
      const ids = body.tagIds.filter((t) => UUID.test(String(t))).slice(0, 12)
      await db.from('series_tags').delete().eq('series_id', seriesId)
      if (ids.length) {
        await db.from('series_tags').insert(ids.map((tag_id) => ({ series_id: seriesId, tag_id })))
      }
    }
  }

  // ── create_series ─────────────────────────────────────────────────────
  if (body.action === 'create_series') {
    if (!isCreator) return fail(req, 'forbidden', 403)
    const title = String(body.title ?? '').trim()
    if (!title || title.length > 200) return fail(req, 'bad_request', 400)
    const pricing = readPricing()
    if (!pricing) return fail(req, 'bad_request', 400)

    // Slug from the title; a collision gets a short random suffix rather
    // than an error — two shows may share a name.
    let slug = slugify(title)
    for (let attempt = 0; attempt < 3; attempt++) {
      const { data: created, error } = await db
        .from('series')
        .insert({
          slug,
          title,
          synopsis: body.synopsis ? String(body.synopsis).slice(0, 5000) : null,
          creator_id: userId,
          status: 'draft',
          free_episode_count: pricing.free ?? 3,
          episode_credit_cost: pricing.cost ?? 1,
          is_members_only: body.isMembersOnly === true,
        })
        .select('id, slug, title, status')
        .single()
      if (!error) {
        await writeJoins(created.id)
        await audit(db, userId, 'series.create', 'series', created.id, null, created)
        return json(req, { ok: true, series: created })
      }
      if (!error.message.includes('series_slug_key')) {
        return fail(req, 'update_failed', 500, error.message)
      }
      slug = `${slugify(title)}-${crypto.randomUUID().slice(0, 4)}`
    }
    return fail(req, 'update_failed', 500, 'slug_collision')
  }

  // ── everything else needs an existing series ─────────────────────────
  const seriesId = body.seriesId
  if (typeof seriesId !== 'string' || !UUID.test(seriesId)) return fail(req, 'bad_request', 400)

  const { data: before } = await db
    .from('series')
    .select('id, slug, title, synopsis, cover_url, creator_id, status, free_episode_count, episode_credit_cost, is_members_only, is_featured, featured_rank, total_episodes, deleted_at')
    .eq('id', seriesId)
    .maybeSingle()
  if (!before || before.deleted_at) return fail(req, 'not_found', 404)

  // Creators may shape their OWN series while it is a draft; once published,
  // changes go through staff (the moderation posture videos already have).
  const ownDraft = before.creator_id === userId && before.status === 'draft' && isCreator

  switch (body.action) {
    case 'update_series': {
      if (!isStaff && !ownDraft) return fail(req, 'forbidden', 403)
      const pricing = readPricing()
      if (!pricing) return fail(req, 'bad_request', 400)

      const patch: Record<string, unknown> = {}
      if (typeof body.title === 'string' && body.title.trim()) patch.title = body.title.trim().slice(0, 200)
      if (typeof body.synopsis === 'string') patch.synopsis = body.synopsis.slice(0, 5000)
      if (pricing.free !== undefined) patch.free_episode_count = pricing.free
      if (pricing.cost !== undefined) patch.episode_credit_cost = pricing.cost
      if (typeof body.isMembersOnly === 'boolean') patch.is_members_only = body.isMembersOnly

      const { data: after, error } = await db
        .from('series')
        .update(patch)
        .eq('id', seriesId)
        .select('id, slug, title, status, free_episode_count, episode_credit_cost, is_members_only')
        .single()
      if (error) return fail(req, 'update_failed', 500, error.message)

      await writeJoins(seriesId)
      await audit(db, userId, 'series.update', 'series', seriesId, before, after)
      return json(req, { ok: true, series: after })
    }

    case 'set_cover': {
      if (!isStaff && !ownDraft) return fail(req, 'forbidden', 403)
      const b64 = String(body.imageBase64 ?? '')
      const contentType = String(body.contentType ?? '')
      if (!/^image\/(jpeg|png|webp)$/.test(contentType)) return fail(req, 'bad_request', 400)
      // ~1MB decoded cap: covers are 9:16 posters, not masters.
      if (!b64 || b64.length > 1_400_000) return fail(req, 'upload_too_large', 413)

      let bytes: Uint8Array
      try {
        bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      } catch {
        return fail(req, 'bad_request', 400)
      }

      const ext = contentType === 'image/png' ? 'png' : contentType === 'image/webp' ? 'webp' : 'jpg'
      const path = `${seriesId}/cover-${Date.now()}.${ext}`
      const { error: upErr } = await db.storage
        .from('series-covers')
        .upload(path, bytes.buffer as ArrayBuffer, { contentType, upsert: false })
      if (upErr) return fail(req, 'upload_failed', 500, upErr.message)

      const { data: pub } = db.storage.from('series-covers').getPublicUrl(path)
      const { data: after, error } = await db
        .from('series')
        .update({ cover_url: pub.publicUrl })
        .eq('id', seriesId)
        .select('id, cover_url')
        .single()
      if (error) return fail(req, 'update_failed', 500, error.message)

      await audit(db, userId, 'series.set_cover', 'series', seriesId,
        { cover_url: before.cover_url }, after)
      return json(req, { ok: true, series: after })
    }

    case 'set_featured': {
      if (!isStaff) return fail(req, 'forbidden', 403)
      const { data: after, error } = await db
        .from('series')
        .update({
          is_featured: body.featured === true,
          featured_rank: body.featured === true ? (Number.isInteger(body.rank) ? body.rank : 100) : null,
        })
        .eq('id', seriesId)
        .select('id, is_featured, featured_rank')
        .single()
      if (error) return fail(req, 'update_failed', 500, error.message)
      await audit(db, userId, 'series.set_featured', 'series', seriesId, before, after)
      return json(req, { ok: true, series: after })
    }

    case 'publish_series': {
      if (!isStaff) return fail(req, 'forbidden', 403)
      // A series with zero published episodes is a card that 404s on tap —
      // refuse rather than let the catalog lie (the video_not_ready rule,
      // one level up).
      const { count } = await db
        .from('videos')
        .select('id', { count: 'exact', head: true })
        .eq('series_id', seriesId)
        .eq('status', 'published')
        .is('deleted_at', null)
      if (!count) return fail(req, 'series_not_ready', 409)

      const { data: after, error } = await db
        .from('series')
        .update({ status: 'published', published_at: before.status === 'published' ? undefined : new Date().toISOString() })
        .eq('id', seriesId)
        .select('id, slug, status, published_at, total_episodes')
        .single()
      if (error) return fail(req, 'update_failed', 500, error.message)
      await audit(db, userId, 'series.publish', 'series', seriesId, before, after)
      return json(req, { ok: true, series: after })
    }

    case 'remove_series': {
      if (!isAdmin) return fail(req, 'forbidden', 403)
      const reason = (body.reason ?? 'series_removed_by_admin').slice(0, 200)

      // Revoke-and-refund EVERY live episode before anything is marked
      // removed: a failure mid-loop leaves episodes still watchable rather
      // than paid-for-but-gone.
      const { data: episodes } = await db
        .from('videos')
        .select('id')
        .eq('series_id', seriesId)
        .is('deleted_at', null)
      let revoked = 0
      for (const ep of episodes ?? []) {
        const { data: n, error: revokeErr } = await db.rpc('revoke_video_entitlements', {
          p_video_id: ep.id,
          p_reason: reason,
        })
        if (revokeErr) return fail(req, 'revoke_failed', 500, revokeErr.message)
        revoked += (n as number) ?? 0
      }

      const now = new Date().toISOString()
      const { error: epErr } = await db
        .from('videos')
        .update({ status: 'removed', deleted_at: now })
        .eq('series_id', seriesId)
        .is('deleted_at', null)
      if (epErr) return fail(req, 'update_failed', 500, epErr.message)

      const { data: after, error } = await db
        .from('series')
        .update({ status: 'removed', deleted_at: now })
        .eq('id', seriesId)
        .select('id, status')
        .single()
      if (error) return fail(req, 'update_failed', 500, error.message)

      await audit(db, userId, 'series.remove', 'series', seriesId, before, {
        ...after,
        entitlements_revoked: revoked,
      })
      return json(req, { ok: true, series: after, entitlements_revoked: revoked })
    }

    default:
      return fail(req, 'bad_request', 400)
  }
})
