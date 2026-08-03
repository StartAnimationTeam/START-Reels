-- 0011_moderation.sql — community reports and user warnings
--
-- Reports are the fourth (and last planned) client-writable surface, same
-- test as favorites and applications: filing a report moves no value, and the
-- WITH CHECK pins the reporter. Everything that ACTS on a report — resolving,
-- removing content, warning the uploader — goes through the audited
-- `moderation` Edge Function.

create type public.report_reason as enum (
  'inappropriate', 'copyright', 'spam', 'wrong_metadata', 'other'
);

create type public.report_status as enum ('open', 'reviewing', 'actioned', 'dismissed');

create table public.video_reports (
  id           uuid primary key default gen_random_uuid(),
  reporter_id  text not null,
  video_id     uuid not null references public.videos (id) on delete cascade,
  reason       public.report_reason not null,
  detail       text,
  status       public.report_status not null default 'open',
  reviewed_by  text,
  reviewed_at  timestamptz,
  action_taken text,
  created_at   timestamptz not null default now()
);

-- One OPEN report per user per video: mashing the button is not a signal.
create unique index video_reports_one_open_idx
  on public.video_reports (reporter_id, video_id)
  where status in ('open', 'reviewing');
create index video_reports_queue_idx on public.video_reports (status, created_at);
create index video_reports_video_idx on public.video_reports (video_id);

alter table public.video_reports enable row level security;

create policy video_reports_select_own on public.video_reports
  for select using (reporter_id = public.clerk_user_id());

create policy video_reports_insert_own on public.video_reports
  for insert with check (
    reporter_id = public.clerk_user_id()
    and status = 'open'
  );

create policy video_reports_select_staff on public.video_reports
  for select using ((select public.is_staff()));

revoke insert on public.video_reports from anon, authenticated;
grant insert (reporter_id, video_id, reason, detail) on public.video_reports to authenticated;
grant select on public.video_reports to authenticated;

-- ── warnings ──────────────────────────────────────────────────────────────
create table public.user_warnings (
  id                uuid primary key default gen_random_uuid(),
  user_id           text not null,
  issued_by         text not null,
  severity          text not null default 'notice'
                      check (severity in ('notice', 'warning', 'final')),
  reason            text not null,
  related_report_id uuid references public.video_reports (id) on delete set null,
  acknowledged_at   timestamptz,
  created_at        timestamptz not null default now()
);

create index user_warnings_user_idx on public.user_warnings (user_id, created_at desc);

alter table public.user_warnings enable row level security;

-- A warning the user can't see disciplines nobody: select own is the point.
create policy user_warnings_select_own on public.user_warnings
  for select using (user_id = public.clerk_user_id());

create policy user_warnings_select_staff on public.user_warnings
  for select using ((select public.is_staff()));

-- The one client write: acknowledging their own warning.
create policy user_warnings_ack_own on public.user_warnings
  for update
  using (user_id = public.clerk_user_id())
  with check (user_id = public.clerk_user_id());

revoke update on public.user_warnings from anon, authenticated;
grant update (acknowledged_at) on public.user_warnings to authenticated;
-- INSERTs: the moderation function only.
