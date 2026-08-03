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

    // Alice gets credits; Bob deliberately gets none, so "Bob sees Alice's
    // ledger" and "Bob sees nothing" are distinguishable outcomes.
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
      const r = await rest('credit_ledger?select=id,user_id,amount', { token: B })
      const rows = Array.isArray(r.data) ? r.data : []
      const leaked = rows.filter((x) => x.user_id === alice.id)
      check("Bob cannot read Alice's credit ledger", leaked.length === 0, `saw ${leaked.length} of her rows`)
      check('Bob sees no ledger rows at all (he has none)', rows.length === 0, `saw ${rows.length}`)
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
      const r = await rest('credit_balances?select=available_balance', { token: A })
      const bal = Number(r.data?.[0]?.available_balance ?? 0)
      check('Alice CAN read her own balance, and it is 42', bal === 42, `got ${JSON.stringify(r.data)}`)
    }
    {
      const r = await rest('profiles?select=user_id', { token: B })
      const rows = Array.isArray(r.data) ? r.data : []
      check("Bob cannot read Alice's profile", !rows.some((x) => x.user_id === alice.id), `saw ${rows.length} rows`)
    }

    // -- 3. anonymous access ----------------------------------------------
    console.log('\nAnonymous access (publishable key only, no user token):')
    for (const table of ['profiles', 'credit_ledger', 'user_roles', 'audit_logs']) {
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
    for (const u of [alice, bob]) {
      if (!u) continue
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
