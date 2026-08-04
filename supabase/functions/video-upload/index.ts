import { AuthError, requireUser } from '../_shared/auth.ts'
import { createDirectUpload, deleteVideo, isConfigured } from '../_shared/bunny.ts'
import { fail, handlePreflight, json } from '../_shared/cors.ts'
import { serviceClient } from '../_shared/db.ts'

/**
 * POST { title, description?, accessTier?, creditCost?, seriesId?, episodeNumber? }
 *   → { videoId, episodeNumber?, upload: { tusEndpoint, headers... } }
 *
 * With seriesId the upload is an EPISODE: the caller must own the series (or
 * be staff), the episode number must be free (409 episode_number_taken) or is
 * auto-assigned max+1, and tier/cost become a DISPLAY SNAPSHOT of the
 * series-resolved price — the series is the economic truth (0019).
 *
 * Mints a video row + a Bunny TUS authorization so the BROWSER uploads
 * straight to Bunny. Video bytes never pass through Vercel or Supabase —
 * a 2 GB file through a serverless body is impossible, not merely slow
 * (CLAUDE.md trap #5). TUS also means a dropped connection resumes.
 *
 * Who may upload (Phase 2 slice): administrators and creators.
 *   admin/moderator upload → row goes straight to 'uploading' → 'published'
 *   creator upload         → same, but review flow lands in Phase 5; until
 *                            then creators upload as trusted staff would.
 *
 * The order of writes is the upload_sessions rule: Bunny object first, then
 * OUR row pointing at it, and only then does the browser get the token. A
 * stale pending session = an upload started and abandoned.
 *
 * Size/duration caps: Bunny's TUS flow doesn't take a byte cap up front, so
 * max_upload_bytes is enforced CLIENT-side for UX and the duration cap is
 * enforced after encoding by bunny-webhook comparing against
 * platform_settings — an over-long upload gets rejected, not published.
 */
Deno.serve(async (req) => {
  const preflight = handlePreflight(req)
  if (preflight) return preflight
  if (req.method !== 'POST') return fail(req, 'method_not_allowed', 405)
  if (!isConfigured()) return fail(req, 'bunny_not_configured', 503)

  let userId: string
  try {
    userId = await requireUser(req)
  } catch (err) {
    return fail(req, err instanceof AuthError ? err.code : 'unauthorized', 401)
  }

  const db = serviceClient()

  // Role check server-side, against OUR table.
  const { data: roles } = await db
    .from('user_roles')
    .select('role')
    .eq('user_id', userId)
  const held = (roles ?? []).map((r: { role: string }) => r.role)
  const mayUpload =
    held.includes('administrator') || held.includes('moderator') || held.includes('creator')
  if (!mayUpload) return fail(req, 'forbidden', 403)

  let title: string
  let description: string | null
  let accessTier: 'free' | 'premium' | 'exclusive'
  let creditCost: number
  let seriesId: string | null
  let episodeNumber: number | null
  try {
    const body = await req.json()
    title = String(body?.title ?? '').trim()
    description = body?.description ? String(body.description).slice(0, 5000) : null
    accessTier = ['free', 'premium', 'exclusive'].includes(body?.accessTier)
      ? body.accessTier
      : 'free'
    creditCost = Number.isInteger(body?.creditCost) ? body.creditCost : accessTier === 'premium' ? 1 : 0
    seriesId = typeof body?.seriesId === 'string' && body.seriesId ? body.seriesId : null
    episodeNumber =
      Number.isInteger(body?.episodeNumber) && body.episodeNumber >= 1 ? body.episodeNumber : null
    // Episodes may arrive UNTITLED: the series names them below —
    // "<series title> - EP<n>" — once the number is known. Standalone
    // uploads still need their own title.
    if ((!title && !seriesId) || title.length > 200) return fail(req, 'bad_request', 400)
    // The DB CHECK enforces tier<->cost too (0017 shape: free=0, paid 1..20);
    // validating here just gives a 400 instead of a 500.
    const ok =
      (accessTier === 'free' && creditCost === 0) ||
      (accessTier !== 'free' && creditCost >= 1 && creditCost <= 20)
    if (!ok) return fail(req, 'bad_request', 400)
  } catch {
    return fail(req, 'bad_request', 400)
  }

  // Episode uploads: resolve the series, its ownership and the number BEFORE
  // any Bunny object exists, so a refused request leaves nothing behind.
  let seriesSlug: string | null = null
  if (seriesId) {
    const { data: series } = await db
      .from('series')
      .select('id, slug, title, creator_id, status, deleted_at, free_episode_count, episode_credit_cost')
      .eq('id', seriesId)
      .maybeSingle()
    if (!series || series.deleted_at || series.status === 'removed') {
      return fail(req, 'not_found', 404)
    }
    const isStaff = held.includes('administrator') || held.includes('moderator')
    if (series.creator_id !== userId && !isStaff) return fail(req, 'forbidden', 403)

    const { data: maxRow } = await db
      .from('videos')
      .select('episode_number')
      .eq('series_id', seriesId)
      .is('deleted_at', null)
      .order('episode_number', { ascending: false })
      .limit(1)
      .maybeSingle()
    const nextFree = (maxRow?.episode_number ?? 0) + 1

    // A definitely-assigned local: the compiler cannot track the outer `let`
    // through the awaits below, and it's clearer anyway.
    const epNumber = episodeNumber ?? nextFree
    episodeNumber = epNumber
    if (epNumber < nextFree) {
      const { data: clash } = await db
        .from('videos')
        .select('id')
        .eq('series_id', seriesId)
        .eq('episode_number', epNumber)
        .is('deleted_at', null)
        .maybeSingle()
      if (clash) return fail(req, 'episode_number_taken', 409)
    }

    // Display snapshot of the series-resolved price; 0019 is the truth.
    if (epNumber <= series.free_episode_count || series.episode_credit_cost === 0) {
      accessTier = 'free'
      creditCost = 0
    } else {
      accessTier = 'premium'
      creditCost = series.episode_credit_cost
    }
    seriesSlug = series.slug

    // The series names its episodes: an untitled upload becomes
    // "<series title> - EP<n>". A caller-provided title still wins.
    if (!title) title = `${series.title} - EP${epNumber}`.slice(0, 200)
  }

  // 1. Bunny object first…
  let upload
  try {
    upload = await createDirectUpload(title)
  } catch (err) {
    return fail(req, 'upload_create_failed', 502, err instanceof Error ? err.message : undefined)
  }

  // 2. …then our row pointing at it…
  const slugBase = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'video'
  const slug = seriesSlug
    ? `${seriesSlug}-ep-${episodeNumber}-${upload.guid.slice(0, 8)}`
    : `${slugBase}-${upload.guid.slice(0, 8)}`

  const { data: video, error: vidErr } = await db
    .from('videos')
    .insert({
      title,
      slug,
      description,
      creator_id: userId,
      status: 'uploading',
      access_tier: accessTier,
      credit_cost: creditCost,
      provider: 'bunny_stream',
      provider_asset_id: upload.guid,
      series_id: seriesId,
      episode_number: seriesId ? episodeNumber : null,
    })
    .select('id')
    .single()
  if (vidErr) {
    // OUR row failed after the Bunny object was created — reap the object
    // or it becomes an unfindable orphan that bills forever (trap #1).
    await deleteVideo(upload.guid).catch(() => {})
    // Two racing uploads for the same slot: the partial unique index is the
    // referee; translate its verdict.
    if (vidErr.message.includes('videos_series_episode_idx')) {
      return fail(req, 'episode_number_taken', 409)
    }
    return fail(req, 'upload_row_failed', 500, vidErr.message)
  }

  const { data: settings } = await db
    .from('platform_settings')
    .select('key, value')
    .in('key', ['max_upload_bytes', 'max_upload_duration_seconds'])
  const setting = (k: string, d: number) =>
    Number(settings?.find((s: { key: string }) => s.key === k)?.value ?? d)

  await db.from('upload_sessions').insert({
    creator_id: userId,
    video_id: video.id,
    provider_upload_id: upload.guid,
    max_bytes: setting('max_upload_bytes', 5368709120),
    max_duration_seconds: setting('max_upload_duration_seconds', 7200),
    expires_at: new Date(upload.authorizationExpire * 1000).toISOString(),
  })

  // 3. …and only now the browser gets its token. TUS headers per Bunny docs:
  //    AuthorizationSignature / AuthorizationExpire / VideoId / LibraryId.
  return json(req, {
    videoId: video.id,
    episodeNumber: seriesId ? episodeNumber : undefined,
    title,
    upload: {
      tusEndpoint: upload.tusEndpoint,
      headers: {
        AuthorizationSignature: upload.authorizationSignature,
        AuthorizationExpire: upload.authorizationExpire,
        VideoId: upload.guid,
        LibraryId: upload.libraryId,
      },
      maxBytes: setting('max_upload_bytes', 5368709120),
    },
  })
})
