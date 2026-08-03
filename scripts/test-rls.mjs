#!/usr/bin/env node
/**
 * THE PHASE 0 GATE.
 *
 * Proves that Row Level Security actually isolates users. Do not build past
 * Phase 0 until this passes.
 *
 * Why this script exists rather than a code review:
 *
 * Under a third-party JWT issuer, `auth.uid()` is NULL and every policy reads
 * `auth.jwt()->>'sub'` instead. If the Clerk↔Supabase Third-Party Auth
 * integration is not enabled in the Supabase dashboard, or a client is built
 * without the `accessToken` callback, **RLS does not error — it returns an
 * empty array**. A brand-new account and a completely broken auth chain look
 * byte-for-byte identical from the application's point of view.
 *
 * The sibling project (START AI Studio) never resolved this. Its
 * supabase/README.md says outright that whether the integration is enabled
 * "has never been confirmed", so every one of its Edge Functions falls back to
 * the service role and its client-side RLS is decorative. This project does not
 * inherit that.
 *
 * Usage:
 *   node scripts/test-rls.mjs
 *
 * Requires in .env:  SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
 *                    CLERK_SECRET_KEY
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createClient } from '@supabase/supabase-js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// ── env ────────────────────────────────────────────────────────────────────
function loadEnv() {
  try {
    const text = readFileSync(join(ROOT, '.env'), 'utf8')
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  } catch {
    /* env may come from the shell instead */
  }
}
loadEnv()

const {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY,
  CLERK_SECRET_KEY,
} = process.env

// ── tiny harness ───────────────────────────────────────────────────────────
let passed = 0
let failed = 0
const failures = []

function check(name, ok, detail = '') {
  if (ok) {
    passed++
    console.log(`  [32mPASS[0m  ${name}`)
  } else {
    failed++
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`  [31mFAIL[0m  ${name}${detail ? `\n        ${detail}` : ''}`)
  }
}

function requireEnv() {
  const missing = []
  if (!SUPABASE_URL) missing.push('SUPABASE_URL')
  if (!SUPABASE_ANON_KEY) missing.push('SUPABASE_ANON_KEY')
  if (!SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY')
  if (!CLERK_SECRET_KEY) missing.push('CLERK_SECRET_KEY')
  if (missing.length) {
    console.error(`\nMissing env: ${missing.join(', ')}\nSet them in .env — see .env.example.\n`)
    process.exit(2)
  }
}

// ── Clerk helpers ──────────────────────────────────────────────────────────
async function clerk(path, init = {}) {
  const res = await fetch(`https://api.clerk.com/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${CLERK_SECRET_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const body = await res.text()
  if (!res.ok) throw new Error(`clerk ${path} -> ${res.status}: ${body}`)
  return body ? JSON.parse(body) : null
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
 * Mint a real session token for a user, which is what the browser would send.
 * Signing our own JWT would prove nothing — the point is to exercise the same
 * token Supabase will see in production.
 */
async function sessionTokenFor(userId) {
  const session = await clerk('/sessions', {
    method: 'POST',
    body: JSON.stringify({ user_id: userId }),
  })
  const token = await clerk(`/sessions/${session.id}/tokens`, {
    method: 'POST',
    body: JSON.stringify({}),
  })
  return { token: token.jwt, sessionId: session.id }
}

function scopedClient(jwt) {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    accessToken: async () => jwt,
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

// ── the run ────────────────────────────────────────────────────────────────
async function main() {
  requireEnv()
  console.log('\nRLS isolation — Phase 0 gate\n')

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  let alice, bob, aliceSession, bobSession

  try {
    console.log('Setting up two real Clerk users…')
    ;[alice, bob] = await Promise.all([createTestUser('alice'), createTestUser('bob')])

    // Seed directly rather than waiting on the webhook — this script tests RLS,
    // not delivery timing.
    for (const u of [alice, bob]) {
      await admin.from('profiles').upsert(
        { user_id: u.id, email: u.email_addresses[0].email_address, display_name: 'RLS test' },
        { onConflict: 'user_id' },
      )
    }

    // Alice gets credits; Bob deliberately gets none, so "Bob sees Alice's
    // ledger" and "Bob sees nothing" are distinguishable outcomes.
    const { error: grantErr } = await admin.rpc('grant_credits', {
      p_user_id: alice.id,
      p_amount: 42,
      p_reason: 'admin_grant',
      p_reference_type: 'admin_grant',
      p_reference_id: 'rls-test',
      p_credit_type: 'watch',
      p_idempotency_key: `rls-test:${alice.id}`,
      p_metadata: { test: true },
    })
    if (grantErr) throw new Error(`seed grant failed: ${grantErr.message}`)

    ;[aliceSession, bobSession] = await Promise.all([
      sessionTokenFor(alice.id),
      sessionTokenFor(bob.id),
    ])

    const asAlice = scopedClient(aliceSession.token)
    const asBob = scopedClient(bobSession.token)
    const asAnon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })

    // ── 1. the integration is actually on ────────────────────────────────
    // This runs FIRST and everything after it is meaningless if it fails: a
    // disabled integration makes every later assertion pass for the wrong
    // reason, because empty results look like correct isolation.
    console.log('\nIntegration is live (all later tests depend on this):')
    {
      const { data, error } = await asAlice.from('profiles').select('user_id, email')
      const sawSelf = !error && (data ?? []).some((r) => r.user_id === alice.id)
      check(
        'Alice can read her OWN profile through a Clerk JWT',
        sawSelf,
        error
          ? error.message
          : 'Returned no rows. If the Clerk↔Supabase Third-Party Auth ' +
            'integration is disabled, auth.jwt()->>\'sub\' is NULL and every ' +
            'policy matches nothing — silently. Enable it in the Supabase ' +
            'dashboard under Authentication → Third-Party Auth.',
      )
    }

    // ── 2. cross-user isolation ──────────────────────────────────────────
    console.log('\nCross-user isolation:')
    {
      const { data } = await asBob.from('credit_ledger').select('id, user_id, amount')
      const rows = data ?? []
      check(
        "Bob cannot read Alice's credit ledger",
        !rows.some((r) => r.user_id === alice.id),
        `saw ${rows.filter((r) => r.user_id === alice.id).length} of Alice's rows`,
      )
      check('Bob sees no ledger rows at all (he has none)', rows.length === 0, `saw ${rows.length}`)
    }
    {
      const { data } = await asBob.from('credit_balances').select('user_id, available_balance')
      const rows = data ?? []
      check(
        "Bob cannot read Alice's balance through the view",
        !rows.some((r) => r.user_id === alice.id),
        JSON.stringify(rows),
      )
    }
    {
      const { data } = await asAlice.from('credit_balances').select('available_balance')
      check(
        'Alice CAN read her own balance, and it is 42',
        Number(data?.[0]?.available_balance ?? 0) === 42,
        `got ${JSON.stringify(data)}`,
      )
    }
    {
      const { data } = await asBob.from('profiles').select('user_id')
      const rows = data ?? []
      check(
        "Bob cannot read Alice's profile",
        !rows.some((r) => r.user_id === alice.id),
        `saw ${rows.length} rows`,
      )
    }

    // ── 3. anonymous access ──────────────────────────────────────────────
    console.log('\nAnonymous access:')
    for (const table of ['profiles', 'credit_ledger', 'user_roles']) {
      const { data } = await asAnon.from(table).select('*').limit(5)
      check(`anon reads nothing from ${table}`, (data ?? []).length === 0, `saw ${(data ?? []).length} rows`)
    }

    // ── 4. privilege escalation ──────────────────────────────────────────
    console.log('\nPrivilege escalation:')
    {
      const { error } = await asBob
        .from('user_roles')
        .insert({ user_id: bob.id, role: 'administrator' })
      check('Bob cannot grant himself the administrator role', Boolean(error), 'INSERT SUCCEEDED')
    }
    {
      const { error } = await asBob
        .from('credit_ledger')
        .insert({ user_id: bob.id, amount: 1000, reason: 'promo', status: 'committed' })
      check('Bob cannot write himself credits directly', Boolean(error), 'INSERT SUCCEEDED')
    }
    {
      // The RPC functions all take a p_user_id. If EXECUTE was not revoked from
      // `authenticated`, this call succeeds and anyone holding the publishable
      // key — which ships in the browser bundle — can mint credits into any
      // account. (CLAUDE.md trap #7)
      const { error } = await asBob.rpc('grant_credits', {
        p_user_id: bob.id,
        p_amount: 9999,
        p_reason: 'promo',
      })
      check('Bob cannot call grant_credits() over PostgREST', Boolean(error), 'RPC SUCCEEDED')
    }
    {
      const { error } = await asBob.rpc('reserve_credits', {
        p_user_id: alice.id,
        p_credit_type: 'watch',
        p_amount: 1,
        p_reason: 'watch_debit',
        p_reference_type: 'video_unlock',
        p_reference_id: 'x',
      })
      check("Bob cannot call reserve_credits() against Alice's account", Boolean(error), 'RPC SUCCEEDED')
    }
    {
      const { error } = await asBob
        .from('profiles')
        .update({ suspended_at: null, banned_at: null })
        .eq('user_id', bob.id)
      check('Bob cannot clear his own moderation flags', Boolean(error), 'UPDATE SUCCEEDED')
    }
    {
      const { error } = await asBob
        .from('profiles')
        .update({ display_name: 'Renamed' })
        .eq('user_id', bob.id)
      check('…but Bob CAN still edit his own display name', !error, error?.message)
    }
  } finally {
    console.log('\nCleaning up…')
    for (const s of [aliceSession, bobSession]) {
      if (s) await clerk(`/sessions/${s.sessionId}/revoke`, { method: 'POST' }).catch(() => {})
    }
    for (const u of [alice, bob]) {
      if (!u) continue
      await admin.from('credit_ledger').delete().eq('user_id', u.id).catch(() => {})
      await admin.from('profiles').delete().eq('user_id', u.id).catch(() => {})
      await clerk(`/users/${u.id}`, { method: 'DELETE' }).catch(() => {})
    }
  }

  console.log(`\n${passed} passed, ${failed} failed\n`)
  if (failed) {
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
