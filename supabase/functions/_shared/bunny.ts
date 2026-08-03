/**
 * THE ONLY FILE THAT KNOWS BUNNY EXISTS.
 *
 * Everything else deals in `videos.provider_asset_id`. If the provider ever
 * changes, this file is the rewrite — deliberately three functions and not a
 * provider-adapter registry, because an interface describing capabilities the
 * product doesn't have is worse than no interface.
 *
 * Configuration (supabase/.env → `supabase secrets set`):
 *   BUNNY_STREAM_LIBRARY_ID     numeric video library id
 *   BUNNY_STREAM_API_KEY        library API key (uploads, metadata, stats)
 *   BUNNY_STREAM_TOKEN_KEY      the library's token-authentication key.
 *                               THIS KEY IS THE PAYWALL. Edge Functions only.
 *   BUNNY_CDN_HOSTNAME          e.g. vz-xxxxxxxx-xxx.b-cdn.net
 *
 * `isConfigured()` gates every caller: until the credentials exist (Phase 1
 * setup), playback endpoints return `bunny_not_configured` rather than
 * exploding — the credit/entitlement layer is fully testable without Bunny.
 *
 * VERIFY AGAINST CURRENT BUNNY DOCS when credentials arrive (CLAUDE.md trap
 * #2/#3): the token parameter names have changed historically, and the
 * webhook payload is unsigned — bunny-webhook must re-fetch by GUID, never
 * trust the body.
 */

const LIBRARY_ID = Deno.env.get('BUNNY_STREAM_LIBRARY_ID')
const API_KEY = Deno.env.get('BUNNY_STREAM_API_KEY')
const TOKEN_KEY = Deno.env.get('BUNNY_STREAM_TOKEN_KEY')
const CDN_HOSTNAME = Deno.env.get('BUNNY_CDN_HOSTNAME')

const API_BASE = 'https://video.bunnycdn.com/library'

export function isConfigured(): boolean {
  return Boolean(LIBRARY_ID && API_KEY && TOKEN_KEY && CDN_HOSTNAME)
}

async function api(path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${API_BASE}/${LIBRARY_ID}${path}`, {
    ...init,
    headers: {
      AccessKey: API_KEY!,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  if (!res.ok) {
    throw new Error(`bunny_api_error: ${res.status} ${await res.text()}`)
  }
  return res.status === 204 ? null : await res.json()
}

/**
 * Create the video object and mint TUS upload authorization.
 *
 * The video row exists in Bunny BEFORE any bytes move (mirroring our
 * upload_sessions rule), and the browser uploads straight to Bunny — video
 * bytes never pass through Vercel or Supabase (trap #5, the 4.5MB body wall).
 *
 * TUS endpoint: https://video.bunnycdn.com/tusupload with
 *   AuthorizationSignature = sha256hex(library_id + api_key + expiry + guid)
 */
export async function createDirectUpload(title: string): Promise<{
  guid: string
  tusEndpoint: string
  authorizationSignature: string
  authorizationExpire: number
  libraryId: string
}> {
  const created = (await api('/videos', {
    method: 'POST',
    body: JSON.stringify({ title }),
  })) as { guid: string }

  const expire = Math.floor(Date.now() / 1000) + 6 * 60 * 60 // 6h to finish a big upload
  const signature = await sha256Hex(`${LIBRARY_ID}${API_KEY}${expire}${created.guid}`)

  return {
    guid: created.guid,
    tusEndpoint: 'https://video.bunnycdn.com/tusupload',
    authorizationSignature: signature,
    authorizationExpire: expire,
    libraryId: LIBRARY_ID!,
  }
}

/**
 * Sign an HLS playback URL for one video, expiring after `ttlSeconds`.
 *
 * Path-scoped: the token covers `/{guid}/` as a PREFIX, so one token
 * authorizes the playlist AND every segment under it. Signing only the
 * manifest would leave the segments openly fetchable — the exact hole that
 * makes a paywall decorative (trap #2).
 *
 * Modern Bunny scheme (per BunnyWay/BunnyCDN.TokenAuthentication):
 *   token = "HS256-" + base64url( HMAC_SHA256( key,
 *             signaturePath + expires + ipBytes + signingData ) )
 * with signingData = sorted "k=v" params joined by "&" (raw values), and
 * ipBytes empty when not IP-locking (we don't — mobile clients change IP
 * mid-stream, plan §2).
 *
 * STATUS: pending live verification. The library currently has "Block direct
 * URL file access" enabled, which 403s every vz-* URL unconditionally — no
 * signature can succeed until that setting is flipped and CDN token auth is
 * enabled. scripts/test-ingest-live.mjs proves whichever scheme is live.
 */
export async function signPlaybackUrl(
  guid: string,
  ttlSeconds: number,
): Promise<{ url: string; expires: number }> {
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds
  const path = `/${guid}/`
  const signingData = `token_path=${path}`

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(TOKEN_KEY!),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${path}${expires}${signingData}`),
  )
  const token =
    'HS256-' +
    btoa(String.fromCharCode(...new Uint8Array(mac)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')

  return {
    url: `https://${CDN_HOSTNAME}/${guid}/playlist.m3u8?token=${token}&token_path=${encodeURIComponent(path)}&expires=${expires}`,
    expires,
  }
}

/** Fetch one video's state from Bunny — used by bunny-webhook to re-verify. */
export async function fetchVideo(guid: string): Promise<{
  guid: string
  status: number
  length: number
  thumbnailFileName: string | null
  availableResolutions: string | null
}> {
  return (await api(`/videos/${guid}`)) as {
    guid: string
    status: number
    length: number
    thumbnailFileName: string | null
    availableResolutions: string | null
  }
}

/** Bunny status codes → our video_status. */
export function mapBunnyStatus(status: number): 'processing' | 'ready' | 'failed' {
  // 0 queued, 1 processing, 2 encoding, 3 finished, 4 resolution finished,
  // 5 failed, 6 presigned upload started, 7 presigned upload finished
  if (status === 3 || status === 4) return 'ready'
  if (status === 5) return 'failed'
  return 'processing'
}

export function thumbnailUrl(guid: string, fileName: string | null): string | null {
  if (!fileName || !CDN_HOSTNAME) return null
  return `https://${CDN_HOSTNAME}/${guid}/${fileName}`
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
