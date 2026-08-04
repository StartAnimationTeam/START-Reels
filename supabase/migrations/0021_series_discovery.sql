-- 0021_series_discovery.sql — the series pivot, part 3: discovery
--
-- Trending and recommendations move to the SERIES grain. mv_trending_videos
-- would rank fifty episodes of one hot show as fifty rows; the series MV
-- aggregates the same exp-decay signal through videos.series_id. The
-- per-video MV stays — admin analytics still reads it, and it's cheap.

create materialized view public.mv_trending_series as
select
  se.id,
  se.slug,
  se.title,
  se.cover_url,
  se.free_episode_count,
  se.episode_credit_cost,
  se.is_members_only,
  se.total_episodes,
  coalesce(sum(
    s.views * exp(-((current_date - s.day)::numeric) / 3.0)   -- half-life ~2 days
  ), 0) as trend_score
from public.series se
join public.videos v on v.series_id = se.id and v.deleted_at is null
join public.video_daily_stats s on s.video_id = v.id
where se.status = 'published'
  and se.deleted_at is null
  and s.day >= current_date - 7
group by se.id
order by trend_score desc;

-- REQUIRED for refresh … concurrently — without it the hourly cron starts
-- failing silently.
create unique index mv_trending_series_id_idx on public.mv_trending_series (id);

-- Published-catalog data only; readable by everyone like the per-video MV.
grant select on public.mv_trending_series to anon, authenticated;

-- Same signature ⇒ grants survive, but restated below anyway (trap #7).
create or replace function public.refresh_trending()
returns void
language sql
security definer
set search_path = public
as $$
  refresh materialized view concurrently public.mv_trending_videos;
  refresh materialized view concurrently public.mv_trending_series;
$$;

revoke execute on function public.refresh_trending() from public, anon, authenticated;
grant execute on function public.refresh_trending() to service_role;

-- ── recommended_series ────────────────────────────────────────────────────
-- The recommendation atom is now the SHOW, and the exclusion flips: the old
-- recommender excluded everything already watched, which in an episode world
-- suppresses exactly the series you're mid-binge on. Here a series leaves
-- the pool only once its FINAL episode is completed.
--
-- SECURITY DEFINER with NO user-id parameter — the 0008/0010 safe shape:
-- identity from clerk_user_id(), so granting to `authenticated` lets a
-- caller get recommendations only for themself. Anonymous feeds fall back
-- to mv_trending_series in the frontend.
create or replace function public.recommended_series(p_limit int default 12)
returns table (
  id uuid,
  slug text,
  title text,
  cover_url text,
  free_episode_count int,
  episode_credit_cost int,
  is_members_only boolean,
  total_episodes int
)
language sql
stable
security definer
set search_path = public
as $$
  with my_categories as (
    -- affinity per category from validated watch seconds, via the episode's series
    select sc.category_id,
           sum(wh.total_seconds_watched) as weight
    from public.watch_history wh
    join public.videos v on v.id = wh.video_id and v.series_id is not null
    join public.series_categories sc on sc.series_id = v.series_id
    where wh.user_id = public.clerk_user_id()
    group by sc.category_id
  ),
  finished as (
    -- a series is exhausted once its last published episode is completed
    select v.series_id
    from public.watch_history wh
    join public.videos v on v.id = wh.video_id
    join public.series se on se.id = v.series_id
    where wh.user_id = public.clerk_user_id()
      and wh.completed
      and v.episode_number = (
        select max(v2.episode_number) from public.videos v2
        where v2.series_id = v.series_id
          and v2.status = 'published' and v2.deleted_at is null
      )
  ),
  candidates as (
    select se.id, se.slug, se.title, se.cover_url,
           se.free_episode_count, se.episode_credit_cost,
           se.is_members_only, se.total_episodes,
           coalesce(sum(mc.weight), 0) as score,
           se.published_at
    from public.series se
    left join public.series_categories sc on sc.series_id = se.id
    left join my_categories mc on mc.category_id = sc.category_id
    where se.status = 'published'
      and se.deleted_at is null
      and se.id not in (select series_id from finished)
    group by se.id
  )
  select id, slug, title, cover_url, free_episode_count,
         episode_credit_cost, is_members_only, total_episodes
  from candidates
  -- affinity first; ties (including the zero-history cold start) resolve to
  -- newest first, so the feed degrades to "new shows" rather than to empty
  order by score desc, published_at desc nulls last
  limit greatest(1, least(coalesce(p_limit, 12), 50));
$$;

grant execute on function public.recommended_series(int) to authenticated;
revoke execute on function public.recommended_series(int) from anon, public;

-- ── series covers bucket ──────────────────────────────────────────────────
-- Public-read (covers render on every card; signing each would be cost
-- without benefit — same reasoning as avatars, 0010). Writes go through the
-- series-manage Edge Function with the service role ONLY: no client write
-- policies exist, so the bucket is read-only from the browser's side.
insert into storage.buckets (id, name, public)
values ('series-covers', 'series-covers', true)
on conflict (id) do update set public = true;

create policy series_covers_read on storage.objects
  for select using (bucket_id = 'series-covers');
