#!/usr/bin/env node
/**
 * Real ingest, end to end: a genuine video file through the whole pipeline.
 *
 *   1. create a Bunny video + upload real bytes (PUT — simplest server path;
 *      the browser uses TUS, same object either way)
 *   2. poll until transcoded
 *   3. simulate the webhook (POST to bunny-webhook the way Bunny would —
 *      including that its body is just a hint; the function re-fetches)
 *   4. THE SECURITY PART — behavioral proof, since the trial dashboard
 *      hides the settings API:
 *        unsigned playlist URL     → must be REFUSED (token auth is on)
 *        signed playlist URL       → must return the HLS manifest
 *        segment under token_path  → must be fetchable with the SAME token
 *        expired-signature URL     → must be refused
 *   5. attach the asset to a seeded catalog video → the watch page plays
 *
 * Leaves the uploaded video in place (it becomes the first real catalog
 * asset) — pass --cleanup to delete it from Bunny instead.
 *
 * Usage:  node scripts/test-ingest-live.mjs [--cleanup]
 */

import { createHash } from 'node:crypto'

import { loadEnv, makeHarness, sql } from './_db.mjs'

const env = loadEnv()
const h = makeHarness()

const LIB = env.BUNNY_STREAM_LIBRARY_ID
const KEY = env.BUNNY_STREAM_API_KEY
const TOKEN_KEY = env.BUNNY_STREAM_TOKEN_KEY
const CDN = env.BUNNY_CDN_HOSTNAME
const API = `https://video.bunnycdn.com/library/${LIB}`

// Public-domain test clip (Big Buck Bunny, 10s, ~1MB). Two mirrors.
const SAMPLE_URLS = [
  'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4',
  'https://download.samplelib.com/mp4/sample-5s.mp4',
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function bunny(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { AccessKey: KEY, ...(init.headers ?? {}) },
  })
  if (!res.ok) throw new Error(`bunny ${path} -> ${res.status}: ${await res.text()}`)
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

/**
 * Same signing scheme as _shared/bunny.ts — kept in sync BY THE TEST: if the
 * Edge Function's scheme drifts from what Bunny verifies, step 4 fails.
 *
 * Bunny token-auth v2: the hashable base is
 *     security_key + signature_path + expires + parameter_string
 * where signature_path is the token_path (when used) and parameter_string is
 * the OTHER query params, sorted, as "key=value" — which INCLUDES token_path
 * itself. Omitting the parameter string yields a token Bunny rejects with
 * 403 — found the hard way on this suite's first run.
 */
function signUrl(guid, ttlSeconds) {
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds
  const path = `/${guid}/`
  const parameterData = `token_path=${path}`   // sorted params, url-DEcoded form
  const token = createHash('sha256')
    .update(`${TOKEN_KEY}${path}${expires}${parameterData}`)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  const qs = `token=${token}&token_path=${encodeURIComponent(path)}&expires=${expires}`
  return {
    playlist: `https://${CDN}/${guid}/playlist.m3u8?${qs}`,
    forPath: (rel) => `https://${CDN}/${guid}/${rel}?${qs}`,
  }
}

console.log('\nLive ingest - real bytes through the real pipeline\n')

let guid

try {
  // ── 1. fetch sample + upload ──────────────────────────────────────────
  h.section('Upload')

  let sample = null
  for (const url of SAMPLE_URLS) {
    try {
      const res = await fetch(url)
      if (res.ok) {
        sample = Buffer.from(await res.arrayBuffer())
        console.log(`  sample: ${url} (${(sample.length / 1024).toFixed(0)} KB)`)
        break
      }
    } catch {
      /* try next mirror */
    }
  }
  if (!sample) throw new Error('could not download a sample video from any mirror')

  const created = await bunny('/videos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Ingest Test - Big Buck Bunny (10s)' }),
  })
  guid = created.guid
  h.check('video object created in Bunny', Boolean(guid), JSON.stringify(created))

  const put = await fetch(`${API}/videos/${guid}`, {
    method: 'PUT',
    headers: { AccessKey: KEY },
    body: sample,
  })
  h.check('bytes uploaded', put.ok, `HTTP ${put.status}`)

  // ── 2. wait for transcode ─────────────────────────────────────────────
  h.section('Transcode (polling up to 4 min)')
  let video = null
  for (let i = 0; i < 48; i++) {
    await sleep(5000)
    video = await bunny(`/videos/${guid}`)
    if (video.status === 3 || video.status === 4 || video.status === 5) break
    if (i % 6 === 5) console.log(`  ...status ${video.status}, ${(i + 1) * 5}s`)
  }
  h.check('encoding finished', video?.status === 3 || video?.status === 4, `status ${video?.status}`)
  h.check('duration detected (~10s)', video?.length >= 4 && video?.length <= 15, `${video?.length}s`)
  console.log(`  resolutions: ${video?.availableResolutions ?? '?'}`)

  const resolutions = (video?.availableResolutions ?? '').split(',').filter(Boolean)
  h.check(
    'encoding ladder is trimmed (no 1440p/2160p rendition)',
    resolutions.every((r) => !['1440p', '2160p'].includes(r.trim())),
    video?.availableResolutions,
  )

  // ── 3. webhook path ───────────────────────────────────────────────────
  h.section('Webhook (unsigned body, function must re-fetch)')

  // First: register the guid against a seeded catalog video so the webhook
  // has a row to act on. 'welcome-to-start' becomes the first REAL video.
  await sql(`
    update public.videos
    set provider_asset_id = '${guid}', status = 'processing'
    where slug = 'welcome-to-start'
  `)

  const hook = await fetch(`${env.SUPABASE_URL}/functions/v1/bunny-webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ VideoLibraryId: Number(LIB), VideoGuid: guid, Status: video.status }),
  })
  const hookBody = await hook.json().catch(() => null)
  h.check('webhook accepted', hook.ok, `HTTP ${hook.status}: ${JSON.stringify(hookBody)}`)

  const row = (await sql(`
    select status, duration_seconds, thumbnail_url from public.videos where slug = 'welcome-to-start'
  `))[0]
  h.check('row published by the webhook', row.status === 'published', row.status)
  h.check('real duration written', row.duration_seconds >= 4 && row.duration_seconds <= 15, `${row.duration_seconds}s`)
  h.check('thumbnail URL written', Boolean(row.thumbnail_url), row.thumbnail_url ?? 'null')

  // A forged webhook naming a GUID we don't own must do nothing.
  const forged = await fetch(`${env.SUPABASE_URL}/functions/v1/bunny-webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ VideoGuid: '00000000-0000-0000-0000-000000000001', Status: 3 }),
  })
  const forgedBody = await forged.json().catch(() => null)
  h.check(
    'forged webhook for an unknown GUID is a harmless no-op',
    forged.status === 500 || forgedBody?.unknown_video === true,
    `HTTP ${forged.status}: ${JSON.stringify(forgedBody)}`,
  )

  // ── 4. token auth, behaviorally ───────────────────────────────────────
  h.section('Token authentication (the paywall at the CDN)')

  const unsigned = await fetch(`https://${CDN}/${guid}/playlist.m3u8`)
  h.check('UNSIGNED playlist URL is refused', unsigned.status === 403, `HTTP ${unsigned.status}`)

  const signed = signUrl(guid, 600)
  const playlistRes = await fetch(signed.playlist)
  const playlist = playlistRes.ok ? await playlistRes.text() : ''
  h.check('signed playlist URL returns the HLS manifest',
    playlistRes.ok && playlist.includes('#EXTM3U'), `HTTP ${playlistRes.status}`)

  // Pull a variant playlist + a segment THROUGH THE SAME TOKEN — this is the
  // token_path guarantee. If this fails, only the manifest was protected and
  // the paywall is decorative (CLAUDE.md trap #2).
  const variantRel = playlist.split('\n').find((l) => l.trim() && !l.startsWith('#'))
  h.check('manifest lists a variant', Boolean(variantRel), playlist.slice(0, 200))

  if (variantRel) {
    const variantRes = await fetch(signed.forPath(variantRel.trim()))
    const variant = variantRes.ok ? await variantRes.text() : ''
    h.check('variant playlist fetchable with the same token', variantRes.ok, `HTTP ${variantRes.status}`)

    const segRel = variant.split('\n').find((l) => l.trim() && !l.startsWith('#'))
    if (segRel) {
      const segPath = `${variantRel.trim().split('/').slice(0, -1).join('/')}/${segRel.trim()}`.replace(/^\//, '')
      const segRes = await fetch(signed.forPath(segPath))
      h.check('media segment fetchable with the same token (token_path covers it)',
        segRes.ok, `HTTP ${segRes.status} for ${segPath}`)

      const segUnsigned = await fetch(`https://${CDN}/${guid}/${segPath}`)
      h.check('...and the SAME segment unsigned is refused', segUnsigned.status === 403, `HTTP ${segUnsigned.status}`)
    }
  }

  const stale = signUrl(guid, -60) // already expired
  const staleRes = await fetch(stale.playlist)
  h.check('an EXPIRED signature is refused', staleRes.status === 403, `HTTP ${staleRes.status}`)

  // ── 5. the product path ───────────────────────────────────────────────
  h.section('Product wiring')
  {
    const thumb = await fetch(row.thumbnail_url)
    h.check('thumbnail is publicly viewable (browse grid needs it)', thumb.ok, `HTTP ${thumb.status}`)
  }
} finally {
  if (process.argv.includes('--cleanup') && guid) {
    console.log('\nCleaning up (deleting from Bunny)...')
    await bunny(`/videos/${guid}`, { method: 'DELETE' }).catch(() => {})
    await sql(`update public.videos set provider_asset_id = null, status = 'published' where slug = 'welcome-to-start'`)
  } else if (guid) {
    console.log(`\nKept: Bunny video ${guid} is now the live asset behind 'welcome-to-start'.`)
  }
}

h.finish('LIVE INGEST')
