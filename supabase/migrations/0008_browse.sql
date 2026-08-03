-- 0008_browse.sql — favorites, search access, the SQL recommender
--
-- The Phase 3 slice: everything the browse surface needs and nothing more.
-- Notifications and notification-prefs UI belong to Phase 4.

-- ── favorites ─────────────────────────────────────────────────────────────
-- THE one table with client-writable RLS in the whole schema. No value moves
-- when a user favorites a video, so routing it through an Edge Function would
-- be ceremony — the WITH CHECK is the entire security story.
create table public.favorites (
  user_id    text not null,
  video_id   uuid not null references public.videos (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, video_id)
);

create index favorites_recent_idx on public.favorites (user_id, created_at desc);

alter table public.favorites enable row level security;

create policy favorites_select_own on public.favorites
  for select using (user_id = public.clerk_user_id());

create policy favorites_insert_own on public.favorites
  for insert with check (user_id = public.clerk_user_id());

create policy favorites_delete_own on public.favorites
  for delete using (user_id = public.clerk_user_id());

-- Column grant matches: user_id + video_id only. created_at is readable but
-- not writable — the default is the only writer.
revoke insert on public.favorites from anon, authenticated;
grant insert (user_id, video_id) on public.favorites to authenticated;
grant select, delete on public.favorites to authenticated;

-- ── search ────────────────────────────────────────────────────────────────
-- 0005 withheld search_tsv from clients along with provider_asset_id. That
-- lumped two different columns together: the GUID is a secret, but search_tsv
-- is derived purely from title+description — text the same clients can
-- already read. PostgREST requires SELECT on any column used in a WHERE
-- clause, so withholding it breaks `.textSearch()` while protecting nothing.
-- Grant it; row visibility is still RLS's job.
grant select (search_tsv) on public.videos to anon, authenticated;

-- ── recommended_videos ────────────────────────────────────────────────────
-- The v1 recommender, deliberately pure SQL (plan §7: "explicitly not AI"),
-- and documented as replaceable: category affinity from the caller's watch
-- history, weighted by watch time, excluding already-watched videos.
--
-- SECURITY DEFINER **without a p_user_id parameter** — identity comes from
-- clerk_user_id() inside, so it is SAFE to grant to `authenticated`: a caller
-- can only ever get recommendations for themself. This is the same shape as
-- has_role()/is_staff(), and the opposite of unlock_video(), which takes an
-- explicit user id and must stay revoked.
create or replace function public.recommended_videos(p_limit int default 12)
returns table (
  id uuid,
  title text,
  slug text,
  access_tier public.access_tier,
  credit_cost int,
  duration_seconds int,
  thumbnail_url text
)
language sql
stable
security definer
set search_path = public
as $$
  with my_categories as (
    -- the caller's affinity per category, from validated watch seconds
    select vc.category_id,
           sum(wh.total_seconds_watched) as weight
    from public.watch_history wh
    join public.video_categories vc on vc.video_id = wh.video_id
    where wh.user_id = public.clerk_user_id()
    group by vc.category_id
  ),
  candidates as (
    select v.id, v.title, v.slug, v.access_tier, v.credit_cost,
           v.duration_seconds, v.thumbnail_url,
           coalesce(sum(mc.weight), 0) as score,
           v.published_at
    from public.videos v
    join public.video_categories vc on vc.video_id = v.id
    left join my_categories mc on mc.category_id = vc.category_id
    where v.status = 'published'
      and v.deleted_at is null
      and not exists (
        select 1 from public.watch_history wh
        where wh.user_id = public.clerk_user_id() and wh.video_id = v.id
      )
    group by v.id
  )
  select id, title, slug, access_tier, credit_cost, duration_seconds, thumbnail_url
  from candidates
  -- affinity first; inside a tie (including the no-history cold start, where
  -- every score is 0) newest first, so the function degrades to "recently
  -- added you haven't seen" rather than to an empty rail
  order by score desc, published_at desc nulls last
  limit greatest(1, least(coalesce(p_limit, 12), 50));
$$;

grant execute on function public.recommended_videos(int) to authenticated;
revoke execute on function public.recommended_videos(int) from anon, public;
