#!/usr/bin/env node
/**
 * Series model semantics — structure first (Phase 1 of the pivot), pricing
 * added when 0019 lands.
 *
 * §structure
 *   - 0018 backfill: every live video belongs to a 1-episode series whose
 *     pricing resolves to exactly what the video cost before the pivot
 *   - favorites became series_follows
 *   - total_episodes is trigger-maintained through publish/unpublish/delete
 *   - (series_id, episode_number) is unique among live rows, and a
 *     soft-deleted episode frees its slot
 *   - series_progress derives resume state from watch_history
 *
 * Usage:  node scripts/test-series.mjs
 */

import { loadEnv, makeHarness, sql, sqlExpectError } from './_db.mjs'

loadEnv()
const h = makeHarness()

const U = { viewer: 'series_test_viewer', creator: 'series_test_creator' }

async function cleanup() {
  const ids = Object.values(U).map((u) => `'${u}'`).join(',')
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

    // The economic identity: the series-resolved price of every backfilled
    // episode equals what the video charged before the pivot.
    const mispriced = await sql(`
      select count(*)::int as n
      from public.videos v join public.series s on s.id = v.series_id
      where v.deleted_at is null
        and case when v.episode_number <= s.free_episode_count then 0
                 else s.episode_credit_cost end
            is distinct from v.credit_cost
    `)
    h.check('series pricing resolves to the pre-pivot video price', mispriced[0].n === 0, `${mispriced[0].n} mismatch(es)`)

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
