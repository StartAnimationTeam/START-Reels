-- 0028_memberships.sql — membership becomes real machinery
--
-- The Member tab stops being a pure shell: a memberships table (one row per
-- user, expires_at is the truth), member pricing in unlock_video (members
-- unlock paid episodes for 0 coins), and is_members_only finally enforced —
-- 0019 deliberately deferred it "until a real membership exists"; it now
-- does.
--
-- NO PAYMENT RAIL YET, and therefore NO self-serve join: memberships are
-- granted by administrators (admin-users function, audited). A free Join
-- button would hand everyone the paid tier and make the coin economy
-- decorative. When payments land, the purchase flow writes the same row.
--
-- Tiers: monthly / annual (owner call — weekly is gone).

-- New entitlement source for member unlocks. Appending an enum value is
-- safe (nothing existing changes meaning); the literal below is only
-- resolved at runtime, after this statement commits.
alter type public.entitlement_source add value if not exists 'membership';

create table public.memberships (
  user_id    text primary key,
  tier       text not null check (tier in ('monthly', 'annual')),
  started_at timestamptz not null default now(),
  expires_at timestamptz not null,
  granted_by text,
  updated_at timestamptz not null default now()
);

alter table public.memberships enable row level security;

create policy memberships_select_own on public.memberships
  for select using (user_id = public.clerk_user_id());

create policy memberships_select_staff on public.memberships
  for select using ((select public.is_staff()));

-- No client writes: the admin-users function (service role) is the only
-- writer until the payment webhook joins it.

-- ── the one question everything asks ──────────────────────────────────────
create or replace function public.has_active_membership(p_user_id text)
returns boolean
language sql
stable
set search_path = public
as $$
  select exists (
    select 1 from public.memberships
    where user_id = p_user_id and expires_at > now()
  );
$$;

-- Invoker + RLS means a client calling this about someone else reads no
-- rows and gets false — but there is no reason for clients to hold it at
-- all, and trap #7 says be explicit.
revoke execute on function public.has_active_membership(text)
  from public, anon, authenticated;
grant execute on function public.has_active_membership(text) to service_role;

-- ── unlock_video: members pay nothing; members-only means members only ────
-- Body is 0023's with two additions, marked ★. Signature unchanged; revokes
-- restated anyway (trap #7).
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

  -- ★ membership status, resolved once, used for both gate and price.
  v_is_member := public.has_active_membership(p_user_id);

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

    -- ★ 2c. Members-only enforcement (deferred since 0019, live now that
    -- memberships exist). Creator and staff keep working access.
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

  -- 5. Free paths write NO ledger row at all. ★ Active members join the
  -- no-charge tier: unlimited series is THE membership benefit, and a
  -- zero-amount ledger row would be noise (same rule as free_tier).
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
