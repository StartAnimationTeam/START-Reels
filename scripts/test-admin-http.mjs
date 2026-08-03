#!/usr/bin/env node
/**
 * Admin endpoints over real HTTP.
 *
 * The properties that matter:
 *   - a PLAIN user gets 403 from every admin action (roles come from
 *     user_roles, and the functions check it server-side per request)
 *   - a moderator can suspend but CANNOT grant roles or move credits
 *   - an administrator can do all of it
 *   - every mutation lands in audit_logs BEFORE success is reported
 *   - self-protection: no self-suspend, no self-de-admin
 *   - remove refunds: deleting a paid video gives buyers their credits back
 *
 * Usage:  node scripts/test-admin-http.mjs
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
      email_address: [`admin-test-${tag}-${suffix}@example.com`],
      password: `At-${suffix}-Aa!`,
      skip_password_checks: true,
    }),
  })
  const session = await clerk('/sessions', { method: 'POST', body: JSON.stringify({ user_id: user.id }) })
  const jwt = (await clerk(`/sessions/${session.id}/tokens`, { method: 'POST', body: '{}' })).jwt
  return { ...user, sessionId: session.id, jwt }
}

const fn = (name, jwt, body) =>
  fetch(`${env.SUPABASE_URL}/functions/v1/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }))

console.log('\nAdmin endpoints over HTTP\n')

let plain, mod, admin, videoId

async function cleanup() {
  for (const u of [plain, mod, admin]) {
    if (!u) continue
    await sql(`
      delete from public.video_entitlements where user_id = '${u.id}';
      delete from public.credit_ledger where user_id = '${u.id}';
      delete from public.user_roles where user_id = '${u.id}';
      delete from public.profiles where user_id = '${u.id}';
    `)
    await clerk(`/sessions/${u.sessionId}/revoke`, { method: 'POST' }).catch(() => {})
    await clerk(`/users/${u.id}`, { method: 'DELETE' }).catch(() => {})
  }
  await sql(`
    delete from public.audit_logs where target_id in (select id::text from public.videos where slug like 'admin-http-%');
    delete from public.videos where slug like 'admin-http-%';
  `)
}

try {
  console.log('Creating a plain user, a moderator and an administrator...')
  ;[plain, mod, admin] = await Promise.all([makeUser('plain'), makeUser('mod'), makeUser('adm')])
  for (const u of [plain, mod, admin]) {
    await sql(`insert into public.profiles (user_id, email) values ('${u.id}', '${u.email_addresses[0].email_address}') on conflict (user_id) do nothing;`)
  }
  await sql(`
    insert into public.user_roles (user_id, role) values ('${mod.id}', 'moderator');
    insert into public.user_roles (user_id, role) values ('${admin.id}', 'administrator');
    insert into public.videos (title, slug, creator_id, status, access_tier, credit_cost, duration_seconds, published_at, provider_asset_id)
    values ('Admin HTTP Test', 'admin-http-video', 'admin_http_creator', 'published', 'premium', 1, 300, now(), 'admin-http-guid');
    select public.grant_credits('${plain.id}', 5, 'admin_grant', null, null, 'watch', 'admin-http-seed', '{}'::jsonb);
  `)
  videoId = (await sql(`select id from public.videos where slug = 'admin-http-video'`))[0].id

  h.section('Plain users are locked out')
  {
    const v = await fn('admin-videos', plain.jwt, { action: 'publish', videoId })
    h.check('admin-videos -> 403 for a plain user', v.status === 403, `HTTP ${v.status}`)
    const u = await fn('admin-users', plain.jwt, { action: 'suspend', userId: mod.id })
    h.check('admin-users -> 403 for a plain user', u.status === 403, `HTTP ${u.status}`)
  }

  h.section('Moderator: moderation yes, roles and credits no')
  {
    const suspend = await fn('admin-users', mod.jwt, { action: 'suspend', userId: plain.id, reason: 'test' })
    h.check('moderator can suspend a user', suspend.status === 200, `HTTP ${suspend.status}: ${JSON.stringify(suspend.data)}`)

    const role = await fn('admin-users', mod.jwt, { action: 'set_role', userId: plain.id, role: 'moderator' })
    h.check('moderator CANNOT grant roles', role.status === 403, `HTTP ${role.status}`)

    const credits = await fn('admin-users', mod.jwt, { action: 'grant_credits', userId: plain.id, amount: 100 })
    h.check('moderator CANNOT grant credits', credits.status === 403, `HTTP ${credits.status}`)

    const unsuspend = await fn('admin-users', mod.jwt, { action: 'unsuspend', userId: plain.id })
    h.check('moderator can unsuspend', unsuspend.status === 200, `HTTP ${unsuspend.status}`)
  }

  h.section('Administrator: full control, all audited')
  {
    const role = await fn('admin-users', admin.jwt, { action: 'set_role', userId: plain.id, role: 'creator' })
    h.check('admin grants the creator role', role.status === 200, `HTTP ${role.status}: ${JSON.stringify(role.data)}`)

    // Baseline BEFORE the grant: creating real Clerk users fires the real
    // signup webhook on its own schedule, so absolute balances race it — the
    // deltas cannot. (Same lesson as test-playback-http.)
    const base = Number((await sql(`select public.available_credits('${plain.id}', 'watch') as b`))[0].b)

    const grant = await fn('admin-users', admin.jwt, { action: 'grant_credits', userId: plain.id, amount: 25, note: 'test grant' })
    h.check('admin grants credits', grant.status === 200, `HTTP ${grant.status}`)
    const deduct = await fn('admin-users', admin.jwt, { action: 'deduct_credits', userId: plain.id, amount: 5, note: 'test deduct' })
    h.check('admin deducts credits', deduct.status === 200, `HTTP ${deduct.status}`)

    const bal = Number((await sql(`select public.available_credits('${plain.id}', 'watch') as b`))[0].b)
    h.check('grant then deduct nets +20', bal === base + 20, `${base} -> ${bal}`)

    const feature = await fn('admin-videos', admin.jwt, { action: 'set_featured', videoId, featured: true, rank: 1 })
    h.check('admin features a video', feature.status === 200, `HTTP ${feature.status}`)

    const meta = await fn('admin-videos', admin.jwt, { action: 'update_meta', videoId, accessTier: 'exclusive', creditCost: 3 })
    h.check('admin retiers a video', meta.status === 200, `HTTP ${meta.status}`)

    const badMeta = await fn('admin-videos', admin.jwt, { action: 'update_meta', videoId, accessTier: 'free', creditCost: 3 })
    h.check('the tier<->cost CHECK refuses a mismatched price over HTTP', badMeta.status === 400, `HTTP ${badMeta.status}`)

    const audits = await sql(`
      select action from public.audit_logs
      where actor_id = '${admin.id}'
      order by created_at
    `)
    const actions = audits.map((a) => a.action)
    h.check(
      'every admin mutation is in audit_logs',
      ['user.role_granted', 'user.grant_credits', 'user.deduct_credits', 'video.set_featured', 'video.update_meta']
        .every((a) => actions.includes(a)),
      JSON.stringify(actions),
    )
  }

  h.section('Self-protection')
  {
    const selfSuspend = await fn('admin-users', admin.jwt, { action: 'suspend', userId: admin.id })
    h.check('admin cannot suspend themself', selfSuspend.status === 400 && selfSuspend.data?.error === 'cannot_moderate_self', `HTTP ${selfSuspend.status}`)

    const selfDemote = await fn('admin-users', admin.jwt, { action: 'set_role', userId: admin.id, role: 'administrator', grant: false })
    h.check('admin cannot remove their own admin role', selfDemote.status === 400 && selfDemote.data?.error === 'cannot_demote_self', `HTTP ${selfDemote.status}`)
  }

  h.section('Remove refunds buyers')
  {
    // plain buys the (now exclusive, 3-credit) video, watches enough to settle
    const preBuy = Number((await sql(`select public.available_credits('${plain.id}', 'watch') as b`))[0].b)
    const unlock = (await sql(`select public.unlock_video('${plain.id}', '${videoId}') as r`))[0].r
    await sql(`select public.settle_credit_hold('${unlock.ledger_id}', true)`)
    const before = Number((await sql(`select public.available_credits('${plain.id}', 'watch') as b`))[0].b)
    h.check('buyer paid 3 credits', before === preBuy - 3, `${preBuy} -> ${before}`)

    const removeAsMod = await fn('admin-videos', mod.jwt, { action: 'remove', videoId })
    h.check('moderator CANNOT remove (money moves)', removeAsMod.status === 403, `HTTP ${removeAsMod.status}`)

    const remove = await fn('admin-videos', admin.jwt, { action: 'remove', videoId, reason: 'test takedown' })
    h.check('admin removes the video', remove.status === 200, `HTTP ${remove.status}: ${JSON.stringify(remove.data)}`)
    h.check('the response reports revoked entitlements', remove.data?.entitlements_revoked >= 1, JSON.stringify(remove.data))

    const after = Number((await sql(`select public.available_credits('${plain.id}', 'watch') as b`))[0].b)
    h.check('the buyer was refunded the 3 credits', after === before + 3, `${before} -> ${after}`)
  }
} finally {
  console.log('\nCleaning up...')
  await cleanup()
}

h.finish('ADMIN HTTP')
