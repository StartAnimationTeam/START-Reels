#!/usr/bin/env node
/**
 * clerk-webhook end-to-end.
 *
 * Signs payloads the way svix does and posts them at the deployed function, so
 * this exercises the real signature verification, the real claim-first
 * idempotency table and the real credit grant — not a local mock.
 *
 * The three properties it exists to prove:
 *
 *   1. A forged signature is rejected. Anyone who learns this URL could
 *      otherwise POST themselves a profile and a credit grant.
 *   2. A valid user.created creates the profile, the notification prefs and the
 *      signup grant.
 *   3. **A REPLAY DOES NOT DOUBLE-GRANT.** This is the one that matters. Clerk
 *      retries, and a retry that re-runs the work is exactly how the sibling
 *      project silently doubled a user's balance with nothing in the logs.
 *      Protected twice over — the claim row and the ledger's own idempotency
 *      key — and this asserts both hold.
 *
 * Usage:  node scripts/test-webhook.mjs
 */

import { createHmac, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}

const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, CLERK_WEBHOOK_SECRET } =
  process.env

const ENDPOINT = `${SUPABASE_URL}/functions/v1/clerk-webhook`

if (!CLERK_WEBHOOK_SECRET) {
  console.error('\nCLERK_WEBHOOK_SECRET missing from .env\n')
  process.exit(2)
}

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

/**
 * svix signs `${id}.${timestamp}.${body}` with HMAC-SHA256, using the secret
 * base64-DECODED after stripping the `whsec_` prefix. Signing the literal
 * string instead is the usual mistake and produces a signature that never
 * verifies.
 */
function sign(id, timestamp, body) {
  const key = Buffer.from(CLERK_WEBHOOK_SECRET.replace(/^whsec_/, ''), 'base64')
  const sig = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')
  return `v1,${sig}`
}

async function post(event, { id = `msg_${randomUUID()}`, forge = false } = {}) {
  const body = JSON.stringify(event)
  const ts = String(Math.floor(Date.now() / 1000))
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'svix-id': id,
      'svix-timestamp': ts,
      'svix-signature': forge ? 'v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' : sign(id, ts, body),
    },
    body,
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = text
  }
  return { status: res.status, data: json, id }
}

async function svc(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

const uid = `user_wht_${randomUUID().replace(/-/g, '').slice(0, 20)}`
const email = `webhook-test-${Date.now()}@example.com`

console.log('\nclerk-webhook end-to-end\n')

try {
  // -- 1. forged signature ---------------------------------------------------
  console.log('Signature verification:')
  {
    const r = await post(
      { type: 'user.created', data: { id: 'user_forged', email_addresses: [] } },
      { forge: true },
    )
    check('a forged signature is rejected', r.status === 401, `HTTP ${r.status}: ${JSON.stringify(r.data)}`)

    const rows = await svc(`profiles?user_id=eq.user_forged&select=user_id`)
    check('the forged event created nothing', (rows ?? []).length === 0)
  }

  // -- 2. genuine user.created ----------------------------------------------
  console.log('\nuser.created:')
  const created = {
    type: 'user.created',
    data: {
      id: uid,
      email_addresses: [{ id: 'idn_1', email_address: email }],
      primary_email_address_id: 'idn_1',
      first_name: 'Webhook',
      last_name: 'Test',
    },
  }

  const first = await post(created)
  check('accepted', first.status === 200, `HTTP ${first.status}: ${JSON.stringify(first.data)}`)

  {
    const rows = await svc(`profiles?user_id=eq.${uid}&select=user_id,email,display_name`)
    check('profile row created', (rows ?? []).length === 1, JSON.stringify(rows))
    check('email denormalized from Clerk', rows?.[0]?.email === email, rows?.[0]?.email)
    check('display name assembled', rows?.[0]?.display_name === 'Webhook Test', rows?.[0]?.display_name)
  }
  {
    const rows = await svc(`notification_preferences?user_id=eq.${uid}&select=user_id`)
    check('notification preferences created', (rows ?? []).length === 1)
  }

  const settings = await svc(`platform_settings?key=eq.signup_grant_credits&select=value`)
  const expected = Number(settings?.[0]?.value ?? 0)

  {
    const rows = await svc(`credit_balances?user_id=eq.${uid}&select=available_balance`)
    check(
      `signup grant of ${expected} credits applied`,
      Number(rows?.[0]?.available_balance ?? 0) === expected,
      `balance is ${rows?.[0]?.available_balance}`,
    )
  }

  // -- 3. the one that matters ----------------------------------------------
  console.log('\nReplay (the failure mode that bit the sibling project):')
  {
    const replay = await post(created, { id: first.id })
    check('a replayed event returns 200, not an error', replay.status === 200, `HTTP ${replay.status}`)
    check('...and is reported as a replay', replay.data?.replay === true, JSON.stringify(replay.data))

    const rows = await svc(`credit_balances?user_id=eq.${uid}&select=available_balance`)
    check(
      'REPLAY DID NOT DOUBLE THE BALANCE',
      Number(rows?.[0]?.available_balance ?? 0) === expected,
      `balance is ${rows?.[0]?.available_balance}, expected ${expected}`,
    )
  }
  {
    // A different svix-id defeats the claim table, so only the ledger's own
    // idempotency key stands between this and a second grant. That redundancy
    // is the point of having both.
    const dup = await post(created)
    check('a NEW event id for the same user still returns 200', dup.status === 200, `HTTP ${dup.status}`)

    const rows = await svc(`credit_balances?user_id=eq.${uid}&select=available_balance`)
    check(
      'the ledger idempotency key blocks a second grant on its own',
      Number(rows?.[0]?.available_balance ?? 0) === expected,
      `balance is ${rows?.[0]?.available_balance}, expected ${expected}`,
    )
  }

  // -- 4. update / delete ----------------------------------------------------
  console.log('\nuser.updated and user.deleted:')
  {
    const r = await post({
      type: 'user.updated',
      data: {
        id: uid,
        email_addresses: [{ id: 'idn_1', email_address: email }],
        primary_email_address_id: 'idn_1',
        first_name: 'Renamed',
        last_name: 'User',
      },
    })
    check('user.updated accepted', r.status === 200, `HTTP ${r.status}`)

    const rows = await svc(`profiles?user_id=eq.${uid}&select=display_name`)
    check('display name refreshed', rows?.[0]?.display_name === 'Renamed User', rows?.[0]?.display_name)
  }
  {
    const r = await post({ type: 'user.deleted', data: { id: uid, deleted: true } })
    check('user.deleted accepted', r.status === 200, `HTTP ${r.status}`)

    const rows = await svc(`profiles?user_id=eq.${uid}&select=deleted_at`)
    check('profile soft-deleted, not removed', Boolean(rows?.[0]?.deleted_at), JSON.stringify(rows))

    const ledger = await svc(`credit_ledger?user_id=eq.${uid}&select=id`)
    check('ledger rows survive the delete (append-only)', (ledger ?? []).length > 0, `${(ledger ?? []).length} rows`)
  }
} finally {
  console.log('\nCleaning up...')
  await svc(`credit_ledger?user_id=eq.${uid}`, { method: 'DELETE' })
  await svc(`notification_preferences?user_id=eq.${uid}`, { method: 'DELETE' })
  await svc(`profiles?user_id=eq.${uid}`, { method: 'DELETE' })
  await svc(`processed_webhook_events?source=eq.clerk&completed_at=not.is.null`, { method: 'DELETE' })
}

console.log(`\n${passed} passed, ${failures.length} failed\n`)
if (failures.length) {
  console.log('Failures:')
  for (const f of failures) console.log(`  - ${f}`)
  console.log('')
  process.exit(1)
}
console.log('Webhook OK.\n')
