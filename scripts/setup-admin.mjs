#!/usr/bin/env node
/**
 * Grant the first administrator.
 *
 * Roles live in OUR user_roles table, not in Clerk metadata — so the very
 * first administrator has to be granted from outside the app (every admin
 * surface requires an admin to already exist; this is the bootstrap).
 *
 * Restricted to BOOTSTRAP_ADMIN_EMAILS from .env: this script runs with
 * operator credentials anyway, but the allowlist stops a copy-pasted command
 * from quietly granting the wrong account.
 *
 * The role INSERT goes through SQL so the user_role_audit trigger records it —
 * the audit row is written by trigger precisely so paths like this one cannot
 * skip it.
 *
 * Usage:
 *   node scripts/setup-admin.mjs                      # grant everyone allowlisted
 *   node scripts/setup-admin.mjs someone@company.com  # grant one (must be allowlisted)
 */

import { loadEnv, sql } from './_db.mjs'

const env = loadEnv()

const allowlist = (env.BOOTSTRAP_ADMIN_EMAILS ?? '')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean)

if (allowlist.length === 0) {
  console.error('\nBOOTSTRAP_ADMIN_EMAILS is empty in .env — nothing to grant.\n')
  process.exit(2)
}

const requested = process.argv[2]?.toLowerCase()
const targets = requested ? [requested] : allowlist

if (requested && !allowlist.includes(requested)) {
  console.error(`\n${requested} is not in BOOTSTRAP_ADMIN_EMAILS. Add it there first.\n`)
  process.exit(2)
}

console.log('\nBootstrap administrator grant\n')

for (const email of targets) {
  // Find the Clerk user — Clerk is the identity authority; a profile row
  // without a Clerk account would be a ghost we shouldn't empower.
  const res = await fetch(
    `https://api.clerk.com/v1/users?email_address=${encodeURIComponent(email)}`,
    { headers: { Authorization: `Bearer ${env.CLERK_SECRET_KEY}` } },
  )
  const users = await res.json()
  const user = Array.isArray(users) ? users[0] : null

  if (!user) {
    console.log(`  SKIP  ${email} — no Clerk account yet. Sign up at the app first, then re-run.`)
    continue
  }

  // Profile may not exist if the webhook hasn't fired; upsert it so the grant
  // never dangles.
  await sql(`
    insert into public.profiles (user_id, email)
    values ('${user.id}', '${email.replace(/'/g, "''")}')
    on conflict (user_id) do nothing;
  `)

  const existing = await sql(`
    select 1 from public.user_roles
    where user_id = '${user.id}' and role = 'administrator'
  `)
  if (existing.length) {
    console.log(`  OK    ${email} is already an administrator (${user.id})`)
    continue
  }

  await sql(`
    insert into public.user_roles (user_id, role, granted_by)
    values ('${user.id}', 'administrator', 'setup-admin.mjs');
  `)
  console.log(`  GRANT ${email} -> administrator (${user.id})`)
}

const audit = await sql(`
  select user_id, action, actor, occurred_at
  from public.user_role_audit
  order by occurred_at desc limit 3
`)
console.log('\nAudit trail (written by trigger):')
for (const row of audit) {
  console.log(`  ${row.occurred_at}  ${row.action}  ${row.user_id}  by ${row.actor ?? '?'}`)
}
console.log('')
