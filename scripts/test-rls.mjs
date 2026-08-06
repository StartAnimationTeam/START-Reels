#!/usr/bin/env node
/**
 * THE PHASE 0 GATE.
 *
 * Proves Row Level Security actually isolates users. Do not build past Phase 0
 * until this passes.
 *
 * Why this exists rather than a code review:
 *
 * Under a third-party JWT issuer `auth.uid()` is NULL, so every policy reads
 * `auth.jwt()->>'sub'` instead. If the Clerk<->Supabase Third-Party Auth
 * integration is not enabled in the Supabase dashboard, or a client is built
 * without the accessToken callback, **RLS does not error - it returns an empty
 * array**. A broken auth chain and a brand-new account look byte-for-byte
 * identical from the application's point of view.
 *
 * The sibling project (START AI Studio) never resolved this. Its
 * supabase/README.md says outright that whether the integration is enabled
 * "has never been confirmed", so every one of its Edge Functions falls back to
 * the service role and its client-side RLS is decorative. This project does not
 * inherit that.
 *
 * Deliberately uses plain fetch against PostgREST rather than supabase-js:
 *   - it is the actual wire format, so nothing can be hidden by a client
 *     library's error handling;
 *   - it runs on any Node with fetch, including CI, with zero dependencies.
 *
 * Usage:  node scripts/test-rls.mjs
 * Needs in .env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
 *                CLERK_SECRET_KEY
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

try {
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
} catch {
  /* env may come from the shell instead */
}

const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, CLERK_SECRET_KEY } = process.env

const missing = Object.entries({
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY,
  CLERK_SECRET_KEY,
})
  .filter(([, v]) => !v)
  .map(([k]) => k)

if (missing.length) {
  console.error(`\nMissing env: ${missing.join(', ')}\n`)
  process.exit(2)
}

// -- harness ----------------------------------------------------------------
const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const OFF = '\x1b[0m'

let passed = 0
const failures = []

function check(name, ok, detail = '') {
  if (ok) {
    passed++
    console.log(`  ${GREEN}PASS${OFF}  ${name}`)
  } else {
    failures.push(`${name}${detail ? ` - ${detail}` : ''}`)
    console.log(`  ${RED}FAIL${OFF}  ${name}${detail ? `\n        ${detail}` : ''}`)
  }
}

// -- PostgREST --------------------------------------------------------------
/**
 * `token` is either a Clerk session JWT (the browser case) or the service role
 * key (the trusted case). Passing the Clerk JWT straight through as the bearer
 * is exactly what supabase-js's accessToken callback does internally.
 */
async function rest(path, { token, apikey = SUPABASE_ANON_KEY, method = 'GET', body, prefer } = {}) {
  const headers = { apikey, 'Content-Type': 'application/json' }
  // Only a real JWT goes in Authorization. The new-format keys
  // (sb_publishable_… / sb_secret_…) are NOT JWTs — PostgREST tries to parse
  // the bearer and fails with "Expected 3 parts in JWT; got 1". They identify
  // the role through the apikey header instead.
  if (token) headers.Authorization = `Bearer ${token}`
  if (prefer) headers.Prefer = prefer

  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })

  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = text
  }
  return { ok: res.ok, status: res.status, data: json }
}

/** Service role: bypasses RLS. Used only to seed and clean up. */
const svc = (path, opts = {}) =>
  rest(path, { ...opts, apikey: SUPABASE_SERVICE_ROLE_KEY, token: undefined })

// -- Clerk ------------------------------------------------------------------
async function clerk(path, init = {}) {
  const res = await fetch(`https://api.clerk.com/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${CLERK_SECRET_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`clerk ${path} -> ${res.status}: ${text}`)
  return text ? JSON.parse(text) : null
}

async function createTestUser(tag) {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`
  return clerk('/users', {
    method: 'POST',
    body: JSON.stringify({
      email_address: [`rls-test-${tag}-${suffix}@example.com`],
      password: `Test-${suffix}-Aa!`,
      skip_password_checks: true,
    }),
  })
}

/**
 * Mint a REAL session token - the same thing the browser would send. Signing a
 * JWT ourselves would prove nothing, because the point is to exercise the token
 * Supabase will actually see.
 */
async function sessionFor(userId) {
  const session = await clerk('/sessions', {
    method: 'POST',
    body: JSON.stringify({ user_id: userId }),
  })
  const token = await clerk(`/sessions/${session.id}/tokens`, {
    method: 'POST',
    body: JSON.stringify({}),
  })
  return { id: session.id, jwt: token.jwt }
}

// -- the run ----------------------------------------------------------------
async function main() {
  console.log('\nRLS isolation - Phase 0 gate\n')

  let alice, bob, aliceSession, bobSession

  try {
    console.log('Setting up two real Clerk users...')
    ;[alice, bob] = await Promise.all([createTestUser('alice'), createTestUser('bob')])

    // Seed directly rather than waiting on the webhook - this script tests RLS,
    // not delivery timing.
    for (const u of [alice, bob]) {
      await svc('profiles', {
        method: 'POST',
        prefer: 'resolution=merge-duplicates',
        body: {
          user_id: u.id,
          email: u.email_addresses[0].email_address,
          display_name: 'RLS test',
        },
      })
    }

    // Alice gets an admin grant on top; Bob gets only whatever the signup
    // webhook granted him. The 42-credit admin grant exists ONLY on Alice's
    // ledger, so "Bob sees Alice's ledger" and "Bob sees only his own"
    // stay distinguishable even though the webhook credits both users.
    const grant = await svc('rpc/grant_credits', {
      method: 'POST',
      body: {
        p_user_id: alice.id,
        p_amount: 42,
        p_reason: 'admin_grant',
        p_reference_type: 'admin_grant',
        p_reference_id: 'rls-test',
        p_credit_type: 'watch',
        p_idempotency_key: `rls-test:${alice.id}:${Date.now()}`,
        p_metadata: { test: true },
      },
    })
    if (!grant.ok) throw new Error(`seed grant failed: ${JSON.stringify(grant.data)}`)

    ;[aliceSession, bobSession] = await Promise.all([sessionFor(alice.id), sessionFor(bob.id)])

    const A = aliceSession.jwt
    const B = bobSession.jwt

    // -- 1. the integration is actually on --------------------------------
    // Runs FIRST, and everything after it is meaningless if it fails: a
    // disabled integration makes every later assertion pass for the WRONG
    // reason, because empty results look exactly like correct isolation.
    console.log('\nIntegration is live (every later test depends on this):')
    {
      const r = await rest('profiles?select=user_id,email', { token: A })
      const sawSelf = Array.isArray(r.data) && r.data.some((x) => x.user_id === alice.id)
      check(
        'Alice can read her OWN profile through a Clerk JWT',
        sawSelf,
        !r.ok
          ? `HTTP ${r.status}: ${JSON.stringify(r.data)}`
          : "Returned no rows. If the Clerk<->Supabase Third-Party Auth integration is " +
            "disabled, auth.jwt()->>'sub' is NULL and every policy matches nothing - " +
            'silently. Enable it: Supabase dashboard -> Authentication -> Third-Party Auth.',
      )
    }

    // -- 2. cross-user isolation ------------------------------------------
    console.log('\nCross-user isolation:')
    {
      const r = await rest('credit_ledger?select=id,user_id,amount,reason', { token: B })
      const rows = Array.isArray(r.data) ? r.data : []
      const leaked = rows.filter((x) => x.user_id === alice.id)
      check("Bob cannot read Alice's credit ledger", leaked.length === 0, `saw ${leaked.length} of her rows`)
      // Bob legitimately owns a signup_grant row (the webhook fires for test
      // users too). Anything beyond that - a foreign user_id, or the admin
      // grant that was only ever written to Alice - is a leak.
      const foreign = rows.filter((x) => x.user_id !== bob.id)
      const notSignup = rows.filter((x) => x.reason !== 'signup_grant')
      check(
        "Bob's only ledger rows are his own signup grant",
        foreign.length === 0 && notSignup.length === 0,
        `${foreign.length} foreign, ${notSignup.length} non-signup: ${JSON.stringify(rows)}`,
      )
    }
    {
      const r = await rest('credit_balances?select=user_id,available_balance', { token: B })
      const rows = Array.isArray(r.data) ? r.data : []
      check(
        "Bob cannot read Alice's balance through the view",
        !rows.some((x) => x.user_id === alice.id),
        JSON.stringify(rows),
      )
    }
    {
      // The signup webhook also credits Alice, so her balance is 42 plus a
      // signup grant of whatever platform_settings says today. Compare her
      // OWN read against the service role's view of the same row instead of
      // hardcoding the sum - the property under test is that RLS lets her
      // see her real balance, not what the signup grant happens to be.
      const truth = await svc(`credit_balances?user_id=eq.${alice.id}&select=available_balance`)
      const want = Number(truth.data?.[0]?.available_balance ?? NaN)
      const r = await rest('credit_balances?select=available_balance', { token: A })
      const bal = Number(r.data?.[0]?.available_balance ?? 0)
      check(
        'Alice CAN read her own balance, and it matches the service-role truth (incl. the 42 seeded)',
        Number.isFinite(want) && bal === want && bal >= 42,
        `she sees ${JSON.stringify(r.data)}, service role sees ${JSON.stringify(truth.data)}`,
      )
    }
    {
      const r = await rest('profiles?select=user_id', { token: B })
      const rows = Array.isArray(r.data) ? r.data : []
      check("Bob cannot read Alice's profile", !rows.some((x) => x.user_id === alice.id), `saw ${rows.length} rows`)
    }

    // -- 2b. favorites: the one client-writable table ---------------------
    console.log('\nFavorites (the one client-writable table):')
    {
      const video = await svc(`videos?slug=eq.welcome-to-start&select=id`)
      const videoId = video.data?.[0]?.id ?? video?.[0]?.id
      if (!videoId) {
        check('seeded video available for favorites test', false, 'run scripts/seed-catalog.mjs first')
      } else {
        const mine = await rest('favorites', {
          token: B,
          method: 'POST',
          body: { user_id: bob.id, video_id: videoId },
        })
        check('Bob CAN favorite a video as himself', mine.ok, `HTTP ${mine.status}: ${JSON.stringify(mine.data)}`)

        const forged = await rest('favorites', {
          token: B,
          method: 'POST',
          body: { user_id: alice.id, video_id: videoId },
        })
        check("Bob cannot write a favorite onto Alice's account", !forged.ok, `HTTP ${forged.status} - INSERT SUCCEEDED`)

        const readBack = await rest('favorites?select=user_id', { token: A })
        const rows = Array.isArray(readBack.data) ? readBack.data : []
        check("Alice sees none of Bob's favorites", rows.length === 0, `saw ${rows.length}`)

        const del = await rest(`favorites?video_id=eq.${videoId}`, { token: B, method: 'DELETE' })
        check('Bob can remove his own favorite', del.ok, `HTTP ${del.status}`)
      }
    }

    // -- 2c. series: catalog visibility + follows + progress --------------
    console.log('\nSeries (catalog visibility, follows, progress view):')
    {
      // A draft series exists (seeded via service role). Published rows are
      // public; drafts must be invisible to everyone but the creator/staff.
      const draft = await svc('series', {
        method: 'POST',
        prefer: 'return=representation',
        body: {
          slug: 'rls-test-draft-series',
          title: 'RLS draft series',
          creator_id: 'rls_test_ghost_creator',
          status: 'draft',
        },
      })
      const draftId = draft.data?.[0]?.id
      if (!draftId) {
        check('seeded draft series for visibility test', false, JSON.stringify(draft.data))
      } else {
        const anonSees = await rest(`series?id=eq.${draftId}&select=id`, {})
        check('anon cannot see a draft series', (anonSees.data ?? []).length === 0, JSON.stringify(anonSees.data))

        const bobSees = await rest(`series?id=eq.${draftId}&select=id`, { token: B })
        check('Bob cannot see a draft series either', (bobSees.data ?? []).length === 0, JSON.stringify(bobSees.data))

        const pub = await rest(`series?status=eq.published&select=id&limit=1`, {})
        check(
          'anon CAN browse published series (top of the funnel)',
          Array.isArray(pub.data) && pub.data.length > 0,
          `saw ${JSON.stringify(pub.data)} - is the catalog seeded?`,
        )

        // Follows: same client-writable contract as favorites.
        const followSeries = await svc('series?status=eq.published&select=id&limit=1')
        const followId = followSeries.data?.[0]?.id
        const mine = await rest('series_follows', {
          token: B,
          method: 'POST',
          body: { user_id: bob.id, series_id: followId },
        })
        check('Bob CAN follow a series as himself', mine.ok, `HTTP ${mine.status}: ${JSON.stringify(mine.data)}`)

        const forged = await rest('series_follows', {
          token: B,
          method: 'POST',
          body: { user_id: alice.id, series_id: followId },
        })
        check("Bob cannot write a follow onto Alice's account", !forged.ok, `HTTP ${forged.status} - INSERT SUCCEEDED`)

        const readBack = await rest('series_follows?select=user_id', { token: A })
        check(
          "Alice sees none of Bob's follows",
          (readBack.data ?? []).length === 0,
          `saw ${(readBack.data ?? []).length}`,
        )

        const del = await rest(`series_follows?series_id=eq.${followId}`, { token: B, method: 'DELETE' })
        check('Bob can unfollow', del.ok, `HTTP ${del.status}`)

        // series_progress runs as the CALLER (security_invoker). Give Bob a
        // watch_history row via the service role, then prove the view scopes:
        // this is the query shape that leaked credit_balances before 0004,
        // testable only through the view as a real user.
        const epRow = await svc(`videos?series_id=eq.${followId}&select=id&limit=1`)
        const epId = epRow.data?.[0]?.id
        if (epId) {
          await svc('watch_history', {
            method: 'POST',
            prefer: 'resolution=merge-duplicates',
            body: { user_id: bob.id, video_id: epId, last_position_seconds: 12, total_seconds_watched: 12, watch_count: 1 },
          })
          const bobSeesOwn = await rest('series_progress?select=series_id,user_id', { token: B })
          const bobRows = Array.isArray(bobSeesOwn.data) ? bobSeesOwn.data : []
          check(
            'Bob sees his own series progress through the view',
            bobRows.some((r) => r.series_id === followId && r.user_id === bob.id),
            JSON.stringify(bobSeesOwn.data),
          )
          const aliceSees = await rest('series_progress?select=user_id', { token: A })
          const aliceRows = Array.isArray(aliceSees.data) ? aliceSees.data : []
          check(
            "Alice sees none of Bob's progress (security_invoker holds)",
            !aliceRows.some((r) => r.user_id === bob.id),
            JSON.stringify(aliceSees.data),
          )
        } else {
          check('an episode exists for the progress test', false, 'published series has no video rows')
        }
      }
    }

    // -- 3. anonymous access ----------------------------------------------
    console.log('\nAnonymous access (publishable key only, no user token):')
    for (const table of ['profiles', 'credit_ledger', 'user_roles', 'audit_logs', 'favorites', 'series_follows', 'episode_likes', 'ad_reward_events', 'memberships']) {
      const r = await rest(`${table}?select=*&limit=5`, {})
      const n = Array.isArray(r.data) ? r.data.length : 0
      check(`anon reads nothing from ${table}`, n === 0, `saw ${n} rows`)
    }

    // -- 4. privilege escalation ------------------------------------------
    console.log('\nPrivilege escalation:')
    {
      const r = await rest('user_roles', {
        token: B,
        method: 'POST',
        body: { user_id: bob.id, role: 'administrator' },
      })
      check('Bob cannot grant himself the administrator role', !r.ok, `HTTP ${r.status} - INSERT SUCCEEDED`)
    }
    {
      const r = await rest('credit_ledger', {
        token: B,
        method: 'POST',
        body: { user_id: bob.id, amount: 1000, reason: 'promo', status: 'committed' },
      })
      check('Bob cannot write himself credits directly', !r.ok, `HTTP ${r.status} - INSERT SUCCEEDED`)
    }
    {
      // Every credit function takes a p_user_id. If EXECUTE was not revoked
      // from `authenticated`, this succeeds - and anyone holding the
      // publishable key, which ships in the browser bundle, can mint credits
      // into any account. (CLAUDE.md trap #7)
      const r = await rest('rpc/grant_credits', {
        token: B,
        method: 'POST',
        body: { p_user_id: bob.id, p_amount: 9999, p_reason: 'promo' },
      })
      check('Bob cannot call grant_credits() over PostgREST', !r.ok, `HTTP ${r.status} - RPC SUCCEEDED`)
    }
    {
      const r = await rest('rpc/reserve_credits', {
        token: B,
        method: 'POST',
        body: {
          p_user_id: alice.id,
          p_credit_type: 'watch',
          p_amount: 1,
          p_reason: 'watch_debit',
          p_reference_type: 'video_unlock',
          p_reference_id: 'x',
        },
      })
      check("Bob cannot call reserve_credits() against Alice's account", !r.ok, `HTTP ${r.status} - RPC SUCCEEDED`)
    }
    {
      // grant_ad_reward (0027) takes a p_user_id too - same trap #7 stakes:
      // callable over PostgREST would mean anyone mints ad coins for anyone.
      const r = await rest('rpc/grant_ad_reward', {
        token: B,
        method: 'POST',
        body: { p_user_id: bob.id, p_provider: 'gpt_web', p_transaction_id: `rls-${Date.now()}` },
      })
      check('Bob cannot call grant_ad_reward() over PostgREST', !r.ok, `HTTP ${r.status} - RPC SUCCEEDED`)
    }
    {
      // ad_reward_events isolation: Alice's ad grants are hers alone.
      const tx = `rls-iso-${Date.now()}`
      await svc('ad_reward_events', {
        method: 'POST',
        body: { user_id: alice.id, provider: 'test', transaction_id: tx, amount: 1 },
      })
      const aliceSees = await rest('ad_reward_events?select=transaction_id', { token: A })
      check(
        'Alice sees her own ad_reward_events',
        (aliceSees.data ?? []).some((row) => row.transaction_id === tx),
        JSON.stringify(aliceSees.data),
      )
      const bobSees = await rest('ad_reward_events?select=user_id', { token: B })
      check(
        "Bob sees none of Alice's ad_reward_events",
        !(bobSees.data ?? []).some((row) => row.user_id === alice.id),
        JSON.stringify(bobSees.data),
      )
      const forge = await rest('ad_reward_events', {
        token: B,
        method: 'POST',
        body: { user_id: bob.id, provider: 'test', transaction_id: `rls-forge-${Date.now()}`, amount: 999 },
      })
      check('Bob cannot insert his own ad_reward_events', !forge.ok, `HTTP ${forge.status} - INSERT SUCCEEDED`)
      await svc(`ad_reward_events?transaction_id=eq.${tx}`, { method: 'DELETE' })
    }
    {
      const r = await rest(`profiles?user_id=eq.${bob.id}`, {
        token: B,
        method: 'PATCH',
        body: { suspended_at: null, banned_at: null },
      })
      check('Bob cannot clear his own moderation flags', !r.ok, `HTTP ${r.status} - UPDATE SUCCEEDED`)
    }
    {
      const r = await rest(`profiles?user_id=eq.${bob.id}`, {
        token: B,
        method: 'PATCH',
        body: { display_name: 'Renamed' },
      })
      check('...but Bob CAN still edit his own display name', r.ok, `HTTP ${r.status}: ${JSON.stringify(r.data)}`)
    }
    {
      const r = await rest(`profiles?user_id=eq.${alice.id}`, {
        token: B,
        method: 'PATCH',
        body: { display_name: 'Hacked' },
      })
      const after = await svc(`profiles?user_id=eq.${alice.id}&select=display_name`)
      const unchanged = after.data?.[0]?.display_name !== 'Hacked'
      check("Bob cannot rename Alice (silently matches zero rows)", unchanged, 'Alice was renamed')
    }
  } finally {
    console.log('\nCleaning up...')
    for (const s of [aliceSession, bobSession]) {
      if (s) await clerk(`/sessions/${s.id}/revoke`, { method: 'POST' }).catch(() => {})
    }
    await svc(`series?slug=eq.rls-test-draft-series`, { method: 'DELETE' }).catch(() => {})
    for (const u of [alice, bob]) {
      if (!u) continue
      await svc(`series_follows?user_id=eq.${u.id}`, { method: 'DELETE' }).catch(() => {})
      await svc(`watch_history?user_id=eq.${u.id}`, { method: 'DELETE' }).catch(() => {})
      await svc(`credit_ledger?user_id=eq.${u.id}`, { method: 'DELETE' }).catch(() => {})
      await svc(`notification_preferences?user_id=eq.${u.id}`, { method: 'DELETE' }).catch(() => {})
      await svc(`profiles?user_id=eq.${u.id}`, { method: 'DELETE' }).catch(() => {})
      await clerk(`/users/${u.id}`, { method: 'DELETE' }).catch(() => {})
    }
  }

  console.log(`\n${passed} passed, ${failures.length} failed\n`)
  if (failures.length) {
    console.log('Failures:')
    for (const f of failures) console.log(`  - ${f}`)
    console.log('\nPHASE 0 GATE: NOT PASSED. Do not build further until this is green.\n')
    process.exit(1)
  }
  console.log('PHASE 0 GATE: PASSED. RLS isolates users under Clerk JWTs.\n')
}

main().catch((err) => {
  console.error('\nHarness error (not a test failure):', err.message)
  process.exit(2)
})
