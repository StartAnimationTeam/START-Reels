-- 0031_membership_rentals.sql — membership access RENTS, it isn't bought
--
-- Owner call: when a membership lapses, everything it unlocked locks
-- again. 0028 wrote member unlocks with the standard ~10-year window, so
-- they outlived the membership. Now a membership-sourced entitlement's
-- expires_at IS the membership's expires_at at unlock time:
--
--   * natural expiry  → entitlements die the same second, zero sweeps
--   * extension       → membership only ever moves FORWARD; an already-
--                       pinned entitlement simply re-mints free (charged 0,
--                       no ledger row) the next time the member plays it
--   * admin "End now" → admin-users bulk-expires membership entitlements
--                       alongside the membership row (deployed with this)
--
-- COIN-PAID unlocks (source 'purchase') are untouched and stay permanent:
-- people paid coins for those, and revoking bought goods is trap #14
-- territory. free_tier / creator_own / role_bypass are also unchanged.

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
  v_is_member    boolean;
  v_member_until timestamptz;
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

  -- ★ 0031: membership status AND its horizon — the horizon becomes the
  -- entitlement's lifetime for member unlocks.
  select expires_at into v_member_until
  from public.memberships
  where user_id = p_user_id and expires_at > now();
  v_is_member := found;

  -- 2b. …and so must its series.
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

    -- 2c. Members-only enforcement (0028).
    if v_series.is_members_only
       and not v_is_member
       and not v_is_staff
       and v_series.creator_id <> p_user_id
       and v_video.creator_id <> p_user_id then
      raise exception 'members_only' using errcode = 'P0001';
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
  elsif v_is_member then
    v_source := 'membership';
  else
    v_ledger_id := public.reserve_credits(
      p_user_id, 'watch', v_cost,
      'watch_debit', 'video_unlock', p_video_id::text
    );
    v_source := 'purchase';
  end if;

  -- ★ 0031: a member unlock lives exactly as long as the membership.
  insert into public.video_entitlements
    (user_id, video_id, source, credits_charged, ledger_id, expires_at)
  values
    (p_user_id, p_video_id, v_source,
     case when v_source = 'purchase' then v_cost else 0 end,
     v_ledger_id,
     case when v_source = 'membership' then v_member_until
          else now() + make_interval(hours => v_window_hours) end)
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

-- ── backfill: existing membership entitlements adopt the new rule ────────
-- Pin every live membership-sourced entitlement to its owner's current
-- membership horizon; owners with no active membership lock right now.
update public.video_entitlements ve
set expires_at = coalesce(
  (select m.expires_at from public.memberships m
   where m.user_id = ve.user_id and m.expires_at > now()),
  now()
)
where ve.source = 'membership'
  and ve.revoked_at is null
  and ve.expires_at > now();
