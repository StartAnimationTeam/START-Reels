#!/usr/bin/env node
/**
 * Rate limits, exercised for real.
 *
 *   - the counter is race-safe: 40 CONCURRENT unlock calls yield exactly 20
 *     passes and 20 429s (the ON CONFLICT arithmetic, not politeness)
 *   - different users don't share windows
 *   - promo guessing: attempt #11 in the hour is rate_limited BEFORE the
 *     code lookup, so a valid code late in a guessing spree is also refused
 *   - the window prune job is scheduled
 *
 * Usage:  node scripts/test-ratelimit.mjs
 */

import { loadEnv, makeHarness, sql } from './_db.mjs'

const env = loadEnv()
const h = makeHarness()

async function clerk(path, init = {}) {
  const res = await fetch(`https://api.clerk.com/v1${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${env.CLERK_SECRET_KEY}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
  const t = await res.text()
  if (!res.ok) throw new Error(`clerk ${path} -> ${res.status}: ${t}`)
  return t ? JSON.parse(t) : null
}

async function makeUser(tag) {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`
  const user = await clerk('/users', {
    method: 'POST',
    body: JSON.stringify({
      email_address: [`rl-${tag}-${suffix}@example.com`],
      password: `Rl-${suffix}-Aa!`,
      skip_password_checks: true,
    }),
  })
  const session = await clerk('/sessions', { method: 'POST', body: JSON.stringify({ user_id: user.id }) })
  const jwt = (await clerk(`/sessions/${session.id}/tokens`, { method: 'POST', body: '{}' })).jwt
  return { ...user, sessionId: session.id, jwt }
}

const fn = (name, jwt, body) =>
  fetch(`${env.SUPABASE_URL}/functions/v1/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }))

const rpc = (name, jwt, body = {}) =>
  fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      'Content-Type': 'application/json',
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }))

console.log('\nRate limits - deployed functions\n')

let alice, bob, videoId

async function cleanup() {
  for (const u of [alice, bob]) {
    if (!u) continue
    await sql(`
      delete from public.rate_limits where key like '%${u.id}%';
      delete from public.promo_redemptions where user_id = '${u.id}';
      delete from public.watch_sessions where user_id = '${u.id}';
      delete from public.watch_history where user_id = '${u.id}';
      delete from public.video_entitlements where user_id = '${u.id}';
      delete from public.credit_ledger where user_id = '${u.id}';
      delete from public.profiles where user_id = '${u.id}';
    `)
    await clerk(`/sessions/${u.sessionId}/revoke`, { method: 'POST' }).catch(() => {})
    await clerk(`/users/${u.id}`, { method: 'DELETE' }).catch(() => {})
  }
  await sql(`
    delete from public.promo_campaigns where code = 'RL-TEST-REAL';
    delete from public.videos where slug = 'rl-test-video';
  `)
}

try {
  ;[alice, bob] = await Promise.all([makeUser('alice'), makeUser('bob')])
  for (const u of [alice, bob]) {
    await sql(`insert into public.profiles (user_id, email) values ('${u.id}', '${u.email_addresses[0].email_address}') on conflict (user_id) do nothing;`)
  }
  await sql(`
    insert into public.videos (title, slug, creator_id, status, access_tier, credit_cost, duration_seconds, published_at)
    values ('RL Test', 'rl-test-video', 'rl_creator', 'published', 'free', 0, 100, now());
    insert into public.promo_campaigns (code, name, amount, per_user_limit, created_by)
    values ('RL-TEST-REAL', 'RL test', 3, 1, 'test');
  `)
  videoId = (await sql(`select id from public.videos where slug = 'rl-test-video'`))[0].id

  h.section('Unlock limit under genuine concurrency (limit 20/min)')
  {
    const results = await Promise.all(
      Array.from({ length: 40 }, () => fn('video-unlock', alice.jwt, { videoId })),
    )
    const passed = results.filter((r) => r.status === 200).length
    const limited = results.filter((r) => r.status === 429).length
    h.check('exactly 20 of 40 concurrent calls pass', passed === 20, `${passed} passed`)
    h.check('exactly 20 are 429 rate_limited', limited === 20 &&
      results.find((r) => r.status === 429)?.data?.error === 'rate_limited', `${limited} limited`)
  }

  h.section('Windows are per-user')
  {
    const bobTry = await fn('video-unlock', bob.jwt, { videoId })
    h.check("Alice's exhausted window doesn't touch Bob", bobTry.status === 200, `HTTP ${bobTry.status}`)
  }

  h.section('Promo guessing (10 attempts/hour, checked before lookup)')
  {
    for (let i = 0; i < 10; i++) {
      await rpc('redeem_promo', bob.jwt, { p_code: `WRONG-GUESS-${i}` })
    }
    // Failures are DATA now ({error}), not raises — a raise would roll back
    // the counter increment that makes this limit exist (migration 0015).
    const eleventh = await rpc('redeem_promo', bob.jwt, { p_code: 'RL-TEST-REAL' })
    h.check('attempt #11 with the CORRECT code is still rate_limited',
      eleventh.data?.error === 'rate_limited',
      `HTTP ${eleventh.status}: ${JSON.stringify(eleventh.data)}`)

    const aliceRedeem = await rpc('redeem_promo', alice.jwt, { p_code: 'RL-TEST-REAL' })
    h.check('an unthrottled user redeems the same code fine',
      aliceRedeem.status === 200 && aliceRedeem.data?.granted === 3,
      `HTTP ${aliceRedeem.status}: ${JSON.stringify(aliceRedeem.data)}`)
  }

  h.section('Hygiene')
  {
    const job = await sql(`select 1 from cron.job where jobname = 'prune-rate-limits'`)
    h.check('window prune job scheduled', job.length === 1)

    const anon = await fetch(`${env.SUPABASE_URL}/rest/v1/rate_limits?select=key&limit=1`, {
      headers: { apikey: env.SUPABASE_ANON_KEY },
    })
    const rows = await anon.json().catch(() => [])
    h.check('rate_limits table is not client-readable', Array.isArray(rows) && rows.length === 0, `saw ${rows?.length}`)
  }
} finally {
  console.log('\nCleaning up...')
  await cleanup()
}

h.finish('RATE LIMITS')
