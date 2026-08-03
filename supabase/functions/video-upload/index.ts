import { AuthError, requireUser } from '../_shared/auth.ts'
import { createDirectUpload, isConfigured } from '../_shared/bunny.ts'
import { fail, handlePreflight, json } from '../_shared/cors.ts'
import { serviceClient } from '../_shared/db.ts'

/**
 * POST { title, description?, accessTier?, creditCost? }
 *   → { videoId, upload: { tusEndpoint, headers... } }
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
  try {
    const body = await req.json()
    title = String(body?.title ?? '').trim()
    description = body?.description ? String(body.description).slice(0, 5000) : null
    accessTier = ['free', 'premium', 'exclusive'].includes(body?.accessTier)
      ? body.accessTier
      : 'free'
    creditCost = Number.isInteger(body?.creditCost) ? body.creditCost : accessTier === 'premium' ? 1 : 0
    if (!title || title.length > 200) return fail(req, 'bad_request', 400)
    // The DB CHECK enforces tier<->cost too; validating here just gives a
    // 400 instead of a 500.
    const ok =
      (accessTier === 'free' && creditCost === 0) ||
      (accessTier === 'premium' && creditCost === 1) ||
      (accessTier === 'exclusive' && creditCost >= 2 && creditCost <= 5)
    if (!ok) return fail(req, 'bad_request', 400)
  } catch {
    return fail(req, 'bad_request', 400)
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
  const slug = `${slugBase}-${upload.guid.slice(0, 8)}`

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
    })
    .select('id')
    .single()
  if (vidErr) return fail(req, 'upload_row_failed', 500, vidErr.message)

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
