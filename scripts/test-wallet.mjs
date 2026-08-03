#!/usr/bin/env node
/**
 * Wallet rules over the REAL path: PostgREST RPC with real Clerk JWTs — the
 * exact route the browser takes, since both functions are granted straight to
 * `authenticated`.
 *
 *   - daily reward claims once; the second claim the same day is refused and
 *     the balance moves exactly once (RACED, not just repeated)
 *   - anonymous callers can't claim
 *   - promo: valid code grants once, per-user limit holds, unknown and
 *     inactive codes fail identically, max_redemptions caps globally
 *   - campaigns are not listable by users (codes would leak)
 *
 * Usage:  node scripts/test-wallet.mjs
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
      email_address: [`wallet-${tag}-${suffix}@example.com`],
      password: `Wt-${suffix}-Aa!`,
      skip_password_checks: true,
    }),
  })
  const session = await clerk('/sessions', { method: 'POST', body: JSON.stringify({ user_id: user.id }) })
  const jwt = (await clerk(`/sessions/${session.id}/tokens`, { method: 'POST', body: '{}' })).jwt
  return { ...user, sessionId: session.id, jwt }
}

const rpc = (name, jwt, body = {}) =>
  fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      'Content-Type': 'application/json',
      ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
    },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }))

const bal = async (uid) =>
  Number((await sql(`select public.available_credits('${uid}', 'watch') as b`))[0].b)

console.log('\nWallet rules - PostgREST with real Clerk JWTs\n')

let alice, bob

async function cleanup() {
  for (const u of [alice, bob]) {
    if (!u) continue
    await sql(`
      delete from public.promo_redemptions where user_id = '${u.id}';
      delete from public.daily_reward_claims where user_id = '${u.id}';
      delete from public.credit_ledger where user_id = '${u.id}';
      delete from public.profiles where user_id = '${u.id}';
    `)
    await clerk(`/sessions/${u.sessionId}/revoke`, { method: 'POST' }).catch(() => {})
    await clerk(`/users/${u.id}`, { method: 'DELETE' }).catch(() => {})
  }
  await sql(`delete from public.promo_campaigns where code like 'WALLET-TEST%'`)
}

try {
  ;[alice, bob] = await Promise.all([makeUser('alice'), makeUser('bob')])
  for (const u of [alice, bob]) {
    await sql(`insert into public.profiles (user_id, email) values ('${u.id}', '${u.email_addresses[0].email_address}') on conflict (user_id) do nothing;`)
  }

  h.section('Daily reward')
  {
    const base = await bal(alice.id)
    // RACE two claims — the PK is the lock, not politeness.
    const [first, second] = await Promise.all([
      rpc('claim_daily_reward', alice.jwt),
      rpc('claim_daily_reward', alice.jwt),
    ])
    const outcomes = [first, second]
    const ok = outcomes.filter((r) => r.status === 200)
    const refused = outcomes.filter((r) => r.status !== 200)
    h.check('exactly one of two RACED claims succeeds', ok.length === 1 && refused.length === 1,
      `statuses: ${outcomes.map((r) => r.status).join(', ')}`)
    h.check('the refusal says already_claimed_today',
      JSON.stringify(refused[0]?.data ?? '').includes('already_claimed_today'),
      JSON.stringify(refused[0]?.data))

    // Assert on the LEDGER, not the balance delta — the live signup webhook
    // grants +10 on its own schedule and races any before/after read. The
    // precise claim is: exactly ONE daily_reward row exists, at the right
    // amount, however many raced calls were made.
    const amount = Number((await sql(`select value #>> '{}' as v from public.platform_settings where key = 'daily_reward_amount'`))[0].v)
    const rows = await sql(`
      select count(*)::int as n, coalesce(sum(amount), 0) as total
      from public.credit_ledger
      where user_id = '${alice.id}' and reason = 'daily_reward'
    `)
    h.check(`exactly one daily_reward ledger row, worth ${amount}`,
      rows[0].n === 1 && Number(rows[0].total) === amount,
      `${rows[0].n} rows totalling ${rows[0].total}`)
    void base

    const third = await rpc('claim_daily_reward', alice.jwt)
    h.check('a later same-day claim is still refused', third.status !== 200, `HTTP ${third.status}`)

    const anon = await rpc('claim_daily_reward', null)
    h.check('anonymous claim is refused', anon.status !== 200, `HTTP ${anon.status}`)
  }

  h.section('Promo codes')
  {
    await sql(`
      insert into public.promo_campaigns (code, name, amount, per_user_limit, max_redemptions, created_by)
      values ('WALLET-TEST-OPEN', 'Wallet test', 7, 1, 2, 'test'),
             ('WALLET-TEST-OFF', 'Inactive', 7, 1, null, 'test');
      update public.promo_campaigns set is_active = false where code = 'WALLET-TEST-OFF';
    `)

    const base = await bal(alice.id)
    const redeem = await rpc('redeem_promo', alice.jwt, { p_code: 'wallet-test-open' })
    h.check('valid code redeems (case-insensitive)', redeem.status === 200 && redeem.data?.granted === 7,
      `HTTP ${redeem.status}: ${JSON.stringify(redeem.data)}`)
    h.check('balance +7', (await bal(alice.id)) === base + 7)

    const again = await rpc('redeem_promo', alice.jwt, { p_code: 'WALLET-TEST-OPEN' })
    h.check('per-user limit refuses a second redemption',
      again.status !== 200 && JSON.stringify(again.data).includes('promo_already_redeemed'),
      `HTTP ${again.status}: ${JSON.stringify(again.data)}`)
    h.check('balance unchanged', (await bal(alice.id)) === base + 7)

    const unknown = await rpc('redeem_promo', alice.jwt, { p_code: 'WALLET-TEST-NOPE' })
    const inactive = await rpc('redeem_promo', alice.jwt, { p_code: 'WALLET-TEST-OFF' })
    h.check('unknown and inactive codes fail with the SAME error (no oracle)',
      JSON.stringify(unknown.data).includes('promo_invalid') &&
      JSON.stringify(inactive.data).includes('promo_invalid'),
      `${JSON.stringify(unknown.data)} vs ${JSON.stringify(inactive.data)}`)

    // Bob takes redemption #2 of 2; the campaign is now exhausted for everyone.
    const bobRedeem = await rpc('redeem_promo', bob.jwt, { p_code: 'WALLET-TEST-OPEN' })
    h.check('a second user can redeem while capacity remains', bobRedeem.status === 200, `HTTP ${bobRedeem.status}`)

    await sql(`
      insert into public.profiles (user_id, email) values ('wallet_third', 'wallet-third@test.local')
      on conflict (user_id) do nothing;
    `)
    // A third redemption must hit max_redemptions — checked via SQL as a
    // synthetic user since minting a third Clerk user buys nothing extra.
    const exhausted = await sql(`
      do $$ begin
        perform set_config('request.jwt.claims', '{"sub":"wallet_third","role":"authenticated"}', true);
        perform public.redeem_promo('WALLET-TEST-OPEN');
        raise exception 'should_not_reach';
      exception when others then
        if sqlerrm not like '%promo_exhausted%' then raise; end if;
      end $$;
      select 'ok' as result;
    `).then((r) => r[0]?.result === 'ok').catch(() => false)
    h.check('max_redemptions caps the campaign globally', exhausted)
    await sql(`delete from public.profiles where user_id = 'wallet_third'`)
  }

  h.section('Campaign codes do not leak')
  {
    const list = await fetch(`${env.SUPABASE_URL}/rest/v1/promo_campaigns?select=code`, {
      headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${alice.jwt}` },
    }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }))
    const rows = Array.isArray(list.data) ? list.data : []
    h.check('a signed-in user cannot list campaign codes', rows.length === 0, `saw ${rows.length} rows`)
  }
} finally {
  console.log('\nCleaning up...')
  await cleanup()
}

h.finish('WALLET')
