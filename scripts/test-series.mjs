#!/usr/bin/env node
/**
 * Series model semantics.
 *
 * §structure (Phase 1)
 *   - 0018 backfill: every live video belongs to a 1-episode series whose
 *     pricing resolves to exactly what the video cost before the pivot
 *   - favorites became series_follows
 *   - total_episodes is trigger-maintained through publish/unpublish/delete
 *   - (series_id, episode_number) is unique among live rows, and a
 *     soft-deleted episode frees its slot
 *   - series_progress derives resume state from watch_history
 *
 * §pricing (Phase 2, 0019)
 *   - an episode inside the free window unlocks free and writes NO ledger row
 *   - an episode past the window charges series.episode_credit_cost
 *   - double-unlock is idempotent (charged once)
 *   - insufficient coins refuses cleanly, no partial state
 *   - the entitlement horizon is ~permanent (+87600h)
 *   - a removed series takes its episodes off sale
 *
 * Usage:  node scripts/test-series.mjs
 */

import { loadEnv, makeHarness, sql, sqlExpectError } from './_db.mjs'

loadEnv()
const h = makeHarness()

const U = { viewer: 'series_test_viewer', creator: 'series_test_creator' }

async function cleanup() {
  const ids = [...Object.values(U), `${U.viewer}_poor`].map((u) => `'${u}'`).join(',')
  await sql(`
    delete from public.watch_sessions where user_id in (${ids});
    delete from public.watch_history where user_id in (${ids});
    delete from public.video_entitlements where user_id in (${ids});
    delete from public.credit_ledger where user_id in (${ids});
    delete from public.series_follows where user_id in (${ids});
    delete from public.videos where slug like 'series-test-%';
    delete from public.series where slug like 'series-test-%';
    delete from public.profiles where user_id in (${ids});
  `)
}

console.log('\nSeries model - live database\n')

try {
  await cleanup()

  await sql(`
    insert into public.profiles (user_id, email) values
      ('${U.viewer}', 'series-viewer@test.local'),
      ('${U.creator}', 'series-creator@test.local');
  `)

  // ── §structure: the 0018 backfill ─────────────────────────────────────
  h.section('Backfill invariants (0018)')
  {
    const orphans = await sql(`
      select count(*)::int as n from public.videos
      where series_id is null and deleted_at is null
    `)
    h.check('every live video has a series', orphans[0].n === 0, `${orphans[0].n} orphan(s)`)

    const notFirst = await sql(`
      select count(*)::int as n from public.videos v
      where v.deleted_at is null and v.episode_number is distinct from 1
        and not exists (
          -- allow multi-episode series created after the pivot
          select 1 from public.videos sib
          where sib.series_id = v.series_id and sib.id <> v.id
        )
    `)
    h.check('backfilled single-video series are episode 1', notFirst[0].n === 0, `${notFirst[0].n} misnumbered`)

    // NOTE deliberately absent: an assertion that video tier/cost snapshots
    // match series pricing. They agree at upload time, then legitimately
    // drift when an admin edits series pricing later — the snapshot is
    // display-only and the SERIES is the economic truth, which §pricing
    // proves against unlock_video directly.

    const followGap = await sql(`
      select count(*)::int as n
      from public.favorites f
      join public.videos v on v.id = f.video_id and v.series_id is not null
      left join public.series_follows sf
        on sf.user_id = f.user_id and sf.series_id = v.series_id
      where sf.user_id is null
    `)
    h.check('every favorite became a series follow', followGap[0].n === 0, `${followGap[0].n} missing`)
  }

  // ── §structure: episode counting ──────────────────────────────────────
  h.section('total_episodes trigger')
  const [{ id: sid }] = await sql(`
    insert into public.series (slug, title, creator_id, status, free_episode_count, episode_credit_cost)
    values ('series-test-show', 'Trigger Test Show', '${U.creator}', 'published', 1, 2)
    returning id
  `)

  const ep = async (n, status) => (await sql(`
    insert into public.videos (title, slug, creator_id, status, access_tier, credit_cost, series_id, episode_number, published_at)
    values ('Ep ${n}', 'series-test-ep-${n}', '${U.creator}', '${status}',
            (case when ${n} <= 1 then 'free' else 'premium' end)::public.access_tier,
            case when ${n} <= 1 then 0 else 2 end,
            '${sid}', ${n}, case when '${status}' = 'published' then now() end)
    returning id
  `))[0].id

  const count = async () =>
    Number((await sql(`select total_episodes from public.series where id = '${sid}'`))[0].total_episodes)

  const e1 = await ep(1, 'published')
  const e2 = await ep(2, 'published')
  await ep(3, 'processing')
  h.check('counts published episodes only', (await count()) === 2, `got ${await count()}`)

  await sql(`update public.videos set status = 'published', published_at = now() where slug = 'series-test-ep-3'`)
  h.check('publishing an episode increments', (await count()) === 3, `got ${await count()}`)

  await sql(`update public.videos set deleted_at = now() where id = '${e2}'`)
  h.check('soft-deleting an episode decrements', (await count()) === 2, `got ${await count()}`)

  h.section('Episode numbering')
  {
    const dup = await sqlExpectError(`
      insert into public.videos (title, slug, creator_id, status, access_tier, credit_cost, series_id, episode_number)
      values ('Dup', 'series-test-dup', '${U.creator}', 'draft', 'premium', 2, '${sid}', 1)
    `)
    h.check('a duplicate episode number is refused', Boolean(dup), 'INSERT SUCCEEDED')

    // e2 is soft-deleted, so its slot is free — replacing a botched upload
    // must not force renumbering.
    const reuse = await sqlExpectError(`
      insert into public.videos (title, slug, creator_id, status, access_tier, credit_cost, series_id, episode_number)
      values ('Ep 2 again', 'series-test-ep-2b', '${U.creator}', 'draft', 'premium', 2, '${sid}', 2)
    `)
    h.check('a soft-deleted episode frees its number', !reuse, reuse ?? '')
  }

  // ── §pricing: the 0019 economy ────────────────────────────────────────
  h.section('Series pricing (unlock_video, 0019)')
  {
    await sql(`
      select public.grant_credits('${U.viewer}', 10, 'admin_grant', null, null, 'watch', 'series-test-seed', '{}'::jsonb)
    `)

    // The test show: free_episode_count=1, episode_credit_cost=2.
    // e1 (ep 1) is inside the window; ep 3 is past it.
    const free = await sql(`select public.unlock_video('${U.viewer}', '${e1}') as r`)
    h.check('episode inside the free window unlocks free', Number(free[0].r.charged) === 0, JSON.stringify(free[0].r))

    const freeLedger = await sql(`
      select count(*)::int as n from public.credit_ledger
      where user_id = '${U.viewer}' and reason = 'watch_debit'
    `)
    h.check('…and writes NO ledger row', freeLedger[0].n === 0, `${freeLedger[0].n} row(s)`)

    const e3 = (await sql(`select id from public.videos where slug = 'series-test-ep-3'`))[0].id
    const paid = await sql(`select public.unlock_video('${U.viewer}', '${e3}') as r`)
    h.check(
      'episode past the window charges episode_credit_cost (2)',
      Number(paid[0].r.charged) === 2 && paid[0].r.already_unlocked === false,
      JSON.stringify(paid[0].r),
    )

    const bal = await sql(`select public.available_credits('${U.viewer}', 'watch') as b`)
    h.check('balance reflects the hold (10 - 2 = 8)', Number(bal[0].b) === 8, `got ${bal[0].b}`)

    const again = await sql(`select public.unlock_video('${U.viewer}', '${e3}') as r`)
    h.check(
      'double-unlock is idempotent (charged 0, already_unlocked)',
      Number(again[0].r.charged) === 0 && again[0].r.already_unlocked === true,
      JSON.stringify(again[0].r),
    )

    const horizon = await sql(`
      select (expires_at > now() + interval '9 years')::bool as far
      from public.video_entitlements
      where user_id = '${U.viewer}' and video_id = '${e3}'
    `)
    h.check('the unlock is ~permanent (expires >9 years out)', horizon[0]?.far === true)

    // Insufficient: a fresh user with 1 coin cannot afford a 2-coin episode.
    await sql(`
      insert into public.profiles (user_id, email)
      values ('${U.viewer}_poor', 'series-poor@test.local')
      on conflict (user_id) do nothing;
    `)
    await sql(`
      select public.grant_credits('${U.viewer}_poor', 1, 'admin_grant', null, null, 'watch', 'series-test-poor-seed', '{}'::jsonb)
    `)
    const broke = await sqlExpectError(`select public.unlock_video('${U.viewer}_poor', '${e3}')`)
    h.check('insufficient coins refuses cleanly', Boolean(broke?.includes('insufficient_credits')), broke ?? 'UNLOCK SUCCEEDED')
    const noEnt = await sql(`
      select count(*)::int as n from public.video_entitlements
      where user_id = '${U.viewer}_poor'
    `)
    h.check('…and leaves no partial entitlement', noEnt[0].n === 0, `${noEnt[0].n} row(s)`)

    // A removed series takes its episodes off sale, row status notwithstanding.
    await sql(`update public.series set status = 'removed' where id = '${sid}'`)
    const offSale = await sqlExpectError(`select public.unlock_video('${U.viewer}_poor', '${e1}')`)
    h.check('a removed series is off sale', Boolean(offSale?.includes('not_found')), offSale ?? 'UNLOCK SUCCEEDED')
    await sql(`update public.series set status = 'published' where id = '${sid}'`)

    await sql(`
      delete from public.video_entitlements where user_id in ('${U.viewer}', '${U.viewer}_poor');
      delete from public.credit_ledger where user_id in ('${U.viewer}', '${U.viewer}_poor');
      delete from public.profiles where user_id = '${U.viewer}_poor';
    `)
  }

  // ── §scheduling: the release timer (0023) ─────────────────────────────
  h.section('Scheduled publishing (0023)')
  {
    // An announced draft whose time has come, with one ready episode…
    const [{ id: dueId }] = await sql(`
      insert into public.series (slug, title, creator_id, status, free_episode_count, episode_credit_cost, scheduled_publish_at)
      values ('series-test-timer', 'Timer Show', '${U.creator}', 'draft', 1, 2, now() - interval '1 minute')
      returning id
    `)
    const [{ id: dueEp }] = await sql(`
      insert into public.videos (title, slug, creator_id, status, access_tier, credit_cost, series_id, episode_number, published_at)
      values ('Timer Ep1', 'series-test-timer-ep-1', '${U.creator}', 'published', 'free', 0, '${dueId}', 1, now())
      returning id
    `)
    // …and one whose time has come but has NOTHING ready.
    await sql(`
      insert into public.series (slug, title, creator_id, status, scheduled_publish_at)
      values ('series-test-timer-empty', 'Empty Timer Show', '${U.creator}', 'draft', now() - interval '1 minute')
    `)

    // Pre-release, the ready episode is PUBLISHED at the video grain — the
    // series gate must still refuse outsiders while creator/staff pass.
    const early = await sqlExpectError(`select public.unlock_video('${U.viewer}', '${dueEp}')`)
    h.check('an episode of an announced-unreleased series is refused',
      Boolean(early?.includes('video_not_published')), early ?? 'UNLOCK SUCCEEDED')
    const own = await sql(`select public.unlock_video('${U.creator}', '${dueEp}') as r`)
    h.check('…but its creator can preview it', own[0].r.already_unlocked === false, JSON.stringify(own[0].r))

    const run1 = await sql(`select public.publish_scheduled_series() as r`)
    h.check('the publisher flips exactly the ready one', Number(run1[0].r.published) === 1, JSON.stringify(run1[0].r))

    const after = await sql(`
      select status, published_at is not null as has_pub, scheduled_publish_at from public.series where id = '${dueId}'
    `)
    h.check('…published with the timer cleared',
      after[0].status === 'published' && after[0].has_pub === true && after[0].scheduled_publish_at === null,
      JSON.stringify(after[0]))

    const empty = await sql(`select status from public.series where slug = 'series-test-timer-empty'`)
    h.check('an overdue series with nothing ready keeps waiting', empty[0].status === 'draft', empty[0].status)

    const run2 = await sql(`select public.publish_scheduled_series() as r`)
    h.check('a second run publishes nothing new (idempotent)', Number(run2[0].r.published) === 0, JSON.stringify(run2[0].r))

    const released = await sql(`select public.unlock_video('${U.viewer}', '${dueEp}') as r`)
    h.check('after release the same episode unlocks free', Number(released[0].r.charged) === 0, JSON.stringify(released[0].r))
  }

  // ── §structure: series_progress ───────────────────────────────────────
  h.section('series_progress view')
  {
    await sql(`
      insert into public.watch_history
        (user_id, video_id, last_position_seconds, total_seconds_watched, watch_count, completed)
      values
        ('${U.viewer}', '${e1}', 61, 61, 1, true),
        ('${U.viewer}', (select id from public.videos where slug = 'series-test-ep-3'), 17, 17, 1, false)
    `)

    const rows = await sql(`
      select * from public.series_progress
      where user_id = '${U.viewer}' and series_id = '${sid}'
    `)
    h.check('one row per (user, series)', rows.length === 1, `got ${rows.length}`)
    const p = rows[0] ?? {}
    h.check('resume points at the furthest episode', Number(p.last_episode_number) === 3, `got ${p.last_episode_number}`)
    h.check("…at that episode's position", Number(p.last_position_seconds) === 17, `got ${p.last_position_seconds}`)
    h.check('completion reflects the furthest episode', p.last_episode_completed === false, `got ${p.last_episode_completed}`)
  }

  await cleanup()
} catch (err) {
  console.error(`\nSuite error: ${err.message}\n`)
  await cleanup().catch(() => {})
  process.exit(1)
}

h.finish('SERIES MODEL')
