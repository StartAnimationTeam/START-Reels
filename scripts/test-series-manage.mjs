#!/usr/bin/env node
/**
 * series-manage over the deployed function, with real Clerk JWTs.
 *
 *   - a plain user cannot create a series; a creator can (draft)
 *   - a creator edits their OWN draft; not someone else's; staff edit any
 *   - publish is staff-only and refuses a series with no published episode
 *   - once published, the creator can no longer edit (moderation posture)
 *   - remove is ADMIN-only and revoke-refunds every live episode — asserted
 *     against the ledger, not the response
 *   - every mutation lands in audit_logs
 *
 * Usage:  node scripts/test-series-manage.mjs
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
      email_address: [`smgr-${tag}-${suffix}@example.com`],
      password: `Sm-${suffix}-Aa!`,
      skip_password_checks: true,
    }),
  })
  const session = await clerk('/sessions', { method: 'POST', body: JSON.stringify({ user_id: user.id }) })
  const jwt = (await clerk(`/sessions/${session.id}/tokens`, { method: 'POST', body: '{}' })).jwt
  return { ...user, sessionId: session.id, jwt }
}

const fn = (jwt, body) =>
  fetch(`${env.SUPABASE_URL}/functions/v1/series-manage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }))

console.log('\nseries-manage - deployed function, real JWTs\n')

let plain, creator, rival, admin

async function cleanup() {
  await sql(`
    delete from public.video_entitlements where video_id in
      (select id from public.videos where slug like 'smgr-%');
    delete from public.videos where slug like 'smgr-%';
    delete from public.series where slug like 'smgr-%' or title like 'SMGR %';
  `)
  for (const u of [plain, creator, rival, admin]) {
    if (!u) continue
    await sql(`
      delete from public.audit_logs where actor_id = '${u.id}';
      delete from public.user_roles where user_id = '${u.id}';
      delete from public.credit_ledger where user_id = '${u.id}';
      delete from public.profiles where user_id = '${u.id}';
    `)
    await clerk(`/sessions/${u.sessionId}/revoke`, { method: 'POST' }).catch(() => {})
    await clerk(`/users/${u.id}`, { method: 'DELETE' }).catch(() => {})
  }
}

try {
  ;[plain, creator, rival, admin] = await Promise.all([
    makeUser('plain'), makeUser('creator'), makeUser('rival'), makeUser('admin'),
  ])
  for (const u of [plain, creator, rival, admin]) {
    await sql(`insert into public.profiles (user_id, email) values ('${u.id}', '${u.email_addresses[0].email_address}') on conflict (user_id) do nothing;`)
  }
  await sql(`
    insert into public.user_roles (user_id, role) values
      ('${creator.id}', 'creator'), ('${rival.id}', 'creator'), ('${admin.id}', 'administrator');
  `)

  h.section('Role matrix: create')
  const denied = await fn(plain.jwt, { action: 'create_series', title: 'SMGR nope' })
  h.check('a plain user cannot create a series', denied.status === 403, `HTTP ${denied.status}`)

  const created = await fn(creator.jwt, { action: 'create_series', title: 'SMGR My Show', freeEpisodeCount: 1, episodeCreditCost: 2 })
  h.check('a creator can create a draft series', created.status === 200 && created.data?.series?.status === 'draft',
    `HTTP ${created.status}: ${JSON.stringify(created.data)}`)
  const sid = created.data?.series?.id

  h.section('Role matrix: update')
  const own = await fn(creator.jwt, { action: 'update_series', seriesId: sid, synopsis: 'mine to shape' })
  h.check('the creator edits their own draft', own.status === 200, `HTTP ${own.status}: ${JSON.stringify(own.data)}`)

  const meddle = await fn(rival.jwt, { action: 'update_series', seriesId: sid, synopsis: 'hostile takeover' })
  h.check("another creator cannot edit someone else's draft", meddle.status === 403, `HTTP ${meddle.status}`)

  const staffEdit = await fn(admin.jwt, { action: 'update_series', seriesId: sid, title: 'SMGR My Show (edited)' })
  h.check('staff edit any series', staffEdit.status === 200, `HTTP ${staffEdit.status}`)

  h.section('Publish gate')
  const early = await fn(admin.jwt, { action: 'publish_series', seriesId: sid })
  h.check('publishing with zero published episodes is refused (409)', early.status === 409, `HTTP ${early.status}: ${JSON.stringify(early.data)}`)

  const creatorPublish = await fn(creator.jwt, { action: 'publish_series', seriesId: sid })
  h.check('the creator cannot publish their own series', creatorPublish.status === 403, `HTTP ${creatorPublish.status}`)

  // Seed a published episode directly (the upload/encode path is covered by
  // test-ingest-live), then publish for real.
  await sql(`
    insert into public.videos (title, slug, creator_id, status, access_tier, credit_cost, series_id, episode_number, published_at, duration_seconds)
    values ('SMGR Ep1', 'smgr-ep-1', '${creator.id}', 'published', 'free', 0, '${sid}', 1, now(), 75),
           ('SMGR Ep2', 'smgr-ep-2', '${creator.id}', 'published', 'premium', 2, '${sid}', 2, now(), 80);
  `)
  const pub = await fn(admin.jwt, { action: 'publish_series', seriesId: sid })
  h.check('staff publish once an episode is live', pub.status === 200 && pub.data?.series?.status === 'published',
    `HTTP ${pub.status}: ${JSON.stringify(pub.data)}`)

  const lateEdit = await fn(creator.jwt, { action: 'update_series', seriesId: sid, synopsis: 'post-publish edit' })
  h.check('once published, the creator can no longer edit (staff only)', lateEdit.status === 403, `HTTP ${lateEdit.status}`)

  h.section('Remove revokes and refunds')
  {
    // A real paid unlock through the DB truth, then remove the series: the
    // ledger must show the refund, not just the HTTP body claiming one.
    await sql(`select public.grant_credits('${plain.id}', 5, 'admin_grant', null, null, 'watch', 'smgr-seed', '{}'::jsonb)`)
    const ep2 = (await sql(`select id from public.videos where slug = 'smgr-ep-2'`))[0].id
    await sql(`select public.unlock_video('${plain.id}', '${ep2}')`)
    // Settle the hold so the refund path (not the reversal path) is exercised.
    const ledgerId = (await sql(`
      select ledger_id from public.video_entitlements
      where user_id = '${plain.id}' and video_id = '${ep2}'
    `))[0].ledger_id
    await sql(`select public.settle_credit_hold('${ledgerId}', true)`)

    const modDenied = await fn(creator.jwt, { action: 'remove_series', seriesId: sid })
    h.check('remove is refused below administrator', modDenied.status === 403, `HTTP ${modDenied.status}`)

    const removed = await fn(admin.jwt, { action: 'remove_series', seriesId: sid, reason: 'smgr test teardown' })
    h.check('an administrator removes the series', removed.status === 200, `HTTP ${removed.status}: ${JSON.stringify(removed.data)}`)
    h.check('…reporting the revoked entitlement', Number(removed.data?.entitlements_revoked) === 1, JSON.stringify(removed.data))

    // The signup webhook credits real Clerk users on its own schedule, so an
    // absolute balance races it. The invariant that cannot race: the spend
    // and its refund cancel exactly.
    const net = await sql(`
      select coalesce(sum(amount), 0) as n from public.credit_ledger
      where user_id = '${plain.id}' and reason in ('watch_debit', 'refund')
    `)
    h.check('the spend and its refund cancel exactly (net 0)', Number(net[0].n) === 0, `net ${net[0].n}`)

    const refundRow = await sql(`
      select count(*)::int as n from public.credit_ledger
      where user_id = '${plain.id}' and reason = 'refund' and status = 'committed'
    `)
    h.check('…as an explicit refund ledger row', refundRow[0].n === 1, `${refundRow[0].n} row(s)`)

    const gone = await sql(`select status, deleted_at from public.videos where slug like 'smgr-ep-%'`)
    h.check('every episode is removed with the series',
      gone.every((v) => v.status === 'removed' && v.deleted_at !== null), JSON.stringify(gone))
  }

  h.section('Audit trail')
  {
    const trail = await sql(`
      select action from public.audit_logs
      where actor_id in ('${creator.id}', '${admin.id}') and target_type = 'series'
      order by created_at
    `)
    const actions = trail.map((r) => r.action)
    const expected = ['series.create', 'series.update', 'series.update', 'series.publish', 'series.remove']
    h.check('every mutation is audited in order',
      expected.every((a) => actions.includes(a)),
      `saw: ${actions.join(', ')}`)
  }

  await cleanup()
} catch (err) {
  console.error(`\nSuite error: ${err.message}\n`)
  await cleanup().catch(() => {})
  process.exit(1)
}

h.finish('SERIES MANAGE')
