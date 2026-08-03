import { fetchVideo, isConfigured, mapBunnyStatus, thumbnailUrl } from '../_shared/bunny.ts'
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

  try {
    // ── the re-fetch: the only part of this we trust ─────────────────────
    const video = await fetchVideo(guid)
    const state = mapBunnyStatus(video.status)

    // Match by provider_asset_id. A GUID we don't know is fine — a test
    // upload from the dashboard, or a forged body naming a random GUID.
    const { data: row } = await db
      .from('videos')
      .select('id, status')
      .eq('provider_asset_id', guid)
      .maybeSingle()

    if (!row) {
      await complete(db, eventId)
      return json(req, { ok: true, unknown_video: true })
    }

    if (state === 'ready') {
      const thumb = thumbnailUrl(guid, video.thumbnailFileName)
      const patch: Record<string, unknown> = {
        duration_seconds: Math.round(video.length ?? 0),
        ...(thumb ? { thumbnail_url: thumb } : {}),
      }
      // Only lift TO published from the transcoding states. A video an admin
      // rejected or removed must not silently re-publish because Bunny
      // re-encoded a rendition.
      if (row.status === 'processing' || row.status === 'uploading') {
        patch.status = 'published'
        patch.published_at = new Date().toISOString()
      }
      await db.from('videos').update(patch).eq('id', row.id)
      await db
        .from('upload_sessions')
        .update({ status: 'completed' })
        .eq('provider_upload_id', guid)
        .eq('status', 'pending')
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
    return json(req, { ok: true, state })
  } catch (err) {
    await release(db, eventId, err)
    return fail(req, 'processing_failed', 500, err instanceof Error ? err.message : undefined)
  }
})
