-- 0026_episode_likes.sql — the heart button
--
-- Likes are the third client-writable table (after favorites and
-- series_follows, the 0008 pattern): no value moves when a viewer taps a
-- heart, so WITH CHECK is the whole security story. Counts are
-- DENORMALIZED onto videos.like_count and series.like_count by trigger —
-- the watch rail and admin tables read a column, never an aggregate
-- (trap #13) — and the trigger is the single writer, so the counters can't
-- drift from the rows.

create table public.episode_likes (
  user_id    text not null,
  video_id   uuid not null references public.videos (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, video_id)
);

create index episode_likes_by_video_idx on public.episode_likes (video_id);

alter table public.videos add column like_count bigint not null default 0;
alter table public.series add column like_count bigint not null default 0;

-- The 0005 allowlist trap: videos columns are invisible until granted.
grant select (like_count) on public.videos to anon, authenticated;

-- ── the counter trigger ───────────────────────────────────────────────────
create or replace function public.bump_like_counts()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_video   uuid;
  v_delta   int;
  v_series  uuid;
begin
  if tg_op = 'INSERT' then
    v_video := new.video_id;
    v_delta := 1;
  else
    v_video := old.video_id;
    v_delta := -1;
  end if;

  update public.videos
  set like_count = greatest(0, like_count + v_delta)
  where id = v_video
  returning series_id into v_series;

  if v_series is not null then
    update public.series
    set like_count = greatest(0, like_count + v_delta)
    where id = v_series;
  end if;

  return null;
end;
$$;

revoke execute on function public.bump_like_counts() from public, anon, authenticated;

create trigger episode_likes_count_ins
  after insert on public.episode_likes
  for each row execute function public.bump_like_counts();

create trigger episode_likes_count_del
  after delete on public.episode_likes
  for each row execute function public.bump_like_counts();

-- ══════════════════════════════════════════════════════════════════════════
-- RLS — the favorites contract, verbatim
-- ══════════════════════════════════════════════════════════════════════════
alter table public.episode_likes enable row level security;

create policy episode_likes_select_own on public.episode_likes
  for select using (user_id = public.clerk_user_id());

create policy episode_likes_insert_own on public.episode_likes
  for insert with check (user_id = public.clerk_user_id());

create policy episode_likes_delete_own on public.episode_likes
  for delete using (user_id = public.clerk_user_id());

-- Staff read for moderation/analytics parity with follows (0024).
create policy episode_likes_select_staff on public.episode_likes
  for select using ((select public.is_staff()));

revoke insert on public.episode_likes from anon, authenticated;
grant insert (user_id, video_id) on public.episode_likes to authenticated;
grant select, delete on public.episode_likes to authenticated;
