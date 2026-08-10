#!/usr/bin/env node
/**
 * Membership machinery (0028), on the live database via the SQL rail:
 *
 *   - a member unlocks a PAID episode for 0 coins, source 'membership',
 *     and NO ledger row is written
 *   - a non-member still pays (control group — pricing didn't break)
 *   - members-only series: refused for non-members (members_only), open
 *     to members, and the free window does NOT leak past the gate
 *   - an expired membership is no membership
 *   - grants already held survive membership expiry (entitlement wins)
 *
 * Usage:  node scripts/test-membership.mjs
 */

import { loadEnv, makeHarness, sql, sqlExpectError } from './_db.mjs'

loadEnv()
const h = makeHarness()

const RUN = Date.now()
const MEMBER = 'member_tester'
const PAYER = 'member_tester_payer'
const SLUG = `membership-test-${RUN}`

const bal = async (uid) =>
  Number((await sql(`select public.available_credits('${uid}', 'watch') as b`))[0].b)

const unlock = (uid, videoId) =>
  sql(`select public.unlock_video('${uid}', '${videoId}') as r`).then((r) => r[0].r)

const unlockErr = (uid, videoId) =>
  sqlExpectError(`select public.unlock_video('${uid}', '${videoId}')`)

console.log('\nMembership (0028) — live SQL rail\n')

async function cleanup() {
  await sql(`
    delete from public.video_entitlements where user_id in ('${MEMBER}', '${PAYER}');
    delete from public.credit_ledger where user_id in ('${MEMBER}', '${PAYER}');
    delete from public.memberships where user_id in ('${MEMBER}', '${PAYER}');
    delete from public.videos where series_id in (select id from public.series where slug like '${SLUG}%');
    delete from public.series where slug like '${SLUG}%';
    delete from public.profiles where user_id in ('${MEMBER}', '${PAYER}');
  `).catch(() => {})
}

try {
  // ── fixtures: two users with coins, one paid series, one members-only ──
  await cleanup()
  await sql(`
    insert into public.profiles (user_id, email) values
      ('${MEMBER}', 'member-tester@test.local'),
      ('${PAYER}', 'member-payer@test.local');
    select public.grant_credits('${MEMBER}', 10, 'admin_grant', null, null, 'watch', 'memtest:${RUN}:m', '{}'::jsonb);
    select public.grant_credits('${PAYER}', 10, 'admin_grant', null, null, 'watch', 'memtest:${RUN}:p', '{}'::jsonb);

    insert into public.series (slug, title, creator_id, status, free_episode_count, episode_credit_cost, published_at)
    values ('${SLUG}', 'Membership Test', 'user_synthetic_creator', 'published', 0, 2, now()),
           ('${SLUG}-vip', 'Membership Test VIP', 'user_synthetic_creator', 'published', 1, 2, now());
    update public.series set is_members_only = true where slug = '${SLUG}-vip';
  `)
  const seriesRows = await sql(`select id, slug from public.series where slug like '${SLUG}%'`)
  const paidSeries = seriesRows.find((s) => s.slug === SLUG).id
  const vipSeries = seriesRows.find((s) => s.slug === `${SLUG}-vip`).id

  const mkEp = async (seriesId, n) =>
    (
      await sql(`
        insert into public.videos (title, slug, creator_id, status, access_tier, credit_cost, series_id, episode_number, published_at)
        values ('Test EP${n}', '${SLUG}-${seriesId.slice(0, 4)}-ep${n}', 'user_synthetic_creator', 'published', 'premium', 2, '${seriesId}', ${n}, now())
        returning id
      `)
    )[0].id
  const [ep1, ep2, ep3, vip1, vip2] = await Promise.all([
    mkEp(paidSeries, 1), mkEp(paidSeries, 2), mkEp(paidSeries, 3),
    mkEp(vipSeries, 1), mkEp(vipSeries, 2),
  ])

  h.section('Member pricing on a normal paid series')
  {
    await sql(`
      insert into public.memberships (user_id, tier, expires_at, granted_by)
      values ('${MEMBER}', 'monthly', now() + interval '30 days', 'test')
    `)

    const control = await unlock(PAYER, ep1)
    h.check('control: a NON-member pays the episode price', Number(control.charged) === 2, JSON.stringify(control))
    h.check('control: balance 10 → 8', (await bal(PAYER)) === 8)

    const memberBefore = await bal(MEMBER)
    const res = await unlock(MEMBER, ep1)
    h.check('a member unlocks the same paid episode for 0', Number(res.charged) === 0, JSON.stringify(res))
    h.check('member balance untouched', (await bal(MEMBER)) === memberBefore)

    const src = await sql(`
      select source::text as s from public.video_entitlements
      where user_id = '${MEMBER}' and video_id = '${ep1}'
    `)
    h.check("entitlement source is 'membership'", src[0]?.s === 'membership', src[0]?.s)

    const ledger = await sql(`
      select count(*)::int as n from public.credit_ledger
      where user_id = '${MEMBER}' and reason = 'watch_debit'
    `)
    h.check('no ledger row for a member unlock', ledger[0].n === 0, `${ledger[0].n} rows`)
  }

  h.section('Members-only series')
  {
    const refused = await unlockErr(PAYER, vip2)
    h.check('a non-member is refused with members_only', refused?.includes('members_only'), refused ?? 'NO ERROR')

    // The free window must not leak: EP1 of the VIP series is inside
    // free_episode_count=1, but the gate fires before pricing.
    const freeLeak = await unlockErr(PAYER, vip1)
    h.check('…even for an episode inside the free window', freeLeak?.includes('members_only'), freeLeak ?? 'NO ERROR')
    h.check('and no coins moved on refusals', (await bal(PAYER)) === 8)

    const res = await unlock(MEMBER, vip2)
    h.check('a member unlocks members-only for 0', Number(res.charged) === 0, JSON.stringify(res))
  }

  h.section('Expiry is the truth')
  {
    await sql(`update public.memberships set expires_at = now() - interval '1 hour' where user_id = '${MEMBER}'`)

    const refused = await unlockErr(MEMBER, vip1)
    h.check('an EXPIRED member is refused members-only content', refused?.includes('members_only'), refused ?? 'NO ERROR')

    const before = await bal(MEMBER)
    const res = await unlock(MEMBER, ep2)
    h.check('an expired member pays like everyone else', Number(res.charged) === 2, JSON.stringify(res))
    h.check('…and the coins actually moved', (await bal(MEMBER)) === before - 2)

    // What was unlocked DURING membership stays unlocked (entitlement wins).
    const replay = await unlock(MEMBER, vip2)
    h.check('members-only content unlocked while a member SURVIVES expiry',
      replay.already_unlocked === true && Number(replay.charged) === 0, JSON.stringify(replay))
  }

  h.section('Weekly tier (0029)')
  {
    await sql(`
      update public.memberships
      set tier = 'weekly', expires_at = now() + interval '7 days'
      where user_id = '${MEMBER}'
    `)
    const res = await unlock(MEMBER, ep3)
    h.check('a weekly member unlocks a paid episode for 0', Number(res.charged) === 0, JSON.stringify(res))
    // Back to expired — the helper check below asserts the expired truth.
    await sql(`update public.memberships set expires_at = now() - interval '1 hour' where user_id = '${MEMBER}'`)
  }

  h.section('Client surface')
  {
    const grant = await sqlExpectError(`
      select set_config('request.jwt.claims', '{"sub":"${PAYER}","role":"authenticated"}', true);
      set local role authenticated;
      insert into public.memberships (user_id, tier, expires_at) values ('${PAYER}', 'annual', now() + interval '1 year');
    `)
    h.check('a client cannot write themselves a membership', grant !== null, grant ?? 'INSERT SUCCEEDED')

    const helper = await sql(`select public.has_active_membership('${MEMBER}') as m`)
    h.check('has_active_membership reads the truth (expired → false)', helper[0].m === false)
  }

} finally {
  console.log('\nCleaning up...')
  await cleanup()
}

h.finish('MEMBERSHIP')
