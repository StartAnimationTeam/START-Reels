-- 0005_catalog.sql — videos, categories, tags, upload sessions, search
--
-- The one column that matters: `provider_asset_id`. It is the Bunny video GUID,
-- and it MUST NEVER REACH THE BROWSER — it is the thing signed playback URLs
-- exist to protect. The RLS policies below therefore go through a COLUMN
-- GRANT: the `authenticated` role cannot select it at all, so no later query,
-- view or client bug can leak it. Edge Functions read it with the service role.

create type public.video_status as enum (
  'draft',            -- row exists, no upload started
  'uploading',        -- direct-upload URL minted, bytes may be in flight
  'processing',       -- Bunny has the file, transcoding
  'pending_review',   -- creator upload awaiting moderation
  'published',
  'rejected',
  'removed'           -- taken down after publishing (moderation or deletion)
);

create type public.access_tier as enum ('free', 'premium', 'exclusive');

create table public.videos (
  id                   uuid primary key default gen_random_uuid(),
  title                text not null,
  slug                 text not null unique,
  description          text,
  creator_id           text not null,
  status               public.video_status not null default 'draft',
  access_tier          public.access_tier not null default 'free',
  credit_cost          int not null default 0,

  provider             text not null default 'bunny_stream',
  provider_asset_id    text unique,          -- Bunny GUID. NEVER selectable by clients.

  duration_seconds     int,
  thumbnail_url        text,
  preview_gif_url      text,

  is_featured          boolean not null default false,
  featured_rank        int,

  view_count           bigint not null default 0,
  total_watch_seconds  bigint not null default 0,

  rejection_reason     text,
  published_at         timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  deleted_at           timestamptz,

  -- The tier<->cost invariant lives HERE, not in zod, not in an Edge Function:
  -- free = 0, premium = 1, exclusive = 2..5. Every writer obeys it or the
  -- write fails, including a future admin UI nobody has thought about yet.
  constraint videos_tier_cost check (
    (access_tier = 'free'      and credit_cost = 0) or
    (access_tier = 'premium'   and credit_cost = 1) or
    (access_tier = 'exclusive' and credit_cost between 2 and 5)
  ),
  constraint videos_title_not_blank check (length(trim(title)) > 0),
  constraint videos_slug_shape check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);

create index videos_status_idx    on public.videos (status, published_at desc);
create index videos_creator_idx   on public.videos (creator_id, created_at desc);
create index videos_featured_idx  on public.videos (featured_rank)
  where is_featured and status = 'published';
create index videos_recent_idx    on public.videos (published_at desc)
  where status = 'published' and deleted_at is null;

-- Full-text search. A generated column so it can never drift from the data,
-- weighted so a title hit beats a description hit.
alter table public.videos add column search_tsv tsvector
  generated always as (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B')
  ) stored;

create index videos_search_idx on public.videos using gin (search_tsv);

create trigger videos_touch
  before update on public.videos
  for each row execute function public.touch_updated_at();

-- ── categories & tags ─────────────────────────────────────────────────────
create table public.categories (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,
  name        text not null,
  description text,
  sort_order  int not null default 100,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

create table public.video_categories (
  video_id    uuid not null references public.videos (id) on delete cascade,
  category_id uuid not null references public.categories (id) on delete cascade,
  is_primary  boolean not null default false,
  primary key (video_id, category_id)
);

-- one primary category per video
create unique index video_categories_one_primary_idx
  on public.video_categories (video_id) where is_primary;
create index video_categories_by_category_idx
  on public.video_categories (category_id);

create table public.tags (
  id         uuid primary key default gen_random_uuid(),
  slug       text not null unique,
  name       text not null,
  created_at timestamptz not null default now()
);

create table public.video_tags (
  video_id uuid not null references public.videos (id) on delete cascade,
  tag_id   uuid not null references public.tags (id) on delete cascade,
  primary key (video_id, tag_id)
);

create index video_tags_by_tag_idx on public.video_tags (tag_id);

-- ── upload sessions ───────────────────────────────────────────────────────
-- Row written AFTER the direct-upload URL is minted and BEFORE any bytes land,
-- so there is never a Bunny object no row points at, and a stale row tells us
-- an upload was started and abandoned.
create table public.upload_sessions (
  id                   uuid primary key default gen_random_uuid(),
  creator_id           text not null,
  video_id             uuid not null references public.videos (id) on delete cascade,
  provider_upload_id   text,
  status               text not null default 'pending'
                         check (status in ('pending', 'completed', 'failed', 'expired')),
  max_bytes            bigint,
  max_duration_seconds int,
  created_at           timestamptz not null default now(),
  expires_at           timestamptz not null
);

create index upload_sessions_creator_idx on public.upload_sessions (creator_id, created_at desc);
create index upload_sessions_stale_idx   on public.upload_sessions (expires_at)
  where status = 'pending';

-- ══════════════════════════════════════════════════════════════════════════
-- RLS
-- ══════════════════════════════════════════════════════════════════════════
alter table public.videos           enable row level security;
alter table public.categories       enable row level security;
alter table public.video_categories enable row level security;
alter table public.tags             enable row level security;
alter table public.video_tags       enable row level security;
alter table public.upload_sessions  enable row level security;

-- Anyone — including signed-out visitors — can browse the published catalog.
-- The logged-out home page is the top of the signup funnel.
create policy videos_select_published on public.videos
  for select using (status = 'published' and deleted_at is null);

-- Creators see their own videos in every status; staff see everything.
create policy videos_select_own on public.videos
  for select using (creator_id = public.clerk_user_id());

create policy videos_select_staff on public.videos
  for select using ((select public.is_staff()));

-- No client INSERT/UPDATE/DELETE policies: every write moves state and goes
-- through an Edge Function with the service role.

-- ── the column grant that keeps the GUID server-side ──────────────────────
-- RLS decides which ROWS are visible; it cannot hide a column. Revoke SELECT
-- entirely, then grant back every column EXCEPT provider_asset_id. A
-- `select *` from any client now simply omits the column, and an explicit
-- `select provider_asset_id` is a permission error.
revoke select on public.videos from anon, authenticated;
grant select (
  id, title, slug, description, creator_id, status, access_tier, credit_cost,
  provider, duration_seconds, thumbnail_url, preview_gif_url,
  is_featured, featured_rank, view_count, total_watch_seconds,
  rejection_reason, published_at, created_at, updated_at, deleted_at
) on public.videos to anon, authenticated;
-- search_tsv deliberately not granted either — clients search via a function
-- or filtered query, and the raw vector is noise.

create policy categories_select_active on public.categories
  for select using (is_active);
create policy categories_select_staff on public.categories
  for select using ((select public.is_staff()));

create policy video_categories_select_all on public.video_categories
  for select using (true);   -- join table: row visibility is bounded by videos/categories policies on the join

create policy tags_select_all on public.tags
  for select using (true);

create policy video_tags_select_all on public.video_tags
  for select using (true);

create policy upload_sessions_select_own on public.upload_sessions
  for select using (creator_id = public.clerk_user_id());
-- writes: service role only
