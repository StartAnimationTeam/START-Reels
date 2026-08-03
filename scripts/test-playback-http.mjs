#!/usr/bin/env node
/**
 * The paywall, over real HTTP.
 *
 * test-entitlements/test-watchtime prove the DB functions; this proves the
 * Edge Function layer in front of them: Clerk JWT verification, error-code
 * translation, the 402/429 paths the UI is built against, and that a beacon
 * without auth can close a session but never credit time.
 *
 * Creates a real Clerk user, mints a real session token, and walks:
 *   unauth → 401
 *   unlock premium → 200, charged
 *   playback without unlock → 402 needs_unlock
 *   playback with unlock → 503 bunny_not_configured (Bunny creds pending)
 *                          BUT a session was started — the paywall ran
 *   heartbeat with auth → credits
 *   beacon without auth → closes, credits nothing
 *   sweep endpoint → 401 without the secret, 200 with it
 *
 * Usage:  node scripts/test-playback-http.mjs
 */

import { loadEnv, makeHarness, sql } from './_db.mjs'

const env = loadEnv()
const h = makeHarness()

const FN = `${env.SUPABASE_URL}/functions/v1`
const USER_TAG = `pb_http_${Date.now()}`

async function clerk(path, init = {}) {
  const res = await fetch(`https://api.clerk.com/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.CLERK_SECRET_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`clerk ${path} -> ${res.status}: ${text}`)
  return text ? JSON.parse(text) : null
}

async function fn(name, { token, body, headers = {} } = {}) {
  const res = await fetch(`${FN}/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify(body ?? {}),
  })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = text
  }
  return { status: res.status, data: json }
}

console.log('\nPaywall over HTTP - deployed Edge Functions\n')

let user, sessionJwt, videoId, freeVideoId

async function cleanup() {
  if (user) {
    await sql(`
      delete from public.watch_sessions where user_id = '${user.id}';
      delete from public.watch_history where user_id = '${user.id}';
      delete from public.video_entitlements where user_id = '${user.id}';
      delete from public.credit_ledger where user_id = '${user.id}';
      delete from public.profiles where user_id = '${user.id}';
    `)
    await clerk(`/users/${user.id}`, { method: 'DELETE' }).catch(() => {})
  }
  await sql(`delete from public.videos where slug like 'pbhttp-%'`)
}

try {
  // ── seed ──────────────────────────────────────────────────────────────
  user = await clerk('/users', {
    method: 'POST',
    body: JSON.stringify({
      email_address: [`${USER_TAG}@example.com`],
      password: `Pb-${Date.now()}-Aa!`,
      skip_password_checks: true,
    }),
  })
  const session = await clerk('/sessions', {
    method: 'POST',
    body: JSON.stringify({ user_id: user.id }),
  })
  sessionJwt = (await clerk(`/sessions/${session.id}/tokens`, { method: 'POST', body: '{}' })).jwt

  await sql(`
    insert into public.profiles (user_id, email) values ('${user.id}', '${USER_TAG}@test.local')
    on conflict (user_id) do nothing;
    select public.grant_credits('${user.id}', 5, 'admin_grant', null, null, 'watch', '${USER_TAG}-seed', '{}'::jsonb);
    insert into public.videos (title, slug, creator_id, status, access_tier, credit_cost, duration_seconds, published_at, provider_asset_id) values
      ('PB Premium', 'pbhttp-premium', 'pb_creator', 'published', 'premium', 1, 300, now(), 'fake-guid-${Date.now()}'),
      ('PB Free',    'pbhttp-free',    'pb_creator', 'published', 'free',    0, 300, now(), null);
  `)
  const vids = await sql(`select slug, id from public.videos where slug like 'pbhttp-%'`)
  videoId = vids.find((v) => v.slug === 'pbhttp-premium').id
  freeVideoId = vids.find((v) => v.slug === 'pbhttp-free').id

  // ── auth ──────────────────────────────────────────────────────────────
  h.section('Authentication')
  {
    const r = await fn('video-unlock', { body: { videoId } })
    h.check('no token -> 401', r.status === 401, `HTTP ${r.status}`)

    const forged = await fn('video-unlock', { token: 'eyJhbGciOiJSUzI1NiJ9.e30.forged', body: { videoId } })
    h.check('forged token -> 401', forged.status === 401, `HTTP ${forged.status}`)

    const bad = await fn('video-unlock', { token: sessionJwt, body: { videoId: 'not-a-uuid' } })
    h.check('malformed videoId -> 400', bad.status === 400, `HTTP ${bad.status}`)
  }

  // ── the paywall ───────────────────────────────────────────────────────
  h.section('The paywall')
  {
    const locked = await fn('video-playback', { token: sessionJwt, body: { videoId } })
    h.check('playback WITHOUT unlock -> 402 needs_unlock',
      locked.status === 402 && locked.data?.error === 'needs_unlock',
      `HTTP ${locked.status}: ${JSON.stringify(locked.data)}`)

    // Balance BEFORE the unlock, read at this moment on purpose: creating a
    // real Clerk user fires the REAL webhook, which adds the 10-credit signup
    // grant on top of our 5-credit seed on its own schedule. Absolute numbers
    // race that delivery; the delta cannot.
    const before = Number((await sql(`select public.available_credits('${user.id}', 'watch') as b`))[0].b)
    h.check('user has credits to spend (seed + possibly signup grant)', before >= 5, `${before}`)

    const unlock = await fn('video-unlock', { token: sessionJwt, body: { videoId } })
    h.check('unlock -> 200, charged 1', unlock.status === 200 && unlock.data?.charged === 1,
      `HTTP ${unlock.status}: ${JSON.stringify(unlock.data)}`)

    const again = await fn('video-unlock', { token: sessionJwt, body: { videoId } })
    h.check('unlock again -> same entitlement, charged 0',
      again.data?.entitlement_id === unlock.data?.entitlement_id && again.data?.charged === 0,
      JSON.stringify(again.data))

    const after = Number((await sql(`select public.available_credits('${user.id}', 'watch') as b`))[0].b)
    h.check('two unlock calls cost exactly 1 credit total', after === before - 1, `${before} -> ${after}`)

    // Bunny creds are pending, so the LAST step 503s — but the paywall and the
    // session start have already run for real by then.
    const play = await fn('video-playback', { token: sessionJwt, body: { videoId, device: 'test' } })
    h.check('playback WITH unlock reaches the signing step (503 bunny_not_configured)',
      play.status === 503 && play.data?.error === 'bunny_not_configured',
      `HTTP ${play.status}: ${JSON.stringify(play.data)}`)

    const sessions = await sql(`
      select count(*)::int as n from public.watch_sessions where user_id = '${user.id}'
    `)
    h.check('...and a watch session WAS started before the 503', sessions[0].n === 1, `${sessions[0].n}`)
  }

  // ── free video ────────────────────────────────────────────────────────
  h.section('Free path')
  {
    const unlock = await fn('video-unlock', { token: sessionJwt, body: { videoId: freeVideoId } })
    h.check('free video unlocks with charge 0', unlock.status === 200 && unlock.data?.charged === 0,
      JSON.stringify(unlock.data))

    const play = await fn('video-playback', { token: sessionJwt, body: { videoId: freeVideoId } })
    h.check('free video playback -> 409 video_not_ready (no asset uploaded)',
      play.status === 409 && play.data?.error === 'video_not_ready',
      `HTTP ${play.status}: ${JSON.stringify(play.data)}`)
  }

  // ── heartbeats ────────────────────────────────────────────────────────
  h.section('Heartbeats')
  {
    const sess = await sql(`
      select id from public.watch_sessions where user_id = '${user.id}' limit 1
    `)
    const sessionId = sess[0].id

    // Age the heartbeat so the claim has elapsed room.
    await sql(`update public.watch_sessions set last_heartbeat_at = now() - interval '15 seconds' where id = '${sessionId}'`)
    const hb = await fn('watch-heartbeat', {
      token: sessionJwt,
      body: { sessionId, seconds: 15, position: 15 },
    })
    h.check('authenticated heartbeat credits time', hb.status === 200 && hb.data?.credited > 0,
      `HTTP ${hb.status}: ${JSON.stringify(hb.data)}`)

    const wrongSession = await fn('watch-heartbeat', {
      token: sessionJwt,
      body: { sessionId: '00000000-0000-0000-0000-000000000000', seconds: 15, position: 15 },
    })
    h.check('heartbeat for a nonexistent session -> 404', wrongSession.status === 404, `HTTP ${wrongSession.status}`)

    // Beacon path: no Authorization header at all.
    await sql(`update public.watch_sessions set last_heartbeat_at = now() - interval '15 seconds' where id = '${sessionId}'`)
    const before = await sql(`select seconds_watched from public.watch_sessions where id = '${sessionId}'`)
    const beacon = await fn('watch-heartbeat', {
      body: { sessionId, seconds: 500, position: 200, ended: true },
    })
    h.check('unauthenticated beacon accepted for ended:true', beacon.status === 204, `HTTP ${beacon.status}`)

    const after = await sql(`select seconds_watched, ended_at from public.watch_sessions where id = '${sessionId}'`)
    h.check('beacon CLOSED the session', Boolean(after[0].ended_at))
    h.check('beacon credited ZERO seconds despite claiming 500',
      after[0].seconds_watched === before[0].seconds_watched,
      `${before[0].seconds_watched} -> ${after[0].seconds_watched}`)

    const noEnd = await fn('watch-heartbeat', { body: { sessionId, seconds: 500, position: 200 } })
    h.check('unauthenticated NON-ended heartbeat -> 401', noEnd.status === 401, `HTTP ${noEnd.status}`)
  }

  // ── sweep endpoint ────────────────────────────────────────────────────
  h.section('Sweep trigger')
  {
    const noSecret = await fn('credits-sweep', {})
    h.check('sweep without the secret -> 401', noSecret.status === 401, `HTTP ${noSecret.status}`)

    const withSecret = await fn('credits-sweep', {
      headers: { 'x-sweep-secret': env.SWEEP_TRIGGER_SECRET },
    })
    h.check('sweep with the secret -> 200', withSecret.status === 200 && 'holds_reversed' in (withSecret.data ?? {}),
      `HTTP ${withSecret.status}: ${JSON.stringify(withSecret.data)}`)
  }
} finally {
  console.log('\nCleaning up...')
  await cleanup()
}

h.finish('PAYWALL HTTP')
