-- 0025_view_counts.sql — play counts on the shelf
--
-- The DramaBox "▶ 19.5K" badge. A view is counted when a PLAYBACK SESSION
-- starts — the same moment the concurrency cap counts it, after the
-- entitlement check, so a view is always a real, entitled play attempt and
-- never a page load. Counters are denormalized on both grains (episode and
-- series) because shelves read hundreds of cards; an aggregate join per
-- card is how dashboards die (trap #13).
--
-- videos.view_count has existed since 0005 but was never written; it starts
-- meaning something today. Both counters backfill from watch_sessions — the
-- true historical record of session starts.

alter table public.series add column view_count bigint not null default 0;

-- ── backfill from history ─────────────────────────────────────────────────
update public.videos v
set view_count = s.n
from (
  select video_id, count(*) as n
  from public.watch_sessions
  group by video_id
) s
where s.video_id = v.id;

update public.series se
set view_count = agg.n
from (
  select v.series_id, sum(v.view_count) as n
  from public.videos v
  where v.series_id is not null
  group by v.series_id
) agg
where agg.series_id = se.id;

-- ── count on session start ────────────────────────────────────────────────
-- Same signature ⇒ grants survive; revokes restated anyway (trap #7).
create or replace function public.start_watch_session(
  p_user_id text,
  p_video_id uuid,
  p_entitlement_id uuid,
  p_device text default null,
  p_ip_hash text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entitlement public.video_entitlements%rowtype;
  v_live        int;
  v_cap         int;
  v_session_id  uuid;
  v_series_id   uuid;
begin
  select * into v_entitlement
  from public.video_entitlements
  where id = p_entitlement_id
    and user_id = p_user_id
    and video_id = p_video_id
    and expires_at > now()
    and revoked_at is null;

  if not found then
    raise exception 'needs_unlock' using errcode = 'P0001';
  end if;

  -- A session with no heartbeat for 2 minutes is dead, whatever the client
  -- failed to tell us — browsers get killed, laptops get closed. Counting
  -- them against the cap would lock users out of their own entitlement.
  v_cap := public.setting_int('max_concurrent_streams', 2);
  select count(*) into v_live
  from public.watch_sessions
  where entitlement_id = p_entitlement_id
    and ended_at is null
    and last_heartbeat_at > now() - interval '2 minutes';

  if v_live >= v_cap then
    raise exception 'too_many_streams' using errcode = 'P0001';
  end if;

  insert into public.watch_sessions (user_id, video_id, entitlement_id, device, ip_hash)
  values (p_user_id, p_video_id, p_entitlement_id, p_device, p_ip_hash)
  returning id into v_session_id;

  -- watch_count increments per SESSION, not per heartbeat.
  insert into public.watch_history (user_id, video_id)
  values (p_user_id, p_video_id)
  on conflict (user_id, video_id) do update
    set watch_count = public.watch_history.watch_count + 1,
        last_watched_at = now();

  -- The public play counters, same per-session grain. The session insert
  -- above already proved the entitlement; these can't inflate from repeats
  -- any more than the concurrency cap can.
  update public.videos
  set view_count = view_count + 1
  where id = p_video_id
  returning series_id into v_series_id;

  if v_series_id is not null then
    update public.series set view_count = view_count + 1 where id = v_series_id;
  end if;

  return jsonb_build_object('session_id', v_session_id);
end;
$$;

revoke execute on function public.start_watch_session(text, uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.start_watch_session(text, uuid, uuid, text, text)
  to service_role;

-- ── the MV carries the badge too ──────────────────────────────────────────
-- Trending cards read the MV, not the table; without the column the badge
-- would vanish on exactly the busiest shelf. Recreate with view_count (and
-- the unique index CONCURRENTLY refresh requires).
drop materialized view public.mv_trending_series;

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
  se.view_count,
  coalesce(sum(
    s.views * exp(-((current_date - s.day)::numeric) / 3.0)
  ), 0) as trend_score
from public.series se
join public.videos v on v.series_id = se.id and v.deleted_at is null
join public.video_daily_stats s on s.video_id = v.id
where se.status = 'published'
  and se.deleted_at is null
  and s.day >= current_date - 7
group by se.id
order by trend_score desc;

create unique index mv_trending_series_id_idx on public.mv_trending_series (id);
grant select on public.mv_trending_series to anon, authenticated;

-- ── the recommender returns it as well ────────────────────────────────────
-- Return-type changes can't ride CREATE OR REPLACE: drop + recreate, and
-- because DROP discards grants, the grant/revoke pair is restated below —
-- this is exactly the trap-#7 shape.
drop function public.recommended_series(int);

create function public.recommended_series(p_limit int default 12)
returns table (
  id uuid,
  slug text,
  title text,
  cover_url text,
  free_episode_count int,
  episode_credit_cost int,
  is_members_only boolean,
  total_episodes int,
  view_count bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with my_categories as (
    select sc.category_id,
           sum(wh.total_seconds_watched) as weight
    from public.watch_history wh
    join public.videos v on v.id = wh.video_id and v.series_id is not null
    join public.series_categories sc on sc.series_id = v.series_id
    where wh.user_id = public.clerk_user_id()
    group by sc.category_id
  ),
  finished as (
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
           se.is_members_only, se.total_episodes, se.view_count,
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
         episode_credit_cost, is_members_only, total_episodes, view_count
  from candidates
  order by score desc, published_at desc nulls last
  limit greatest(1, least(coalesce(p_limit, 12), 50));
$$;

grant execute on function public.recommended_series(int) to authenticated;
revoke execute on function public.recommended_series(int) from anon, public;
