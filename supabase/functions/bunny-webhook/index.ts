import { fetchVideo, isConfigured, mapBunnyStatus, signFileUrl } from '../_shared/bunny.ts'
import { fail, handlePreflight, json } from '../_shared/cors.ts'
import { serviceClient } from '../_shared/db.ts'
import { claim, complete, release } from '../_shared/webhooks.ts'

/**
 * Bunny Stream → video row sync.
 *
 * Bunny POSTs { VideoLibraryId, VideoGuid, Status } on encode progress.
 * THE PAYLOAD IS UNSIGNED (CLAUDE.md trap #3) — anyone who learns this URL
 * can POST anything. So the body is treated as nothing more than a hint:
 * we take the GUID, RE-FETCH the video from the Bunny API with our key, and
 * act on what Bunny actually says. A forged webhook can at worst make us
 * refresh a row with its own true state.
 *
 * Status flow on our side:
 *   ready  → duration, thumbnail, and status: processing → published
 *            (admin uploads publish directly; creator uploads in a later
 *            phase will land on pending_review instead)
 *   failed → status: draft + rejection_reason, upload session marked failed
 */

interface BunnyWebhookBody {
  VideoLibraryId?: number
  VideoGuid?: string
  Status?: number
}

Deno.serve(async (req) => {
  const preflight = handlePreflight(req)
  if (preflight) return preflight
  if (req.method !== 'POST') return fail(req, 'method_not_allowed', 405)
  if (!isConfigured()) return fail(req, 'bunny_not_configured', 500)

  let body: BunnyWebhookBody
  try {
    body = await req.json()
  } catch {
    return fail(req, 'bad_request', 400)
  }

  const guid = body?.VideoGuid
  if (typeof guid !== 'string' || !/^[0-9a-f-]{36}$/.test(guid)) {
    return fail(req, 'bad_request', 400)
  }

  // Idempotency key = guid + reported status: Bunny fires several webhooks per
  // video (queued → processing → finished); each distinct stage processes
  // once, and a redelivery of the same stage answers 200 without work.
  const eventId = `bunny:${guid}:${body?.Status ?? 'x'}`
  const db = serviceClient()

  let claimState: 'claimed' | 'already_processed'
  try {
    claimState = await claim(db, eventId, 'bunny', `status_${body?.Status}`)
  } catch (err) {
    return fail(req, 'claim_failed', 500, err instanceof Error ? err.message : undefined)
  }
  if (claimState === 'already_processed') return json(req, { ok: true, replay: true })

  let thumbDebugOut = 'n/a'
  try {
    // ── the re-fetch: the only part of this we trust ─────────────────────
    const video = await fetchVideo(guid)
    const state = mapBunnyStatus(video.status)

    // Match by provider_asset_id. A GUID we don't know is fine — a test
    // upload from the dashboard, or a forged body naming a random GUID.
    const { data: row } = await db
      .from('videos')
      .select('id, status, creator_id, series_id')
      .eq('provider_asset_id', guid)
      .maybeSingle()

    if (!row) {
      // RELEASE the claim rather than completing it. "Unknown" often means
      // "not attached yet": Bunny can deliver the encoded webhook before our
      // videos row points at the GUID (observed in practice — its delivery
      // raced our test's attach step). Completing would consume the event id
      // and make every later retry a skipped replay; releasing lets the next
      // delivery — or a manual re-trigger — converge once the row exists. A
      // genuinely foreign GUID just cycles claim/release harmlessly.
      await release(db, eventId, 'unknown_video_guid')
      return json(req, { ok: true, unknown_video: true })
    }

    if (state === 'ready') {
      // Re-host the thumbnail into Supabase Storage. The CDN original sits
      // behind token auth (everything on the pull zone does), so a plain
      // <img> in the browse grid would 403. Thumbnails are public marketing
      // surface — the catalog itself is public — so a public bucket is
      // correct, and it removes any expiring URL from catalog rows.
      let thumb: string | null = null
      let thumbDebug = 'no_filename'
      if (video.thumbnailFileName) {
        try {
          const signedThumb = await signFileUrl(guid, video.thumbnailFileName, 300)
          const res = await fetch(signedThumb)
          if (!res.ok) {
            thumbDebug = `cdn_fetch_${res.status}`
          } else {
            const bytes = new Uint8Array(await res.arrayBuffer())
            const path = `videos/${guid}.jpg`
            const up = await fetch(
              `${Deno.env.get('SUPABASE_URL')}/storage/v1/object/thumbnails/${path}`,
              {
                method: 'POST',
                headers: {
                  // The injected key is the NEW sb_secret_ format — not a JWT.
                  // As a Bearer it fails "Invalid Compact JWS"; it identifies
                  // the role through the apikey header instead. Same rule as
                  // PostgREST (scripts/test-rls.mjs learned it first).
                  apikey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
                  'Content-Type': 'image/jpeg',
                  'x-upsert': 'true',
                },
                body: bytes,
              },
            )
            if (!up.ok) {
              thumbDebug = `storage_${up.status}: ${(await up.text()).slice(0, 200)}`
            } else {
              thumb = `${Deno.env.get('SUPABASE_URL')}/storage/v1/object/public/thumbnails/${path}`
              thumbDebug = 'ok'
            }
          }
        } catch (thumbErr) {
          // A missing thumbnail must not fail the publish — the card renders
          // its placeholder and a later webhook retry can fill it in.
          thumbDebug = `threw: ${thumbErr instanceof Error ? thumbErr.message : String(thumbErr)}`
        }
      }

      thumbDebugOut = thumbDebug

      const patch: Record<string, unknown> = {
        duration_seconds: Math.round(video.length ?? 0),
        ...(thumb ? { thumbnail_url: thumb } : {}),
      }
      // Only lift OUT of the transcoding states. A video an admin rejected or
      // removed must not silently re-publish because Bunny re-encoded.
      //
      // Where it lands depends on WHO uploaded: staff uploads are trusted and
      // publish immediately; a creator's upload goes to pending_review for
      // the moderation queue. Checked here — at encode-complete — because
      // roles can change between upload and encode, and the decision should
      // reflect who they are when the video becomes real.
      if (row.status === 'processing' || row.status === 'uploading') {
        const { data: uploaderRoles } = await db
          .from('user_roles')
          .select('role')
          .eq('user_id', row.creator_id)
        const isStaff = (uploaderRoles ?? []).some(
          (r: { role: string }) => r.role === 'moderator' || r.role === 'administrator',
        )
        if (isStaff) {
          patch.status = 'published'
          patch.published_at = new Date().toISOString()
        } else {
          patch.status = 'pending_review'
        }
      }
      await db.from('videos').update(patch).eq('id', row.id)
      await db
        .from('upload_sessions')
        .update({ status: 'completed' })
        .eq('provider_upload_id', guid)
        .eq('status', 'pending')

      // The user-side thumbnail guarantee: a series with no cover borrows
      // this episode's thumbnail so its card never renders blank. FILL-IF-
      // NULL only — a real 9:16 poster set through series-manage is never
      // overwritten, and webhook retries stay idempotent for free.
      if (thumb && row.series_id) {
        await db
          .from('series')
          .update({ cover_url: thumb })
          .eq('id', row.series_id)
          .is('cover_url', null)
      }
    } else if (state === 'failed') {
      await db
        .from('videos')
        .update({ status: 'draft', rejection_reason: 'encoding_failed' })
        .eq('id', row.id)
      await db
        .from('upload_sessions')
        .update({ status: 'failed' })
        .eq('provider_upload_id', guid)
        .eq('status', 'pending')
    }
    // 'processing' → nothing to persist; the row is already in that state.

    await complete(db, eventId)
    return json(req, { ok: true, state, ...(state === 'ready' ? { thumb: thumbDebugOut } : {}) })
  } catch (err) {
    await release(db, eventId, err)
    return fail(req, 'processing_failed', 500, err instanceof Error ? err.message : undefined)
  }
})
