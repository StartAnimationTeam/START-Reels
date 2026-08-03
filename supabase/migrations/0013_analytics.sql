-- 0013_analytics.sql — rollup tables, the rollup function, trending, schedules
--
-- Analytics here are PRODUCT data — queryable, joinable, admin-visible — never
-- read from a telemetry vendor. The rollups are idempotent upserts over a
-- given platform-timezone day, so re-running a day repairs it rather than
-- doubling it, and a backfill is just a loop.

-- ── platform-wide, one row per day ────────────────────────────────────────
create table public.platform_daily_stats (
  day                  date primary key,
  dau                  int not null default 0,   -- distinct users with a watch session
  mau                  int not null default 0,   -- distinct users, 30 days ending here
  new_registrations    int not null default 0,
  videos_published     int not null default 0,
  watch_seconds        bigint not null default 0,
  credits_consumed     numeric not null default 0,  -- committed watch debits
  credits_granted      numeric not null default 0,  -- all positive committed rows
  unlocks              int not null default 0,
  -- reconciliation columns, written by the analytics-rollup Edge Function:
  bunny_watch_seconds  bigint,                   -- Bunny's number for the same day
  storage_bytes        bigint,                   -- library storage at rollup time
  computed_at          timestamptz not null default now()
);

-- ── per video per day ─────────────────────────────────────────────────────
create table public.video_daily_stats (
  day             date not null,
  video_id        uuid not null references public.videos (id) on delete cascade,
  views           int not null default 0,        -- sessions started
  unique_viewers  int not null default 0,
  watch_seconds   bigint not null default 0,
  credits_earned  numeric not null default 0,
  completions     int not null default 0,
  primary key (day, video_id)
);

create index video_daily_stats_video_idx on public.video_daily_stats (video_id, day desc);

alter table public.platform_daily_stats enable row level security;
alter table public.video_daily_stats    enable row level security;

create policy platform_daily_stats_select_staff on public.platform_daily_stats
  for select using ((select public.is_staff()));
create policy video_daily_stats_select_staff on public.video_daily_stats
  for select using ((select public.is_staff()));

-- Creators see their own videos' dailies (their dashboard's history view).
create policy video_daily_stats_select_creator on public.video_daily_stats
  for select using (
    exists (
      select 1 from public.videos v
      where v.id = video_id and v.creator_id = public.clerk_user_id()
    )
  );

-- ── the rollup ────────────────────────────────────────────────────────────
-- Day boundaries are the PLATFORM's day (same rule as daily rewards). A
-- session is attributed to the day it STARTED — a session spanning midnight
-- books to one day, which is the honest simplification at this scale.
create or replace function public.rollup_daily_stats(p_day date default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tz    text;
  v_day   date;
  v_from  timestamptz;
  v_to    timestamptz;
  v_row   public.platform_daily_stats%rowtype;
begin
  v_tz := coalesce(
    (select value #>> '{}' from public.platform_settings where key = 'platform_timezone'), 'UTC');
  v_day := coalesce(p_day, ((now() at time zone v_tz)::date - 1));  -- default: yesterday
  v_from := v_day::timestamp at time zone v_tz;
  v_to   := (v_day + 1)::timestamp at time zone v_tz;

  -- per-video first; the platform row aggregates parts of it
  insert into public.video_daily_stats
    (day, video_id, views, unique_viewers, watch_seconds, credits_earned, completions)
  select
    v_day,
    ws.video_id,
    count(*)::int,
    count(distinct ws.user_id)::int,
    coalesce(sum(ws.seconds_watched), 0),
    coalesce((
      select sum(-l.amount) from public.credit_ledger l
      where l.reason = 'watch_debit' and l.status = 'committed'
        and l.reference_id = ws.video_id::text
        and l.created_at >= v_from and l.created_at < v_to
    ), 0),
    count(*) filter (where ws.completed)::int
  from public.watch_sessions ws
  where ws.started_at >= v_from and ws.started_at < v_to
  group by ws.video_id
  on conflict (day, video_id) do update set
    views = excluded.views,
    unique_viewers = excluded.unique_viewers,
    watch_seconds = excluded.watch_seconds,
    credits_earned = excluded.credits_earned,
    completions = excluded.completions;

  insert into public.platform_daily_stats
    (day, dau, mau, new_registrations, videos_published, watch_seconds,
     credits_consumed, credits_granted, unlocks)
  values (
    v_day,
    (select count(distinct user_id) from public.watch_sessions
      where started_at >= v_from and started_at < v_to),
    (select count(distinct user_id) from public.watch_sessions
      where started_at >= v_from - interval '29 days' and started_at < v_to),
    (select count(*) from public.profiles
      where created_at >= v_from and created_at < v_to),
    (select count(*) from public.videos
      where published_at >= v_from and published_at < v_to),
    (select coalesce(sum(seconds_watched), 0) from public.watch_sessions
      where started_at >= v_from and started_at < v_to),
    (select coalesce(sum(-amount), 0) from public.credit_ledger
      where reason = 'watch_debit' and status = 'committed'
        and created_at >= v_from and created_at < v_to),
    (select coalesce(sum(amount), 0) from public.credit_ledger
      where amount > 0 and status = 'committed'
        and created_at >= v_from and created_at < v_to),
    (select count(*) from public.video_entitlements
      where granted_at >= v_from and granted_at < v_to)
  )
  on conflict (day) do update set
    dau = excluded.dau,
    mau = excluded.mau,
    new_registrations = excluded.new_registrations,
    videos_published = excluded.videos_published,
    watch_seconds = excluded.watch_seconds,
    credits_consumed = excluded.credits_consumed,
    credits_granted = excluded.credits_granted,
    unlocks = excluded.unlocks,
    computed_at = now();

  select * into v_row from public.platform_daily_stats where day = v_day;
  return to_jsonb(v_row);
end;
$$;

-- ── trending ──────────────────────────────────────────────────────────────
-- 7-day recency-weighted views over age since publish. A materialized view
-- because it's read on every home page render and only needs hourly truth.
create materialized view public.mv_trending_videos as
select
  v.id,
  v.title,
  v.access_tier,
  v.credit_cost,
  v.duration_seconds,
  v.thumbnail_url,
  coalesce(sum(
    s.views * exp(-((current_date - s.day)::numeric) / 3.0)   -- half-life ~2 days
  ), 0) as trend_score
from public.videos v
join public.video_daily_stats s on s.video_id = v.id
where v.status = 'published'
  and v.deleted_at is null
  and s.day >= current_date - 7
group by v.id
order by trend_score desc;

create unique index mv_trending_videos_id_idx on public.mv_trending_videos (id);

-- Refreshed CONCURRENTLY (needs the unique index) so home-page reads never
-- block on the refresh.
create or replace function public.refresh_trending()
returns void
language sql
security definer
set search_path = public
as $$
  refresh materialized view concurrently public.mv_trending_videos;
$$;

-- The MV is behind the API like any table; expose reads to everyone — it
-- contains only published-catalog data.
grant select on public.mv_trending_videos to anon, authenticated;

-- ── lock down ─────────────────────────────────────────────────────────────
revoke execute on function
  public.rollup_daily_stats(date),
  public.refresh_trending()
from public, anon, authenticated;
grant execute on function
  public.rollup_daily_stats(date),
  public.refresh_trending()
to service_role;

-- ── schedules ─────────────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from cron.job where jobname = 'rollup-daily-stats') then
    perform cron.unschedule('rollup-daily-stats');
  end if;
  -- 19:10 UTC = 03:10 Asia/Manila: yesterday (platform time) is complete.
  perform cron.schedule('rollup-daily-stats', '10 19 * * *', 'select public.rollup_daily_stats()');

  if exists (select 1 from cron.job where jobname = 'refresh-trending') then
    perform cron.unschedule('refresh-trending');
  end if;
  perform cron.schedule('refresh-trending', '5 * * * *', 'select public.refresh_trending()');
exception when others then
  raise notice 'pg_cron unavailable (%); schedule externally', sqlerrm;
end $$;
