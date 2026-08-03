-- 0009_admin_reads.sql — staff/admin read policies the dashboard needs
--
-- 0006/0007 gave watch data owner-only SELECT. Correct for users; the admin
-- surface needs to SEE it. Reads only — every admin WRITE still goes through
-- the Edge Functions, which audit.

create policy video_entitlements_select_staff on public.video_entitlements
  for select using ((select public.is_staff()));

create policy watch_sessions_select_admin on public.watch_sessions
  for select using ((select public.has_role('administrator')));

create policy watch_history_select_admin on public.watch_history
  for select using ((select public.has_role('administrator')));

-- Staff review unpublished uploads, so they need the sessions that track them.
create policy upload_sessions_select_staff on public.upload_sessions
  for select using ((select public.is_staff()));
