-- 0006_entitlements.sql — the unlock model
--
-- WATCHES DON'T CHARGE. UNLOCKS DO.
--
-- An entitlement is a row granting user U access to video V until expires_at
-- (default 48h, from platform_settings.entitlement_window_hours). Within that
-- window rewatching, seeking, reloading and switching devices cost nothing,
-- because the entitlement already exists. Idempotency comes from a ROW
-- EXISTING, not from application logic remembering.

create type public.entitlement_source as enum (
  'purchase',      -- paid with credits (the only path that touches the ledger)
  'free_tier',     -- video is free
  'creator_own',   -- creators watch their own videos free
  'role_bypass',   -- moderators/admins reviewing content
  'promo',
  'admin_grant'
);

create table public.video_entitlements (
  id               uuid primary key default gen_random_uuid(),
  user_id          text not null,
  video_id         uuid not null references public.videos (id) on delete cascade,
  source           public.entitlement_source not null,

  -- SNAPSHOT of what was actually charged. A later price change must not
  -- rewrite history; refunds and disputes are settled against this number,
  -- never against videos.credit_cost as it is today.
  credits_charged  numeric not null default 0,
  ledger_id        uuid,          -- the hold in credit_ledger; null on free paths

  granted_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  revoked_at       timestamptz,
  revoke_reason    text
);

create index video_entitlements_lookup_idx
  on public.video_entitlements (user_id, video_id, expires_at desc);
create index video_entitlements_video_idx
  on public.video_entitlements (video_id)
  where revoked_at is null;
create index video_entitlements_ledger_idx
  on public.video_entitlements (ledger_id)
  where ledger_id is not null;

alter table public.video_entitlements enable row level security;

create policy video_entitlements_select_own on public.video_entitlements
  for select using (user_id = public.clerk_user_id());
-- NO client insert, ever. unlock_video() is the only writer.

-- ── unlock_video ──────────────────────────────────────────────────────────
-- One function, one lock, one truth. Reached by the video-unlock Edge
-- Function today, admin comp grants tomorrow, and a Stripe webhook if credits
-- are ever sold — the rule lives here so no caller can skip it.
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
  v_entitlement  public.video_entitlements%rowtype;
  v_window_hours int;
  v_is_staff     boolean;
  v_ledger_id    uuid;
  v_source       public.entitlement_source;
begin
  -- Two tabs hitting Play at the same moment must not both charge. Same
  -- primitive as reserve_credits, keyed on the (user, video) pair so
  -- different users and different videos never queue behind each other.
  perform pg_advisory_xact_lock(
    hashtextextended(p_user_id || ':unlock:' || p_video_id::text, 0)
  );

  -- 1. An existing live entitlement wins — this is the idempotency guarantee.
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

  -- 2. The video must be genuinely watchable.
  select * into v_video from public.videos where id = p_video_id;
  if not found or v_video.deleted_at is not null then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if v_video.status <> 'published' then
    -- Creators may open their own unpublished videos; nobody else may.
    if v_video.creator_id <> p_user_id then
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

  v_window_hours := public.setting_int('entitlement_window_hours', 48);

  select exists (
    select 1 from public.user_roles
    where user_id = p_user_id and role in ('moderator', 'administrator')
  ) into v_is_staff;

  -- 4. Free paths write NO ledger row at all — a zero-amount row is noise in
  --    a spend report and inflates every "credits consumed" metric.
  if v_video.access_tier = 'free' then
    v_source := 'free_tier';
  elsif v_video.creator_id = p_user_id then
    v_source := 'creator_own';
  elsif v_is_staff then
    v_source := 'role_bypass';
  else
    -- 5. Paid path: reserve first. Raises insufficient_credits with the
    --    balance in the message; the UI translates the code, never the text.
    v_ledger_id := public.reserve_credits(
      p_user_id, 'watch', v_video.credit_cost,
      'watch_debit', 'video_unlock', p_video_id::text
    );
    v_source := 'purchase';
  end if;

  insert into public.video_entitlements
    (user_id, video_id, source, credits_charged, ledger_id, expires_at)
  values
    (p_user_id, p_video_id, v_source,
     case when v_source = 'purchase' then v_video.credit_cost else 0 end,
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

-- ── revoke_video_entitlements ─────────────────────────────────────────────
-- Deleting or unpublishing a paid video must not silently destroy access
-- people paid for. Every unconsumed purchase is refunded as a `refund` ledger
-- row (a pending hold is reversed instead — it was never really spent), and
-- the caller is expected to write an audit_logs entry naming the actor.
create or replace function public.revoke_video_entitlements(
  p_video_id uuid,
  p_reason text
) returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row    record;
  v_count  int := 0;
begin
  for v_row in
    select e.*, l.status as ledger_status
    from public.video_entitlements e
    left join public.credit_ledger l on l.id = e.ledger_id
    where e.video_id = p_video_id
      and e.revoked_at is null
      and e.expires_at > now()
  loop
    update public.video_entitlements
    set revoked_at = now(), revoke_reason = p_reason
    where id = v_row.id;

    if v_row.source = 'purchase' and v_row.ledger_id is not null then
      if v_row.ledger_status = 'pending' then
        -- Hold never settled: reverse it. Nothing was truly spent.
        perform public.settle_credit_hold(v_row.ledger_id, false);
      elsif v_row.ledger_status = 'committed' then
        -- Genuinely spent: give it back as an explicit refund row.
        insert into public.credit_ledger
          (user_id, credit_type, amount, status, reason, reference_type, reference_id, metadata)
        values
          (v_row.user_id, 'watch', v_row.credits_charged, 'committed', 'refund',
           'video_unlock', p_video_id::text,
           jsonb_build_object('revoked_entitlement', v_row.id, 'reason', p_reason));
      end if;
    end if;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

-- ── LOCK DOWN ─────────────────────────────────────────────────────────────
-- Both take a p_user_id or act on other users' money. World-executable would
-- mean anyone with the publishable key can unlock videos on any account or
-- mass-revoke a video. (CLAUDE.md trap #7 — repeat on any signature change.)
revoke execute on function
  public.unlock_video(text, uuid),
  public.revoke_video_entitlements(uuid, text)
from public, anon, authenticated;

grant execute on function
  public.unlock_video(text, uuid),
  public.revoke_video_entitlements(uuid, text)
to service_role;
