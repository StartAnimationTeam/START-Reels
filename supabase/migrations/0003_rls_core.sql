-- 0003_rls_core.sql — RLS for everything in 0001/0002, plus settings, audit
-- log and webhook idempotency.
--
-- THE RULE: RLS is enabled on every table. A table with NO policies is
-- service-role-only BY DESIGN — that is a decision, not an oversight, and it is
-- stated in a comment on each such table.
--
-- Under a third-party JWT issuer `auth.uid()` is NULL. Every policy uses
-- public.clerk_user_id() instead. Helper predicates are wrapped in a scalar
-- subquery — `(select public.has_role(...))` — so Postgres evaluates them ONCE
-- per statement rather than once per row. (CLAUDE.md trap #8)

-- ── platform settings ─────────────────────────────────────────────────────
create table public.platform_settings (
  key         text primary key,
  value       jsonb not null,
  description text,
  updated_by  text,
  updated_at  timestamptz not null default now()
);

insert into public.platform_settings (key, value, description) values
  ('maintenance_mode',          'false'::jsonb,        'When true, non-admins see /maintenance'),
  ('signup_grant_credits',      '10'::jsonb,           'Credits granted on user.created'),
  ('daily_reward_amount',       '1'::jsonb,            'Credits per daily claim'),
  ('daily_reward_enabled',      'true'::jsonb,         'Master switch for daily rewards'),
  ('entitlement_window_hours',  '48'::jsonb,           'How long an unlock grants access'),
  ('settle_after_seconds',      '30'::jsonb,           'Validated watch seconds before a hold commits'),
  ('hold_sweep_after_hours',    '24'::jsonb,           'Age at which an unsettled hold is reversed'),
  ('max_concurrent_streams',    '2'::jsonb,            'Live sessions allowed per entitlement'),
  ('platform_timezone',         '"Asia/Manila"'::jsonb,'Timezone for daily-reward date boundaries'),
  ('max_upload_bytes',          '5368709120'::jsonb,   '5 GiB. Bunny bills per GB — see CLAUDE.md trap #1'),
  ('max_upload_duration_seconds','7200'::jsonb,        '2 hours'),
  ('playback_token_grace_seconds','900'::jsonb,        'Added to video duration for token TTL');

comment on table public.platform_settings is
  'Service-role writes only. Readable by any signed-in user (the client needs '
  'entitlement_window_hours and maintenance_mode); no secrets belong here.';

create or replace function public.setting_int(p_key text, p_default int)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select (value #>> '{}')::int from public.platform_settings where key = p_key), p_default)
$$;

create or replace function public.setting_bool(p_key text, p_default boolean)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select (value #>> '{}')::boolean from public.platform_settings where key = p_key), p_default)
$$;

-- ── audit log ─────────────────────────────────────────────────────────────
-- Append-only, enforced by revoking UPDATE/DELETE from every role including
-- the service role. A gap in an audit trail is honest; a rewritten one is not.
create table public.audit_logs (
  id           bigserial primary key,
  actor_id     text,
  action       text not null,
  target_type  text,
  target_id    text,
  before       jsonb,
  after        jsonb,
  ip           inet,
  created_at   timestamptz not null default now()
);

create index audit_logs_actor_idx  on public.audit_logs (actor_id, created_at desc);
create index audit_logs_target_idx on public.audit_logs (target_type, target_id, created_at desc);
create index audit_logs_action_idx on public.audit_logs (action, created_at desc);

revoke update, delete on public.audit_logs from public, anon, authenticated, service_role;

comment on table public.audit_logs is
  'APPEND-ONLY. UPDATE and DELETE are revoked from every role, service_role '
  'included. Readable by administrators only.';

-- ── webhook idempotency ───────────────────────────────────────────────────
-- Claim-first: insert the row BEFORE doing the work, answer 200 on a duplicate
-- (a non-2xx makes the sender retry, which on a replay loops forever), and
-- release the claim if the work then fails. (CLAUDE.md trap #10)
create table public.processed_webhook_events (
  event_id     text primary key,          -- svix-id for Clerk, GUID+status for Bunny
  source       text not null,             -- 'clerk' | 'bunny'
  event_type   text,
  claimed_at   timestamptz not null default now(),
  completed_at timestamptz,
  error        text
);

create index processed_webhook_events_source_idx
  on public.processed_webhook_events (source, claimed_at desc);
-- surfaces webhooks that were claimed but never completed
create index processed_webhook_events_stuck_idx
  on public.processed_webhook_events (claimed_at)
  where completed_at is null;

comment on table public.processed_webhook_events is
  'Service-role only. Claim before work, complete after. See CLAUDE.md trap #10.';

-- ══════════════════════════════════════════════════════════════════════════
-- ENABLE RLS EVERYWHERE
-- ══════════════════════════════════════════════════════════════════════════
alter table public.profiles                  enable row level security;
alter table public.user_roles                enable row level security;
alter table public.user_role_audit           enable row level security;
alter table public.creator_applications      enable row level security;
alter table public.notification_preferences  enable row level security;
alter table public.credit_ledger             enable row level security;
alter table public.platform_settings         enable row level security;
alter table public.audit_logs                enable row level security;
alter table public.processed_webhook_events  enable row level security;

-- ── profiles ──────────────────────────────────────────────────────────────
create policy profiles_select_own on public.profiles
  for select using (user_id = public.clerk_user_id());

-- staff need the full list for the admin user table
create policy profiles_select_staff on public.profiles
  for select using ((select public.is_staff()));

-- A user edits only presentation fields. Moderation columns are NOT protected
-- by this policy alone — column-level grants below do that, because a USING
-- clause cannot stop a user setting suspended_at on their own row.
create policy profiles_update_own on public.profiles
  for update
  using (user_id = public.clerk_user_id())
  with check (user_id = public.clerk_user_id());

revoke update on public.profiles from anon, authenticated;
grant  update (display_name, avatar_path, bio) on public.profiles to authenticated;

-- INSERT and DELETE are service-role only: profiles are created by
-- clerk-webhook, never by the client.

-- ── user_roles ────────────────────────────────────────────────────────────
create policy user_roles_select_own on public.user_roles
  for select using (user_id = public.clerk_user_id());

create policy user_roles_select_staff on public.user_roles
  for select using ((select public.is_staff()));

-- No write policies. Roles change only through admin Edge Functions, so a
-- compromised browser token can never escalate itself.

-- ── user_role_audit ───────────────────────────────────────────────────────
create policy user_role_audit_select_admin on public.user_role_audit
  for select using ((select public.has_role('administrator')));

comment on table public.user_role_audit is
  'Written by trigger only. Readable by administrators.';

-- ── creator_applications ──────────────────────────────────────────────────
create policy creator_applications_select_own on public.creator_applications
  for select using (user_id = public.clerk_user_id());

create policy creator_applications_insert_own on public.creator_applications
  for insert with check (
    user_id = public.clerk_user_id()
    -- cannot self-approve: status defaults to 'pending' and is not grantable
    and status = 'pending'
  );

create policy creator_applications_select_staff on public.creator_applications
  for select using ((select public.is_staff()));

revoke insert on public.creator_applications from anon, authenticated;
grant  insert (user_id, bio, portfolio_url) on public.creator_applications to authenticated;

-- ── notification_preferences ──────────────────────────────────────────────
create policy notification_preferences_select_own on public.notification_preferences
  for select using (user_id = public.clerk_user_id());

create policy notification_preferences_update_own on public.notification_preferences
  for update
  using (user_id = public.clerk_user_id())
  with check (user_id = public.clerk_user_id());

revoke update on public.notification_preferences from anon, authenticated;
grant  update (channels) on public.notification_preferences to authenticated;

-- ── credit_ledger ─────────────────────────────────────────────────────────
-- Read-only to its owner. NO client write policy of any kind: every mutation
-- goes through reserve/settle/grant, which are revoked from public roles.
create policy credit_ledger_select_own on public.credit_ledger
  for select using (user_id = public.clerk_user_id());

create policy credit_ledger_select_admin on public.credit_ledger
  for select using ((select public.has_role('administrator')));

comment on view public.credit_balances is
  'Reads through credit_ledger RLS: a user sees only their own balance row.';

-- ── platform_settings ─────────────────────────────────────────────────────
create policy platform_settings_select_all on public.platform_settings
  for select using (public.clerk_user_id() is not null);

-- ── audit_logs ────────────────────────────────────────────────────────────
create policy audit_logs_select_admin on public.audit_logs
  for select using ((select public.has_role('administrator')));

-- ── processed_webhook_events ──────────────────────────────────────────────
-- Deliberately no policies. Service role only.

-- ── lock down the new definer functions ───────────────────────────────────
-- setting_int / setting_bool read a non-secret table and take no user id, so
-- they stay callable. clerk_user_id/has_role/is_staff read the CALLER's own
-- JWT and are likewise safe — they are used inside policies and must remain
-- executable by `authenticated`.
grant execute on function public.clerk_user_id()                to anon, authenticated;
grant execute on function public.has_role(public.app_role)      to anon, authenticated;
grant execute on function public.is_staff()                     to anon, authenticated;
grant execute on function public.setting_int(text, int)         to authenticated;
grant execute on function public.setting_bool(text, boolean)    to authenticated;

-- ── the assertion this migration exists to make ───────────────────────────
-- scripts/test-rls.mjs proves at runtime that user A cannot read user B's
-- ledger. Phase 0 is not complete until it passes. If the Clerk↔Supabase
-- third-party auth integration is not enabled, these policies do not fail
-- loudly — every read simply returns EMPTY. (CLAUDE.md trap #6)
