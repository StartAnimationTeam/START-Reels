import { fail, handlePreflight, json } from '../_shared/cors.ts'
import { serviceClient } from '../_shared/db.ts'

/**
 * GET — Google rewarded-ad Server-Side Verification (the NATIVE AdMob door
 * of the rewarded-ad rail), plus a secret-gated test rail so the whole
 * coin pipeline is provable before any Google account exists.
 *
 * Google's callback: query params ending in &signature=…&key_id=…; the
 * signed content is the RAW (still percent-encoded) query string up to but
 * excluding "&signature=". Signature is ECDSA-SHA256, DER-encoded,
 * websafe-base64. Verifier keys come from gstatic (cache ≤24h; on an
 * unknown key_id, refetch once before rejecting — keys rotate).
 *
 * Response discipline (trap #10 in spirit): a VALID callback always gets
 * 200 — granted, duplicate, capped or disabled alike — because Google
 * retries non-2xx up to 5 times and a capped user must not turn into a
 * retry storm. Only bad crypto earns a 403.
 */

const DEFAULT_KEYS_URL = 'https://www.gstatic.com/admob/reward/verifier-keys.json'
const KEY_TTL_MS = 24 * 60 * 60 * 1000

interface VerifierKey {
  keyId: number
  base64: string // SPKI, standard base64
}

let keyCache: { fetchedAt: number; byId: Map<number, CryptoKey> } | null = null

async function loadKeys(force = false): Promise<Map<number, CryptoKey>> {
  if (!force && keyCache && Date.now() - keyCache.fetchedAt < KEY_TTL_MS) {
    return keyCache.byId
  }
  const url = Deno.env.get('SSV_KEYS_URL') ?? DEFAULT_KEYS_URL
  const res = await fetch(url)
  if (!res.ok) throw new Error(`ssv_keys_fetch_failed: ${res.status}`)
  const body = (await res.json()) as { keys: VerifierKey[] }

  const byId = new Map<number, CryptoKey>()
  for (const k of body.keys ?? []) {
    const raw = Uint8Array.from(atob(k.base64), (c) => c.charCodeAt(0))
    const key = await crypto.subtle.importKey(
      'spki',
      raw.buffer as ArrayBuffer,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    )
    byId.set(Number(k.keyId), key)
  }
  keyCache = { fetchedAt: Date.now(), byId }
  return byId
}

/** websafe-base64 → bytes. */
function b64urlDecode(s: string): Uint8Array {
  const std = s.replace(/-/g, '+').replace(/_/g, '/')
  const padded = std + '='.repeat((4 - (std.length % 4)) % 4)
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))
}

/**
 * Google signs with DER-encoded ECDSA; WebCrypto verifies IEEE P1363
 * (raw r‖s, 32 bytes each for P-256). Convert.
 */
function derToP1363(der: Uint8Array): Uint8Array {
  // DER: 0x30 len 0x02 rLen r 0x02 sLen s
  if (der[0] !== 0x30) throw new Error('bad_der')
  let offset = 2
  if (der[1] & 0x80) offset += der[1] & 0x7f // long-form length
  const readInt = (): Uint8Array => {
    if (der[offset] !== 0x02) throw new Error('bad_der')
    const len = der[offset + 1]
    let start = offset + 2
    let end = start + len
    offset = end
    // strip leading zero padding
    while (end - start > 32 && der[start] === 0x00) start++
    return der.slice(start, end)
  }
  const r = readInt()
  const s = readInt()
  const out = new Uint8Array(64)
  out.set(r, 32 - r.length)
  out.set(s, 64 - s.length)
  return out
}

async function verifySignature(rawQuery: string): Promise<boolean> {
  const sigIndex = rawQuery.indexOf('&signature=')
  if (sigIndex < 0) return false
  const content = rawQuery.slice(0, sigIndex)

  const params = new URLSearchParams(rawQuery.slice(sigIndex + 1))
  const signature = params.get('signature')
  const keyId = Number(params.get('key_id'))
  if (!signature || !Number.isFinite(keyId)) return false

  let keys = await loadKeys()
  if (!keys.has(keyId)) keys = await loadKeys(true) // rotation: one refetch
  const key = keys.get(keyId)
  if (!key) return false

  let sigBytes: Uint8Array
  try {
    sigBytes = derToP1363(b64urlDecode(signature))
  } catch {
    return false
  }

  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    sigBytes.buffer as ArrayBuffer,
    new TextEncoder().encode(content),
  )
}

async function adTestMode(db: ReturnType<typeof serviceClient>): Promise<boolean> {
  const { data } = await db
    .from('platform_settings')
    .select('value')
    .eq('key', 'ad_test_mode')
    .maybeSingle()
  return data?.value === true || data?.value === 'true'
}

Deno.serve(async (req) => {
  const preflight = handlePreflight(req)
  if (preflight) return preflight
  if (req.method !== 'GET') return fail(req, 'method_not_allowed', 405)

  const db = serviceClient()
  const url = new URL(req.url)

  // ── the test rail: BOTH gates required (setting on + secret right) ────
  // Lets the whole rail be proven end-to-end before any Google account
  // exists; fails closed when the secret env is unset.
  const testSecret = Deno.env.get('ADS_TEST_SECRET')
  const givenSecret = req.headers.get('x-ads-test-secret')
  if (givenSecret) {
    if (!testSecret || givenSecret !== testSecret) return fail(req, 'unauthorized', 401)
    if (!(await adTestMode(db))) return fail(req, 'forbidden', 403)
    const userId = url.searchParams.get('user_id')
    const tx = url.searchParams.get('transaction_id')
    if (!userId || !tx) return fail(req, 'bad_request', 400)
    const { data, error } = await db.rpc('grant_ad_reward', {
      p_user_id: userId,
      p_provider: 'test',
      p_transaction_id: tx,
      p_metadata: { test: true },
    })
    if (error) {
      // Test rail mirrors production discipline: business refusals are 200s.
      return json(req, { ok: true, skipped: error.message.split(':')[0].trim() })
    }
    return json(req, { ok: true, ...data })
  }

  // ── the real path: Google's signed callback ───────────────────────────
  const rawQuery = url.search.slice(1)
  let valid = false
  try {
    valid = await verifySignature(rawQuery)
  } catch {
    valid = false
  }
  if (!valid) return fail(req, 'invalid_signature', 403)

  const userId = url.searchParams.get('user_id')
  const tx = url.searchParams.get('transaction_id')
  if (!userId || !tx) {
    // The AdMob console's "test callback" button sends no user — a valid
    // ping deserves a 200, not a retry storm.
    return json(req, { ok: true, skipped: 'no_user' })
  }

  const { data, error } = await db.rpc('grant_ad_reward', {
    p_user_id: userId,
    p_provider: 'admob',
    p_transaction_id: tx,
    p_metadata: {
      ad_unit: url.searchParams.get('ad_unit'),
      reward_amount: url.searchParams.get('reward_amount'),
      reward_item: url.searchParams.get('reward_item'),
      key_id: url.searchParams.get('key_id'),
    },
  })

  if (error) {
    // Valid signature + business refusal (capped/disabled/…) = 200 with the
    // skip named; only crypto failures refuse. Google must never retry a
    // capped user into a storm.
    return json(req, { ok: true, skipped: error.message.split(':')[0].trim() })
  }
  return json(req, { ok: true, ...data })
})
