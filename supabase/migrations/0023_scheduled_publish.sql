-- 0023_scheduled_publish.sql — the release timer
--
-- A draft series with scheduled_publish_at set is ANNOUNCED: it appears in
-- the public Coming Soon shelf (new RLS policy — synopsis and cover are
-- exactly what an announcement shows), viewers can follow it, and a
-- minutely pg_cron job publishes it when the clock strikes — IF at least
-- one episode is ready, the same series_not_ready rule manual publishing
-- has. An overdue series with nothing encoded just waits for the next tick.
--
-- The gate that matters: staff episode uploads auto-publish on encode, so
-- without a check an announced show's episodes would be WATCHABLE by direct
-- link before release. unlock_video now refuses episodes of any unpublished
-- series for everyone but the creator and staff.

alter table public.series add column scheduled_publish_at timestamptz;

-- Announced drafts are publicly visible (that's what announced means).
-- Their EPISODES are not made visible by this — and unlock_video below
-- refuses them regardless.
create policy series_select_coming_soon on public.series
  for select using (
    status = 'draft' and scheduled_publish_at is not null and deleted_at is null
  );

create index series_scheduled_idx on public.series (scheduled_publish_at)
  where status = 'draft' and scheduled_publish_at is not null and deleted_at is null;

-- ── the publisher ─────────────────────────────────────────────────────────
create or replace function public.publish_scheduled_series()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  with due as (
    select s.id from public.series s
    where s.status = 'draft'
      and s.deleted_at is null
      and s.scheduled_publish_at is not null
      and s.scheduled_publish_at <= now()
      -- the series_not_ready rule: never publish a card that 404s on tap
      and exists (
        select 1 from public.videos v
        where v.series_id = s.id and v.status = 'published' and v.deleted_at is null
      )
  )
  update public.series se
  set status = 'published',
      published_at = now(),
      scheduled_publish_at = null
  from due
  where se.id = due.id;

  get diagnostics v_count = row_count;
  return jsonb_build_object('published', v_count);
end;
$$;

revoke execute on function public.publish_scheduled_series()
  from public, anon, authenticated;
grant execute on function public.publish_scheduled_series() to service_role;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'publish-scheduled-series') then
    perform cron.unschedule('publish-scheduled-series');
  end if;
  -- Every minute: the job is a single cheap indexed UPDATE, and a release
  -- timer that fires "within the hour" isn't a timer.
  perform cron.schedule('publish-scheduled-series', '* * * * *',
    'select public.publish_scheduled_series()');
exception when others then
  raise notice 'pg_cron unavailable (%); schedule externally', sqlerrm;
end $$;

-- ── unlock_video: no watching before the premiere ─────────────────────────
-- Same signature (grants survive; revokes restated anyway — trap #7). One
-- change against 0019: an episode of an UNPUBLISHED series is refused for
-- everyone but its creator and staff, closing the announced-but-unreleased
-- direct-link hole.
create or replace function public.unlock_video(
  p_user_id text,
  p_video_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_video        public.videos%rowtype;
  v_series       public.series%rowtype;
  v_entitlement  public.video_entitlements%rowtype;
  v_window_hours int;
  v_is_staff     boolean;
  v_ledger_id    uuid;
  v_source       public.entitlement_source;
  v_cost         numeric;
  v_owner        text;
begin
  perform pg_advisory_xact_lock(
    hashtextextended(p_user_id || ':unlock:' || p_video_id::text, 0)
  );

  -- 1. An existing live entitlement wins — the idempotency guarantee.
  select * into v_entitlement
  from public.video_entitlements
  where user_id = p_user_id
    and video_id = p_video_id
    and expires_at > now()
    and revoked_at is null
  order by expires_at desc
  limit 1;

  if found then
    return jsonb_build_object(
      'entitlement_id', v_entitlement.id,
      'ledger_id',      v_entitlement.ledger_id,
      'charged',        0,
      'already_unlocked', true,
      'expires_at',     v_entitlement.expires_at
    );
  end if;

  -- 2. The episode must be genuinely watchable.
  select * into v_video from public.videos where id = p_video_id;
  if not found or v_video.deleted_at is not null then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if v_video.status <> 'published' then
    if v_video.creator_id <> p_user_id then
      raise exception 'video_not_published' using errcode = 'P0001';
    end if;
  end if;

  select exists (
    select 1 from public.user_roles
    where user_id = p_user_id and role in ('moderator', 'administrator')
  ) into v_is_staff;

  -- 2b. …and so must its series: removed takes it off sale for everyone;
  -- a draft (including announced-and-scheduled) is watchable only by its
  -- creator and staff, however the episode's own status landed.
  if v_video.series_id is not null then
    select * into v_series from public.series where id = v_video.series_id;
    if not found or v_series.deleted_at is not null or v_series.status = 'removed' then
      raise exception 'not_found' using errcode = 'P0001';
    end if;
    if v_series.status <> 'published'
       and v_series.creator_id <> p_user_id
       and v_video.creator_id <> p_user_id
       and not v_is_staff then
      raise exception 'video_not_published' using errcode = 'P0001';
    end if;
  end if;

  -- 3. A suspended or banned user cannot unlock anything.
  if exists (
    select 1 from public.profiles
    where user_id = p_user_id
      and (banned_at is not null
           or (suspended_at is not null
               and (suspended_until is null or suspended_until > now())))
  ) then
    raise exception 'account_suspended' using errcode = 'P0001';
  end if;

  v_window_hours := public.setting_int('entitlement_window_hours', 87600);

  -- 4. Price resolution — series pricing is the truth (0019).
  if v_video.series_id is not null then
    if v_video.episode_number is not null
       and v_video.episode_number <= v_series.free_episode_count then
      v_cost := 0;
    else
      v_cost := v_series.episode_credit_cost;
    end if;
    v_owner := v_series.creator_id;
  else
    v_cost := case when v_video.access_tier = 'free' then 0 else v_video.credit_cost end;
    v_owner := v_video.creator_id;
  end if;

  -- 5. Free paths write NO ledger row at all.
  if v_cost = 0 then
    v_source := 'free_tier';
  elsif v_owner = p_user_id or v_video.creator_id = p_user_id then
    v_source := 'creator_own';
  elsif v_is_staff then
    v_source := 'role_bypass';
  else
    v_ledger_id := public.reserve_credits(
      p_user_id, 'watch', v_cost,
      'watch_debit', 'video_unlock', p_video_id::text
    );
    v_source := 'purchase';
  end if;

  insert into public.video_entitlements
    (user_id, video_id, source, credits_charged, ledger_id, expires_at)
  values
    (p_user_id, p_video_id, v_source,
     case when v_source = 'purchase' then v_cost else 0 end,
     v_ledger_id,
     now() + make_interval(hours => v_window_hours))
  returning * into v_entitlement;

  return jsonb_build_object(
    'entitlement_id', v_entitlement.id,
    'ledger_id',      v_entitlement.ledger_id,
    'charged',        v_entitlement.credits_charged,
    'already_unlocked', false,
    'expires_at',     v_entitlement.expires_at
  );
end;
$$;

revoke execute on function public.unlock_video(text, uuid)
  from public, anon, authenticated;
grant execute on function public.unlock_video(text, uuid) to service_role;
