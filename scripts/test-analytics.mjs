#!/usr/bin/env node
/**
 * Analytics correctness against seeded, KNOWN data.
 *
 * Seeds two synthetic users watching two videos "yesterday" (platform time),
 * with exact session seconds and one committed watch debit, then runs the
 * rollup and asserts every number — including that re-running REPAIRS rather
 * than doubles (the idempotency the nightly cron depends on), that the
 * per-video rows split correctly, that trending refreshes concurrently, and
 * that the Edge Function endpoint stays secret-gated and reconciles.
 *
 * Usage:  node scripts/test-analytics.mjs
 */

import { loadEnv, makeHarness, sql } from './_db.mjs'

const env = loadEnv()
const h = makeHarness()

const U1 = 'an_test_user1'
const U2 = 'an_test_user2'

async function cleanup() {
  await sql(`
    delete from public.watch_sessions where user_id in ('${U1}','${U2}');
    delete from public.watch_history where user_id in ('${U1}','${U2}');
    delete from public.video_entitlements where user_id in ('${U1}','${U2}');
    delete from public.credit_ledger where user_id in ('${U1}','${U2}');
    delete from public.video_daily_stats where video_id in (select id from public.videos where slug like 'an-test-%');
    delete from public.videos where slug like 'an-test-%';
    delete from public.profiles where user_id in ('${U1}','${U2}');
    -- the probe day's platform row is synthetic; leaving it would show a
    -- phantom 2020 blip on the admin dashboard
    delete from public.platform_daily_stats where day = '2020-06-15';
  `)
}

console.log('\nAnalytics rollup - seeded known data\n')

try {
  await cleanup()

  // A FIXED, ancient probe day — deliberately not "yesterday". The suite
  // asserts platform-WIDE absolutes (DAU, watch_seconds, videos_published),
  // and yesterday stopped being quiet the moment the platform had real
  // traffic: on 2026-08-04 this suite failed against launch-day activity from
  // 08-03. A day years in the past is quiet forever, and rollup_daily_stats
  // takes an explicit day precisely so any day can be (re)computed.
  const day = '2020-06-15'

  await sql(`
    insert into public.profiles (user_id, email) values
      ('${U1}', 'an1@test.local'), ('${U2}', 'an2@test.local');
    insert into public.videos (title, slug, creator_id, status, access_tier, credit_cost, duration_seconds, published_at) values
      ('AN Free', 'an-test-free', 'an_creator', 'published', 'free', 0, 100, '${day} 10:00:00+08'),
      ('AN Paid', 'an-test-paid', 'an_creator', 'published', 'premium', 1, 100, '${day} 10:00:00+08');
  `)
  const vids = Object.fromEntries(
    (await sql(`select slug, id from public.videos where slug like 'an-test-%'`)).map((v) => [v.slug, v.id]),
  )

  // U1 watches both videos; U2 watches the paid one and completes it.
  // Sessions started mid-day platform time; seconds are exact.
  await sql(`
    -- granted_at set INSIDE the rolled-up day: the rollup counts unlocks by
    -- grant time, and the column defaults to now() (today), outside the window.
    insert into public.video_entitlements (user_id, video_id, source, credits_charged, granted_at, expires_at) values
      ('${U1}', '${vids['an-test-free']}', 'free_tier', 0, '${day} 11:59:00+08', now() + interval '1 day'),
      ('${U1}', '${vids['an-test-paid']}', 'purchase', 1, '${day} 12:59:00+08', now() + interval '1 day'),
      ('${U2}', '${vids['an-test-paid']}', 'purchase', 1, '${day} 13:59:00+08', now() + interval '1 day');

    insert into public.watch_sessions (user_id, video_id, entitlement_id, started_at, last_heartbeat_at, seconds_watched, completed, settled)
    select '${U1}', '${vids['an-test-free']}', e.id, '${day} 12:00:00+08', '${day} 12:05:00+08', 120, false, true
    from public.video_entitlements e where e.user_id = '${U1}' and e.video_id = '${vids['an-test-free']}';

    insert into public.watch_sessions (user_id, video_id, entitlement_id, started_at, last_heartbeat_at, seconds_watched, completed, settled)
    select '${U1}', '${vids['an-test-paid']}', e.id, '${day} 13:00:00+08', '${day} 13:03:00+08', 60, false, true
    from public.video_entitlements e where e.user_id = '${U1}' and e.video_id = '${vids['an-test-paid']}';

    insert into public.watch_sessions (user_id, video_id, entitlement_id, started_at, last_heartbeat_at, seconds_watched, completed, settled)
    select '${U2}', '${vids['an-test-paid']}', e.id, '${day} 14:00:00+08', '${day} 14:02:00+08', 95, true, true
    from public.video_entitlements e where e.user_id = '${U2}' and e.video_id = '${vids['an-test-paid']}';

    -- one committed watch debit for the paid video that day
    insert into public.credit_ledger (user_id, credit_type, amount, status, reason, reference_type, reference_id, created_at)
    values ('${U2}', 'watch', -1, 'committed', 'watch_debit', 'video_unlock', '${vids['an-test-paid']}', '${day} 14:01:00+08');
  `)

  h.section('The rollup')
  const first = (await sql(`select public.rollup_daily_stats('${day}') as r`))[0].r
  h.check('runs and returns the day', first.day === day, JSON.stringify(first))
  h.check('DAU = 2', first.dau === 2, `${first.dau}`)
  h.check('watch_seconds = 275 (120+60+95)', Number(first.watch_seconds) === 275, `${first.watch_seconds}`)
  h.check('credits_consumed = 1', Number(first.credits_consumed) === 1, `${first.credits_consumed}`)
  h.check('unlocks counted', first.unlocks >= 3, `${first.unlocks}`)
  h.check('videos_published = 2 (the seeded pair)', first.videos_published === 2, `${first.videos_published}`)

  h.section('Idempotency (the nightly cron depends on it)')
  const second = (await sql(`select public.rollup_daily_stats('${day}') as r`))[0].r
  h.check('re-running repairs, not doubles', Number(second.watch_seconds) === 275 && second.dau === 2,
    `watch_seconds ${second.watch_seconds}, dau ${second.dau}`)

  h.section('Per-video split')
  {
    const rows = await sql(`
      select v.slug, s.views, s.unique_viewers, s.watch_seconds, s.credits_earned, s.completions
      from public.video_daily_stats s join public.videos v on v.id = s.video_id
      where s.day = '${day}' and v.slug like 'an-test-%'
    `)
    const bySlug = Object.fromEntries(rows.map((r) => [r.slug, r]))
    const free = bySlug['an-test-free']
    const paid = bySlug['an-test-paid']
    h.check('free video: 1 view, 1 viewer, 120s, 0 credits',
      free && free.views === 1 && free.unique_viewers === 1 && Number(free.watch_seconds) === 120 && Number(free.credits_earned) === 0,
      JSON.stringify(free))
    h.check('paid video: 2 views, 2 viewers, 155s, 1 credit, 1 completion',
      paid && paid.views === 2 && paid.unique_viewers === 2 && Number(paid.watch_seconds) === 155 &&
      Number(paid.credits_earned) === 1 && paid.completions === 1,
      JSON.stringify(paid))
  }

  h.section('Trending')
  {
    // The MV only reads the last 7 days, and the rollup above targeted the
    // ancient probe day — so give trending its own RECENT rows. These are
    // per-VIDEO assertions scoped to our seeded ids, so recent days are safe
    // in a way the platform-wide absolutes above are not.
    await sql(`
      insert into public.video_daily_stats (day, video_id, views, unique_viewers, watch_seconds, credits_earned, completions) values
        (current_date - 1, '${vids['an-test-free']}', 1, 1, 120, 0, 0),
        (current_date - 1, '${vids['an-test-paid']}', 2, 2, 155, 1, 1)
      on conflict (day, video_id) do update set views = excluded.views
    `)
    await sql(`select public.refresh_trending()`)
    const trending = await sql(`
      select title, trend_score from public.mv_trending_videos
      where id in ('${vids['an-test-free']}', '${vids['an-test-paid']}')
      order by trend_score desc
    `)
    h.check('both seeded videos appear in trending', trending.length === 2, `${trending.length}`)
    h.check('the twice-viewed video ranks higher', trending[0]?.title === 'AN Paid', JSON.stringify(trending))
  }

  h.section('The ops endpoint')
  {
    const unauth = await fetch(`${env.SUPABASE_URL}/functions/v1/analytics-rollup?day=${day}`, { method: 'POST' })
    h.check('without the secret -> 401', unauth.status === 401, `HTTP ${unauth.status}`)

    const res = await fetch(`${env.SUPABASE_URL}/functions/v1/analytics-rollup?day=${day}`, {
      method: 'POST',
      headers: { 'x-sweep-secret': env.SWEEP_TRIGGER_SECRET },
    })
    const body = await res.json().catch(() => null)
    h.check('with the secret -> 200 and the day', res.status === 200 && body?.day === day,
      `HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`)
    // Bunny accounts StorageUsage lazily — 0 is plausible for a tiny fresh
    // library. The assertion is that reconciliation RAN (non-null), not what
    // Bunny chose to report.
    h.check('storage reconciliation ran (field non-null)', body?.storage_bytes !== null && body?.storage_bytes !== undefined,
      `${body?.storage_bytes}`)
    // bunny_watch_seconds may be 0/null for a synthetic day with no real CDN
    // traffic — assert the FIELD exists rather than a value.
    h.check('bunny reconciliation field present', 'bunny_watch_seconds' in (body ?? {}), JSON.stringify(Object.keys(body ?? {})))
  }

  h.section('Access control')
  {
    const anon = await fetch(`${env.SUPABASE_URL}/rest/v1/platform_daily_stats?select=day`, {
      headers: { apikey: env.SUPABASE_ANON_KEY },
    })
    const rows = await anon.json().catch(() => [])
    h.check('anon reads nothing from platform_daily_stats', Array.isArray(rows) && rows.length === 0, `saw ${rows?.length}`)

    const trendingAnon = await fetch(`${env.SUPABASE_URL}/rest/v1/mv_trending_videos?select=id&limit=1`, {
      headers: { apikey: env.SUPABASE_ANON_KEY },
    })
    const tRows = await trendingAnon.json().catch(() => [])
    h.check('trending IS public (published-catalog data only)', Array.isArray(tRows) && tRows.length >= 1, `saw ${tRows?.length}`)
  }
} finally {
  console.log('\nCleaning up...')
  await cleanup()
  await sql(`select public.rollup_daily_stats(((now() at time zone 'Asia/Manila')::date - 1))`)
  await sql(`select public.refresh_trending()`)
}

h.finish('ANALYTICS')
