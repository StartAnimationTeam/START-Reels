-- 0024_admin_read_engagement.sql — staff read for engagement analytics
--
-- series_follows and daily_reward_claims were owner-select only (correct
-- for the product surface), which also made them INVISIBLE to the admin
-- analytics page: follow counts and check-in engagement couldn't be
-- charted at all. Same pattern as 0009's staff reads: SELECT for staff,
-- helper wrapped in (select …) so Postgres evaluates it once per query,
-- not once per row (trap #8).

create policy series_follows_select_staff on public.series_follows
  for select using ((select public.is_staff()));

create policy daily_reward_claims_select_staff on public.daily_reward_claims
  for select using ((select public.is_staff()));
