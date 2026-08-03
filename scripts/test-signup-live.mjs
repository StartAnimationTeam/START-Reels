#!/usr/bin/env node
/**
 * The real Phase 0 acceptance test: a genuine signup, end to end.
 *
 * test-webhook.mjs proves the HANDLER is correct by signing payloads itself.
 * This proves DELIVERY — that Clerk is actually configured to call our endpoint
 * with the right events. Those are different failures: a perfect handler behind
 * a webhook endpoint that was never registered, or registered without
 * `user.created` subscribed, produces a user who exists in Clerk, cannot be
 * found in Postgres, and has no credits. Nothing errors. It just doesn't work.
 *
 * Creates a real Clerk user, waits for the webhook to land, and asserts the
 * profile and the signup grant appeared.
 *
 * Usage:  node scripts/test-signup-live.mjs
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CLERK_SECRET_KEY } = process.env

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
    failures.push(name)
    console.log(`  ${RED}FAIL${OFF}  ${name}${detail ? `\n        ${detail}` : ''}`)
  }
}

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

async function svc(path, { method = 'GET' } = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, 'Content-Type': 'application/json' },
  })
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

console.log('\nLive signup - Phase 0 acceptance\n')

let user
try {
  const suffix = `${Date.now()}`
  console.log('Creating a real Clerk user...')
  user = await clerk('/users', {
    method: 'POST',
    body: JSON.stringify({
      email_address: [`live-signup-${suffix}@example.com`],
      password: `Live-${suffix}-Aa!`,
      first_name: 'Live',
      last_name: 'Signup',
      skip_password_checks: true,
    }),
  })
  console.log(`  ${user.id}`)

  // Webhooks are asynchronous. Poll rather than sleeping a fixed amount —
  // a fixed wait is either flaky or slow, and usually both.
  console.log('\nWaiting for the webhook to land (up to 30s)...')
  let profile = null
  for (let i = 0; i < 15; i++) {
    await sleep(2000)
    const rows = await svc(`profiles?user_id=eq.${user.id}&select=user_id,email,display_name`)
    if (rows?.length) {
      profile = rows[0]
      console.log(`  arrived after ~${(i + 1) * 2}s`)
      break
    }
  }

  check(
    'Clerk delivered user.created and the profile was created',
    Boolean(profile),
    'No profile after 30s. Either the webhook endpoint is not registered in ' +
      'Clerk, `user.created` is not subscribed, or delivery is failing — ' +
      'check Clerk dashboard -> Webhooks -> the endpoint -> Message Attempts.',
  )

  if (profile) {
    check('email denormalized', profile.email?.includes('live-signup-'), profile.email)
    check('display name assembled', profile.display_name === 'Live Signup', profile.display_name)

    const settings = await svc(`platform_settings?key=eq.signup_grant_credits&select=value`)
    const expected = Number(settings?.[0]?.value ?? 0)
    const bal = await svc(`credit_balances?user_id=eq.${user.id}&select=available_balance`)
    check(
      `signup grant of ${expected} credits applied`,
      Number(bal?.[0]?.available_balance ?? 0) === expected,
      `balance is ${bal?.[0]?.available_balance ?? 'none'}`,
    )

    const prefs = await svc(`notification_preferences?user_id=eq.${user.id}&select=user_id`)
    check('notification preferences created', (prefs ?? []).length === 1)
  }
} finally {
  console.log('\nCleaning up...')
  if (user) {
    await clerk(`/users/${user.id}`, { method: 'DELETE' }).catch(() => {})
    await sleep(2500) // let user.deleted land before we remove the rows
    await svc(`credit_ledger?user_id=eq.${user.id}`, { method: 'DELETE' })
    await svc(`notification_preferences?user_id=eq.${user.id}`, { method: 'DELETE' })
    await svc(`profiles?user_id=eq.${user.id}`, { method: 'DELETE' })
  }
}

console.log(`\n${passed} passed, ${failures.length} failed\n`)
if (failures.length) {
  console.log('PHASE 0 ACCEPTANCE: NOT PASSED.\n')
  process.exit(1)
}
console.log('PHASE 0 ACCEPTANCE: PASSED. A real signup produces a profile and credits.\n')
