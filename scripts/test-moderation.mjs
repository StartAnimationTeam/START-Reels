#!/usr/bin/env node
/**
 * Moderation + platform config over the real paths.
 *
 *   Reports: filed via RLS insert; cannot report as someone else; one open
 *   report per user per video; staff resolve/dismiss with prose; a decided
 *   report refuses re-decision; the reporter sees the outcome.
 *   Warnings: staff issue, target sees theirs and only theirs.
 *   Platform: promo create + toggle via admin-platform; redeem respects the
 *   toggle; settings allowlist holds (unknown key refused, bad value
 *   refused); maintenance mode blocks unlock for users, exempts staff, and
 *   switches back off.
 *
 * Usage:  node scripts/test-moderation.mjs
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
      email_address: [`modtest-${tag}-${suffix}@example.com`],
      password: `Md-${suffix}-Aa!`,
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

console.log('\nModeration + platform config - real paths\n')

let reporter, uploader, mod, admin, videoId

async function cleanup() {
  await sql(`
    update public.platform_settings set value = 'false'::jsonb where key = 'maintenance_mode';
    delete from public.promo_campaigns where code like 'MODTEST%';
  `)
  for (const u of [reporter, uploader, mod, admin]) {
    if (!u) continue
    await sql(`
      delete from public.audit_logs where actor_id = '${u.id}' or target_id = '${u.id}';
      delete from public.user_warnings where user_id = '${u.id}' or issued_by = '${u.id}';
      delete from public.video_reports where reporter_id = '${u.id}';
      delete from public.video_entitlements where user_id = '${u.id}';
      delete from public.credit_ledger where user_id = '${u.id}';
      delete from public.user_roles where user_id = '${u.id}';
      delete from public.profiles where user_id = '${u.id}';
    `)
    await clerk(`/sessions/${u.sessionId}/revoke`, { method: 'POST' }).catch(() => {})
    await clerk(`/users/${u.id}`, { method: 'DELETE' }).catch(() => {})
  }
  await sql(`delete from public.videos where slug = 'modtest-video'`)
}

try {
  ;[reporter, uploader, mod, admin] = await Promise.all([
    makeUser('rep'), makeUser('upl'), makeUser('mod'), makeUser('adm'),
  ])
  for (const u of [reporter, uploader, mod, admin]) {
    await sql(`insert into public.profiles (user_id, email) values ('${u.id}', '${u.email_addresses[0].email_address}') on conflict (user_id) do nothing;`)
  }
  await sql(`
    insert into public.user_roles (user_id, role) values ('${mod.id}', 'moderator');
    insert into public.user_roles (user_id, role) values ('${admin.id}', 'administrator');
    insert into public.videos (title, slug, creator_id, status, access_tier, credit_cost, duration_seconds, published_at)
    values ('Modtest', 'modtest-video', '${uploader.id}', 'published', 'free', 0, 100, now());
  `)
  videoId = (await sql(`select id from public.videos where slug = 'modtest-video'`))[0].id

  h.section('Filing reports')
  {
    const file = await rest('video_reports', reporter.jwt, {
      method: 'POST',
      body: { reporter_id: reporter.id, video_id: videoId, reason: 'inappropriate', detail: 'test detail' },
    })
    h.check('a user files a report through RLS', file.ok, `HTTP ${file.status}: ${JSON.stringify(file.data)}`)

    const forged = await rest('video_reports', reporter.jwt, {
      method: 'POST',
      body: { reporter_id: mod.id, video_id: videoId, reason: 'spam' },
    })
    h.check('cannot report under someone else', !forged.ok, `HTTP ${forged.status}`)

    const dup = await rest('video_reports', reporter.jwt, {
      method: 'POST',
      body: { reporter_id: reporter.id, video_id: videoId, reason: 'spam' },
    })
    h.check('one OPEN report per user per video', !dup.ok, `HTTP ${dup.status}`)
  }

  const reportId = (await sql(`
    select id from public.video_reports where reporter_id = '${reporter.id}' and status = 'open'
  `))[0].id

  h.section('Resolving')
  {
    const asPlain = await fn('moderation', reporter.jwt, { action: 'resolve', reportId })
    h.check('a plain user cannot resolve reports', asPlain.status === 403, `HTTP ${asPlain.status}`)

    const resolve = await fn('moderation', mod.jwt, {
      action: 'resolve', reportId, actionTaken: 'warned the uploader',
    })
    h.check('a moderator resolves with prose', resolve.status === 200, `HTTP ${resolve.status}: ${JSON.stringify(resolve.data)}`)

    const again = await fn('moderation', mod.jwt, { action: 'dismiss', reportId })
    h.check('re-deciding a decided report -> 409', again.status === 409, `HTTP ${again.status}`)

    const mine = await rest(`video_reports?id=eq.${reportId}&select=status,action_taken`, reporter.jwt)
    h.check('the reporter sees the outcome', mine.data?.[0]?.status === 'actioned', JSON.stringify(mine.data))

    const audits = await sql(`select 1 from public.audit_logs where target_type = 'video_report' and target_id = '${reportId}'`)
    h.check('resolution is audited', audits.length === 1)
  }

  h.section('Warnings')
  {
    const warn = await fn('moderation', mod.jwt, {
      action: 'warn', userId: uploader.id, reason: 'Metadata was misleading', severity: 'warning', reportId,
    })
    h.check('a moderator warns the uploader', warn.status === 200, `HTTP ${warn.status}: ${JSON.stringify(warn.data)}`)

    const theirs = await rest('user_warnings?select=reason,severity', uploader.jwt)
    h.check('the warned user sees their warning', theirs.data?.length === 1, JSON.stringify(theirs.data))

    const others = await rest('user_warnings?select=reason', reporter.jwt)
    h.check("another user sees none of it", (others.data ?? []).length === 0, `saw ${(others.data ?? []).length}`)

    const selfWarn = await fn('moderation', mod.jwt, { action: 'warn', userId: mod.id, reason: 'nope' })
    h.check('cannot warn yourself', selfWarn.status === 400, `HTTP ${selfWarn.status}`)
  }

  h.section('Promo administration')
  {
    const asMod = await fn('admin-platform', mod.jwt, {
      action: 'create_promo', code: 'MODTEST-X', name: 'x', amount: 5,
    })
    h.check('a moderator cannot touch platform config', asMod.status === 403, `HTTP ${asMod.status}`)

    const create = await fn('admin-platform', admin.jwt, {
      action: 'create_promo', code: 'modtest-5', name: 'Mod test', amount: 5, perUserLimit: 1,
    })
    h.check('admin creates a promo (code upcased)', create.status === 200 && create.data?.campaign?.code === 'MODTEST-5',
      `HTTP ${create.status}: ${JSON.stringify(create.data)}`)
    const campaignId = create.data?.campaign?.id

    const taken = await fn('admin-platform', admin.jwt, {
      action: 'create_promo', code: 'MODTEST-5', name: 'again', amount: 5,
    })
    h.check('duplicate code -> 409', taken.status === 409, `HTTP ${taken.status}`)

    const redeem = await rest('rpc/redeem_promo', reporter.jwt, { method: 'POST', body: { p_code: 'MODTEST-5' } })
    h.check('the new code redeems', redeem.ok, `HTTP ${redeem.status}: ${JSON.stringify(redeem.data)}`)

    const off = await fn('admin-platform', admin.jwt, { action: 'set_promo_active', campaignId, active: false })
    h.check('admin deactivates it', off.status === 200, `HTTP ${off.status}`)

    const redeemOff = await rest('rpc/redeem_promo', uploader.jwt, { method: 'POST', body: { p_code: 'MODTEST-5' } })
    h.check('a deactivated code refuses with the generic error',
      !redeemOff.ok && JSON.stringify(redeemOff.data).includes('promo_invalid'),
      `HTTP ${redeemOff.status}`)
  }

  h.section('Settings allowlist')
  {
    const unknown = await fn('admin-platform', admin.jwt, {
      action: 'update_setting', key: 'platform_timezone', value: 'UTC',
    })
    h.check('a key outside the allowlist is refused (timezone changes are a migration, not a click)',
      unknown.status === 400 && unknown.data?.error === 'setting_not_editable', `HTTP ${unknown.status}`)

    const badValue = await fn('admin-platform', admin.jwt, {
      action: 'update_setting', key: 'daily_reward_amount', value: 99999,
    })
    h.check('an out-of-range value is refused', badValue.status === 400, `HTTP ${badValue.status}`)

    const good = await fn('admin-platform', admin.jwt, {
      action: 'update_setting', key: 'daily_reward_amount', value: 2,
    })
    h.check('a valid update lands', good.status === 200, `HTTP ${good.status}`)
    const row = await sql(`select value #>> '{}' as v from public.platform_settings where key = 'daily_reward_amount'`)
    h.check('...and is in the table', row[0].v === '2', row[0].v)
    await fn('admin-platform', admin.jwt, { action: 'update_setting', key: 'daily_reward_amount', value: 1 })
  }

  h.section('Maintenance mode')
  {
    const on = await fn('admin-platform', admin.jwt, {
      action: 'update_setting', key: 'maintenance_mode', value: true,
    })
    h.check('admin switches maintenance on', on.status === 200, `HTTP ${on.status}`)

    const blocked = await fn('video-unlock', reporter.jwt, { videoId })
    h.check('a user cannot unlock during maintenance (503)',
      blocked.status === 503 && blocked.data?.error === 'maintenance_mode', `HTTP ${blocked.status}`)

    const staffOk = await fn('video-unlock', admin.jwt, { videoId })
    h.check('staff pass through (verifying the fix is the point)', staffOk.status === 200, `HTTP ${staffOk.status}`)

    const off = await fn('admin-platform', admin.jwt, {
      action: 'update_setting', key: 'maintenance_mode', value: false,
    })
    h.check('maintenance off again', off.status === 200, `HTTP ${off.status}`)

    const normal = await fn('video-unlock', reporter.jwt, { videoId })
    h.check('users unlock again after', normal.status === 200, `HTTP ${normal.status}`)
  }
} finally {
  console.log('\nCleaning up...')
  await cleanup()
}

h.finish('MODERATION + PLATFORM')
