-- 0001_identity.sql — profiles, roles, role audit, creator applications
--
-- CONVENTION THAT GOVERNS THE WHOLE SCHEMA:
-- every user id is `text`, holding a Clerk id like `user_2abc…`.
-- NEVER `uuid references auth.users(id)` — Clerk is the identity provider and
-- `auth.uid()` returns NULL here. RLS uses `auth.jwt()->>'sub'`.

-- ── helper: the calling user's Clerk id ────────────────────────────────────
create or replace function public.clerk_user_id()
returns text
language sql
stable
as $$
  select nullif(auth.jwt() ->> 'sub', '')
$$;

comment on function public.clerk_user_id() is
  'Clerk subject of the calling JWT, or NULL for anon. Use in RLS policies '
  'instead of auth.uid(), which is always NULL under a third-party issuer.';

-- ── profiles ──────────────────────────────────────────────────────────────
-- email and display_name are DENORMALIZED from Clerk via clerk-webhook.
-- Admin search over thousands of users must not call the Clerk API per row —
-- START AI Studio's role admin does exactly that and degrades to raw ids.
create table public.profiles (
  user_id           text primary key,
  email             text not null,
  display_name      text,
  avatar_path       text,                       -- Supabase Storage path, not a URL
  bio               text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  -- moderation state. Client can never write these.
  suspended_at      timestamptz,
  suspended_by      text,
  suspended_reason  text,
  suspended_until   timestamptz,                -- null + suspended_at = indefinite
  banned_at         timestamptz,
  banned_by         text,
  banned_reason     text,
  deleted_at        timestamptz,

  constraint profiles_email_not_blank check (length(trim(email)) > 0)
);

create unique index profiles_email_lower_idx on public.profiles (lower(email));
create index profiles_display_name_idx      on public.profiles (lower(display_name));
create index profiles_created_at_idx        on public.profiles (created_at desc);
-- partial: the admin "problem users" view stays cheap as the table grows
create index profiles_suspended_idx on public.profiles (suspended_at)
  where suspended_at is not null;
create index profiles_banned_idx    on public.profiles (banned_at)
  where banned_at is not null;

comment on column public.profiles.avatar_path is
  'Storage object path. The server generates it; the client never supplies one.';

-- ── roles ─────────────────────────────────────────────────────────────────
-- NOTE: there is deliberately NO 'user' value. The absence of a row IS "User".
-- A 'user' row would be a second source of truth for the default state.
create type public.app_role as enum ('creator', 'moderator', 'administrator');

create table public.user_roles (
  user_id     text not null,
  role        public.app_role not null,
  granted_by  text,
  granted_at  timestamptz not null default now(),
  primary key (user_id, role)
);

create index user_roles_role_idx on public.user_roles (role);

-- ── role audit ────────────────────────────────────────────────────────────
-- Written BY TRIGGER, not by the admin Edge Function.
-- START AI Studio lost three role rows with no record because only the polite
-- path logged; a direct SQL fix bypassed it entirely.
create table public.user_role_audit (
  id          bigserial primary key,
  user_id     text not null,
  role        public.app_role not null,
  action      text not null check (action in ('granted', 'revoked')),
  actor       text,
  occurred_at timestamptz not null default now()
);

create index user_role_audit_user_idx on public.user_role_audit (user_id, occurred_at desc);

create or replace function public.log_user_role_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.user_role_audit (user_id, role, action, actor)
    values (new.user_id, new.role, 'granted', new.granted_by);
    return new;
  else
    insert into public.user_role_audit (user_id, role, action, actor)
    values (old.user_id, old.role, 'revoked', public.clerk_user_id());
    return old;
  end if;
end;
$$;

create trigger user_roles_audit_ins
  after insert on public.user_roles
  for each row execute function public.log_user_role_change();

create trigger user_roles_audit_del
  after delete on public.user_roles
  for each row execute function public.log_user_role_change();

-- ── role predicates ───────────────────────────────────────────────────────
-- Used inside RLS policies. ALWAYS call these wrapped:
--     using ( (select public.has_role('administrator')) )
-- Unwrapped, Postgres re-evaluates per row and admin tables time out.
create or replace function public.has_role(p_role public.app_role)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.user_roles
    where user_id = public.clerk_user_id() and role = p_role
  )
$$;

create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.user_roles
    where user_id = public.clerk_user_id()
      and role in ('moderator', 'administrator')
  )
$$;

-- ── creator applications ──────────────────────────────────────────────────
create type public.application_status as enum ('pending', 'approved', 'rejected');

create table public.creator_applications (
  id             uuid primary key default gen_random_uuid(),
  user_id        text not null references public.profiles (user_id) on delete cascade,
  status         public.application_status not null default 'pending',
  bio            text,
  portfolio_url  text,
  submitted_at   timestamptz not null default now(),
  reviewed_by    text,
  reviewed_at    timestamptz,
  decision_note  text
);

-- one open application per user; re-apply allowed after a decision
create unique index creator_applications_one_open_idx
  on public.creator_applications (user_id)
  where status = 'pending';
create index creator_applications_status_idx
  on public.creator_applications (status, submitted_at desc);

-- ── notification preferences ──────────────────────────────────────────────
create table public.notification_preferences (
  user_id     text primary key references public.profiles (user_id) on delete cascade,
  channels    jsonb not null default '{
    "email": {"upload_reviewed": true, "credit_granted": true,
              "warning_issued": true, "weekly_digest": false},
    "in_app": {"upload_reviewed": true, "credit_granted": true,
               "warning_issued": true}
  }'::jsonb,
  updated_at  timestamptz not null default now()
);

-- ── updated_at maintenance ────────────────────────────────────────────────
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_touch
  before update on public.profiles
  for each row execute function public.touch_updated_at();

create trigger notification_preferences_touch
  before update on public.notification_preferences
  for each row execute function public.touch_updated_at();

-- ── lock down SECURITY DEFINER functions ──────────────────────────────────
-- Postgres grants EXECUTE to PUBLIC on create, and PostgREST exposes every
-- public-schema function at /rest/v1/rpc/. See CLAUDE.md trap #7.
-- The role predicates are safe to expose (they read the CALLER's own id and
-- take no user-id argument), but log_user_role_change must never be callable.
revoke execute on function public.log_user_role_change() from public, anon, authenticated;

-- RLS itself is enabled in 0003_rls_core.sql, together with the policies, so
-- no table is ever left RLS-enabled-but-unpoliced between two migrations.
