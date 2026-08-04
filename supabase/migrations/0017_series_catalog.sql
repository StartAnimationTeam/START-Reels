-- 0017_series_catalog.sql — the series pivot, part 1: structure
--
-- START Reels becomes a DramaBox-style short-drama platform: content is a
-- SERIES of short vertical episodes. Episodes stay rows in `videos` (every
-- FK, RLS policy and stats table keeps working); a new `series` table owns
-- identity, discovery and PRICING. The old per-video access_tier/credit_cost
-- pair remains as a display snapshot, but from 0019 on the economic truth is
-- (free_episode_count, episode_credit_cost) here.
--
-- Companion migrations: 0018 backfills every existing video into a
-- 1-episode series; 0019 repoints unlock_video at series pricing.

create type public.series_status as enum (
  'draft',       -- being assembled; episodes may still be encoding
  'published',   -- visible in the catalog
  'removed'      -- taken down; episodes revoked + refunded via series-manage
);

create table public.series (
  id                  uuid primary key default gen_random_uuid(),
  slug                text not null unique,
  title               text not null,
  synopsis            text,
  cover_url           text,                 -- 9:16 portrait, series-covers bucket
  creator_id          text not null,        -- Clerk user id (text, never uuid)
  status              public.series_status not null default 'draft',

  -- The DramaBox pricing model: episodes 1..free_episode_count are free,
  -- every later episode costs episode_credit_cost coins. Enforced in
  -- unlock_video (0019), displayed everywhere else.
  free_episode_count  int not null default 3
                        constraint series_free_count_range check (free_episode_count >= 0),
  episode_credit_cost int not null default 1
                        constraint series_episode_cost_range check (episode_credit_cost between 0 and 20),

  -- VIP shelf flag. DELIBERATELY not enforced by unlock_video until a real
  -- membership exists (Stripe phase) — enforcing it now would make tagged
  -- content unwatchable for everyone. The UI labels it "Coming soon".
  is_members_only     boolean not null default false,

  -- Denormalized count of published, non-deleted episodes. Maintained by the
  -- trigger below — never written by application code.
  total_episodes      int not null default 0,

  is_featured         boolean not null default false,
  featured_rank       int,

  published_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz,

  constraint series_title_not_blank check (length(trim(title)) > 0),
  constraint series_slug_shape check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);

create index series_status_idx   on public.series (status, published_at desc);
create index series_creator_idx  on public.series (creator_id, created_at desc);
create index series_featured_idx on public.series (featured_rank)
  where is_featured and status = 'published';
create index series_recent_idx   on public.series (published_at desc)
  where status = 'published' and deleted_at is null;

-- Full-text search at the SERIES grain — searching "dragon king" must return
-- the show once, not fifty episode rows. Same weighted-generated shape as
-- videos.search_tsv.
alter table public.series add column search_tsv tsvector
  generated always as (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(synopsis, '')), 'B')
  ) stored;

create index series_search_idx on public.series using gin (search_tsv);

create trigger series_touch
  before update on public.series
  for each row execute function public.touch_updated_at();

-- ── episodes: videos join the series ──────────────────────────────────────
-- ON DELETE RESTRICT, not cascade: a series with paid episodes dies through
-- the revoke-and-refund path (series-manage → revoke_video_entitlements per
-- episode), never through an FK cascade that would strand entitlements.
alter table public.videos
  add column series_id      uuid references public.series (id) on delete restrict,
  add column episode_number int
    constraint videos_episode_number_positive check (episode_number >= 1);

-- One EP.3 per series. Partial: soft-deleted rows free their slot so a
-- botched upload can be replaced without renumbering.
create unique index videos_series_episode_idx
  on public.videos (series_id, episode_number)
  where series_id is not null and deleted_at is null;

create index videos_by_series_idx
  on public.videos (series_id, episode_number)
  where series_id is not null;

-- THE 0005 TRAP: videos is under a column-grant allowlist. A new column is
-- INVISIBLE to clients — embedded selects silently omit it, explicit selects
-- error — until granted. db-verify asserts this grant so it can never be
-- lost in a later revoke/regrant cycle.
grant select (series_id, episode_number) on public.videos to anon, authenticated;

-- The 0005 tier<->cost weld (free=0/premium=1/exclusive=2..5) can't price
-- episodes: series pricing needs cost snapshots anywhere in 1..20. Keep the
-- one invariant that still matters — free means zero — and widen the paid
-- range. videos.access_tier/credit_cost survive as a DISPLAY SNAPSHOT of the
-- series-resolved price; 0019 makes the series the economic truth.
alter table public.videos drop constraint videos_tier_cost;
alter table public.videos add constraint videos_tier_cost check (
  (access_tier = 'free' and credit_cost = 0) or
  (access_tier in ('premium', 'exclusive') and credit_cost between 1 and 20)
);

-- ── categorisation ────────────────────────────────────────────────────────
-- Categories move to the series grain (reusing the categories table).
-- video_categories stays for legacy analytics; the browse surface stops
-- reading it.
create table public.series_categories (
  series_id   uuid not null references public.series (id) on delete cascade,
  category_id uuid not null references public.categories (id) on delete cascade,
  is_primary  boolean not null default false,
  primary key (series_id, category_id)
);

create unique index series_categories_one_primary_idx
  on public.series_categories (series_id) where is_primary;
create index series_categories_by_category_idx
  on public.series_categories (category_id);

-- Facet tags ("Secret Baby", "Revenge", …) are a property of the DRAMA, not
-- of a 90-second episode — so the join is at series grain, reusing the
-- until-now-unused tags table. video_tags stays dead.
create table public.series_tags (
  series_id uuid not null references public.series (id) on delete cascade,
  tag_id    uuid not null references public.tags (id) on delete cascade,
  primary key (series_id, tag_id)
);

create index series_tags_by_tag_idx on public.series_tags (tag_id);

insert into public.tags (slug, name) values
  ('secret-baby',        'Secret Baby'),
  ('revenge',            'Revenge'),
  ('betrayal',           'Betrayal'),
  ('forbidden-love',     'Forbidden Love'),
  ('hidden-identity',    'Hidden Identity'),
  ('mafia',              'Mafia'),
  ('billionaire',        'Billionaire'),
  ('werewolf',           'Werewolf'),
  ('dragon',             'Dragon'),
  ('supernatural',       'Supernatural'),
  ('strong-heroine',     'Strong Heroine'),
  ('powerful-male-lead', 'Powerful Male Lead'),
  ('counterattack',      'Counterattack'),
  ('the-chosen-one',     'The Chosen One'),
  ('all-too-late',       'All-Too-Late'),
  ('level-up',           'Level-Up'),
  ('family-intrigue',    'Family Intrigue'),
  ('mistaken-identity',  'Mistaken Identity'),
  ('love-at-first-sight','Love at First Sight'),
  ('winning-her-back',   'Winning Her Back'),
  ('fantasy',            'Fantasy'),
  ('steamy',             'Steamy'),
  ('modern',             'Modern'),
  ('young-adult',        'Young Adult')
on conflict (slug) do nothing;

-- ── series_follows — "My List" at the series grain ────────────────────────
-- Favorites-shaped: the one client-writable pattern in the schema (0008).
-- No value moves when a user follows a show; WITH CHECK is the whole story.
create table public.series_follows (
  user_id    text not null,
  series_id  uuid not null references public.series (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, series_id)
);

create index series_follows_recent_idx on public.series_follows (user_id, created_at desc);

-- ── total_episodes trigger ────────────────────────────────────────────────
-- Recounts published, non-deleted episodes for every series touched by a
-- videos write. Enforcement lives in the DB: the bunny webhook, admin
-- actions and any future writer all keep the count honest for free.
create or replace function public.refresh_series_episode_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_series uuid;
begin
  for v_series in
    select distinct s from (values (old.series_id), (new.series_id)) as t(s)
    where s is not null
  loop
    update public.series se
    set total_episodes = (
      select count(*) from public.videos v
      where v.series_id = v_series
        and v.status = 'published'
        and v.deleted_at is null
    )
    where se.id = v_series;
  end loop;
  return null;
end;
$$;

-- INSERT has no OLD and DELETE has no NEW; two triggers with the right row
-- variables beat one trigger full of TG_OP branches.
create trigger videos_series_count_ins
  after insert on public.videos
  for each row when (new.series_id is not null)
  execute function public.refresh_series_episode_count();

create trigger videos_series_count_upd
  after update of status, deleted_at, series_id, episode_number on public.videos
  for each row when (old.series_id is not null or new.series_id is not null)
  execute function public.refresh_series_episode_count();

create trigger videos_series_count_del
  after delete on public.videos
  for each row when (old.series_id is not null)
  execute function public.refresh_series_episode_count();

-- Trigger functions are invoked by the system, but a definer function in the
-- public schema is still PostgREST-callable until revoked (trap #7).
revoke execute on function public.refresh_series_episode_count()
  from public, anon, authenticated;

-- ── series_progress — resume, derived, no new table ───────────────────────
-- "Which episode am I on in series X" falls straight out of watch_history ⋈
-- videos. A VIEW RUNS AS ITS OWNER AND BYPASSES RLS unless told otherwise —
-- security_invoker is what keeps user A from reading user B's progress
-- (trap 8b, the credit_balances incident). db-verify's all-views loop
-- asserts it forever.
create view public.series_progress
with (security_invoker = on) as
select
  v.series_id,
  wh.user_id,
  max(v.episode_number)                                                  as last_episode_number,
  (array_agg(wh.last_position_seconds order by v.episode_number desc))[1] as last_position_seconds,
  (array_agg(wh.completed             order by v.episode_number desc))[1] as last_episode_completed,
  max(wh.last_watched_at)                                                as last_watched_at
from public.watch_history wh
join public.videos v on v.id = wh.video_id
where v.series_id is not null
group by v.series_id, wh.user_id;

grant select on public.series_progress to authenticated;

-- ══════════════════════════════════════════════════════════════════════════
-- RLS
-- ══════════════════════════════════════════════════════════════════════════
alter table public.series            enable row level security;
alter table public.series_categories enable row level security;
alter table public.series_tags       enable row level security;
alter table public.series_follows    enable row level security;

-- Signed-out browsing of the published catalog is the top of the funnel,
-- same as videos.
create policy series_select_published on public.series
  for select using (status = 'published' and deleted_at is null);

create policy series_select_own on public.series
  for select using (creator_id = public.clerk_user_id());

create policy series_select_staff on public.series
  for select using ((select public.is_staff()));

-- No client INSERT/UPDATE/DELETE on series: every write goes through the
-- series-manage Edge Function with the service role.

create policy series_categories_select_all on public.series_categories
  for select using (true);   -- join table: bounded by series/categories policies on the join

create policy series_tags_select_all on public.series_tags
  for select using (true);

create policy series_follows_select_own on public.series_follows
  for select using (user_id = public.clerk_user_id());

create policy series_follows_insert_own on public.series_follows
  for insert with check (user_id = public.clerk_user_id());

create policy series_follows_delete_own on public.series_follows
  for delete using (user_id = public.clerk_user_id());

-- Column grant matches favorites (0008): user_id + series_id writable,
-- created_at readable only — the default is the only writer.
revoke insert on public.series_follows from anon, authenticated;
grant insert (user_id, series_id) on public.series_follows to authenticated;
grant select, delete on public.series_follows to authenticated;
