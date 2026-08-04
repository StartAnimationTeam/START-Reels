-- 0019_series_pricing_unlock.sql — the series pivot, part 2: the economy
--
-- unlock_video learns series pricing: episodes 1..free_episode_count are
-- free, later episodes cost series.episode_credit_cost. The ledger reason
-- stays `watch_debit` and the reference stays ('video_unlock', video_id) —
-- no enum surgery, and every existing report keeps meaning.
--
-- Two setting changes ride along:
--   entitlement_window_hours 48 → 87600 (~10 years). DramaBox unlocks are
--   permanent; the window model already tolerates a long horizon (the sweep
--   only reverses PENDING UNWATCHED holds older than 24h, playback just
--   checks expires_at > now()).
--   settle_after_seconds 30 → 10. Episodes run 60–90s; requiring 30 validated
--   seconds made a third of an episode the commit threshold.
--
-- SIGNATURE UNCHANGED, so grants survive the CREATE OR REPLACE — but the
-- revoke block is restated anyway, because the day someone edits the
-- signature is the day it silently re-grants to PUBLIC (trap #7).

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
  -- Two tabs hitting Play at the same moment must not both charge.
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

  -- 2b. …and so must its series. A removed/deleted series takes its episodes
  -- off sale even if an individual row was missed.
  if v_video.series_id is not null then
    select * into v_series from public.series where id = v_video.series_id;
    if not found or v_series.deleted_at is not null or v_series.status = 'removed' then
      raise exception 'not_found' using errcode = 'P0001';
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

  select exists (
    select 1 from public.user_roles
    where user_id = p_user_id and role in ('moderator', 'administrator')
  ) into v_is_staff;

  -- 4. Price resolution. SERIES PRICING IS THE TRUTH: inside the free window
  --    → free; past it → episode_credit_cost. The legacy per-video branch
  --    survives only for series-less rows, which 0018 should have eliminated.
  --    NOTE: is_members_only is deliberately NOT enforced here until a real
  --    membership exists — enforcing it now would brick tagged content.
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

  -- 5. Free paths write NO ledger row at all (a zero-amount row is noise in
  --    every spend report).
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

-- Restated even though the signature is unchanged (trap #7).
revoke execute on function public.unlock_video(text, uuid)
  from public, anon, authenticated;
grant execute on function public.unlock_video(text, uuid) to service_role;

-- ── settings retune ───────────────────────────────────────────────────────
update public.platform_settings
set value = to_jsonb(87600), updated_at = now()
where key = 'entitlement_window_hours';

update public.platform_settings
set value = to_jsonb(10), updated_at = now()
where key = 'settle_after_seconds';
