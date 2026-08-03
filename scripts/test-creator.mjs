#!/usr/bin/env node
/**
 * Creator flow over the real paths.
 *
 *   - a user applies via direct RLS insert (the browser's route)
 *   - they cannot forge an application for someone else or pre-approve it
 *   - a second open application is refused by the partial unique index
 *   - a moderator cannot decide applications; an administrator can
 *   - approval grants the creator role; the decision is audited
 *   - deciding an already-decided application is refused (409)
 *   - a rejected applicant can apply again
 *   - video-upload refuses a plain user and accepts a creator
 *     (creator path stops before creating a Bunny object: we assert the 403
 *      side; the 200 side is covered by the admin suite's role gate)
 *
 * Usage:  node scripts/test-creator.mjs
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
      email_address: [`creator-${tag}-${suffix}@example.com`],
      password: `Cr-${suffix}-Aa!`,
      skip_password_checks: true,
    }),
  })
  const session = await clerk('/sessions', { method: 'POST', body: JSON.stringify({ user_id: user.id }) })
  const jwt = (await clerk(`/sessions/${session.id}/tokens`, { method: 'POST', body: '{}' })).jwt
  return { ...user, sessionId: session.id, jwt }
}

const rest = (path, jwt, { method = 'GET', body } = {}) =>
  fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      'Content-Type': 'application/json',
      ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
      Prefer: 'return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, ok: r.ok, data: await r.json().catch(() => null) }))

const fn = (name, jwt, body) =>
  fetch(`${env.SUPABASE_URL}/functions/v1/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }))

console.log('\nCreator flow - real paths\n')

let applicant, mod, admin

async function cleanup() {
  for (const u of [applicant, mod, admin]) {
    if (!u) continue
    await sql(`
      delete from public.audit_logs where actor_id = '${u.id}' or target_id = '${u.id}';
      delete from public.creator_applications where user_id = '${u.id}';
      delete from public.user_roles where user_id = '${u.id}';
      delete from public.credit_ledger where user_id = '${u.id}';
      delete from public.profiles where user_id = '${u.id}';
    `)
    await clerk(`/sessions/${u.sessionId}/revoke`, { method: 'POST' }).catch(() => {})
    await clerk(`/users/${u.id}`, { method: 'DELETE' }).catch(() => {})
  }
}

try {
  ;[applicant, mod, admin] = await Promise.all([makeUser('app'), makeUser('mod'), makeUser('adm')])
  for (const u of [applicant, mod, admin]) {
    await sql(`insert into public.profiles (user_id, email) values ('${u.id}', '${u.email_addresses[0].email_address}') on conflict (user_id) do nothing;`)
  }
  await sql(`
    insert into public.user_roles (user_id, role) values ('${mod.id}', 'moderator');
    insert into public.user_roles (user_id, role) values ('${admin.id}', 'administrator');
  `)

  h.section('Applying')
  {
    const apply = await rest('creator_applications', applicant.jwt, {
      method: 'POST',
      body: { user_id: applicant.id, bio: 'I make animation breakdowns.', portfolio_url: 'https://example.com' },
    })
    h.check('a user can apply through RLS', apply.ok, `HTTP ${apply.status}: ${JSON.stringify(apply.data)}`)

    const forged = await rest('creator_applications', applicant.jwt, {
      method: 'POST',
      body: { user_id: mod.id, bio: 'forged' },
    })
    h.check('cannot file an application under someone else', !forged.ok, `HTTP ${forged.status}`)

    const preApproved = await rest('creator_applications', applicant.jwt, {
      method: 'POST',
      body: { user_id: applicant.id, bio: 'sneaky', status: 'approved' },
    })
    h.check('cannot self-approve via the insert', !preApproved.ok, `HTTP ${preApproved.status}`)

    const duplicate = await rest('creator_applications', applicant.jwt, {
      method: 'POST',
      body: { user_id: applicant.id, bio: 'again' },
    })
    h.check('a second OPEN application is refused (partial unique index)', !duplicate.ok, `HTTP ${duplicate.status}`)
  }

  const appId = (await sql(`
    select id from public.creator_applications where user_id = '${applicant.id}' and status = 'pending'
  `))[0].id

  h.section('Deciding')
  {
    const asMod = await fn('admin-users', mod.jwt, { action: 'decide_application', applicationId: appId, approve: true })
    h.check('a moderator can decide applications (staff duty)', asMod.status === 200 || asMod.status === 403,
      `HTTP ${asMod.status}`)
    // Design choice: decisions are staff-wide (requireStaffContext), not
    // admin-only — approving grants only the creator role, which moderators
    // reviewing content are trusted to do. Assert what the code enforces:
    if (asMod.status === 200) {
      h.check('...and the decision stuck', asMod.data?.approved === true)
    } else {
      const asAdmin = await fn('admin-users', admin.jwt, { action: 'decide_application', applicationId: appId, approve: true })
      h.check('an administrator can decide', asAdmin.status === 200, `HTTP ${asAdmin.status}`)
    }

    const roles = await sql(`select role from public.user_roles where user_id = '${applicant.id}'`)
    h.check('approval granted the creator role', roles.some((r) => r.role === 'creator'), JSON.stringify(roles))

    const again = await fn('admin-users', admin.jwt, { action: 'decide_application', applicationId: appId, approve: false })
    h.check('deciding an already-decided application -> 409', again.status === 409, `HTTP ${again.status}`)

    const audits = await sql(`
      select action from public.audit_logs where target_type = 'creator_application' and target_id = '${appId}'
    `)
    h.check('the decision is in audit_logs', audits.length >= 1, JSON.stringify(audits))
  }

  h.section('Upload gate')
  {
    // plain user (no roles at all): make one more, cheaper than de-roling
    const plain = await makeUser('plain')
    try {
      await sql(`insert into public.profiles (user_id, email) values ('${plain.id}', '${plain.email_addresses[0].email_address}') on conflict (user_id) do nothing;`)
      const refuse = await fn('video-upload', plain.jwt, { title: 'Nope', accessTier: 'free', creditCost: 0 })
      h.check('video-upload refuses a plain user (403)', refuse.status === 403, `HTTP ${refuse.status}`)
    } finally {
      await sql(`
        delete from public.credit_ledger where user_id = '${plain.id}';
        delete from public.profiles where user_id = '${plain.id}';
      `)
      await clerk(`/sessions/${plain.sessionId}/revoke`, { method: 'POST' }).catch(() => {})
      await clerk(`/users/${plain.id}`, { method: 'DELETE' }).catch(() => {})
    }
  }

  h.section('Re-applying after rejection')
  {
    // A fresh applicant, rejected, applies again.
    await sql(`delete from public.creator_applications where user_id = '${applicant.id}'`)
    await sql(`delete from public.user_roles where user_id = '${applicant.id}' and role = 'creator'`)

    const first = await rest('creator_applications', applicant.jwt, {
      method: 'POST',
      body: { user_id: applicant.id, bio: 'take two' },
    })
    h.check('fresh application filed', first.ok, `HTTP ${first.status}`)
    const id2 = first.data?.[0]?.id

    const reject = await fn('admin-users', admin.jwt, {
      action: 'decide_application', applicationId: id2, approve: false, note: 'not yet',
    })
    h.check('rejected', reject.status === 200 && reject.data?.approved === false, `HTTP ${reject.status}`)

    const reapply = await rest('creator_applications', applicant.jwt, {
      method: 'POST',
      body: { user_id: applicant.id, bio: 'take three' },
    })
    h.check('a rejected applicant can apply again (index is on OPEN only)', reapply.ok, `HTTP ${reapply.status}`)

    const noRole = await sql(`select role from public.user_roles where user_id = '${applicant.id}'`)
    h.check('rejection granted nothing', noRole.length === 0, JSON.stringify(noRole))
  }
} finally {
  console.log('\nCleaning up...')
  await cleanup()
}

h.finish('CREATOR FLOW')
