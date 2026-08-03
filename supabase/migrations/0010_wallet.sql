-- 0010_wallet.sql — daily rewards, promo codes, avatar storage
--
-- The two claim functions follow the recommended_videos() pattern: SECURITY
-- DEFINER with NO user-id parameter — identity comes from clerk_user_id()
-- inside — so they are safe to grant to `authenticated` and the browser calls
-- them straight over PostgREST. A caller can only ever claim for themself.
-- (The opposite shape, unlock_video(p_user_id), stays revoked; the parameter
-- is what makes it dangerous.)

-- ── daily rewards ─────────────────────────────────────────────────────────
create table public.daily_reward_claims (
  user_id    text not null,
  claim_date date not null,
  amount     numeric not null,
  ledger_id  uuid not null,
  claimed_at timestamptz not null default now(),
  primary key (user_id, claim_date)
);

alter table public.daily_reward_claims enable row level security;
create policy daily_reward_claims_select_own on public.daily_reward_claims
  for select using (user_id = public.clerk_user_id());
-- writes: only through claim_daily_reward()

create or replace function public.claim_daily_reward()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user   text;
  v_tz     text;
  v_today  date;
  v_amount numeric;
  v_ledger uuid;
begin
  v_user := public.clerk_user_id();
  if v_user is null then
    raise exception 'unauthorized' using errcode = 'P0001';
  end if;

  if not public.setting_bool('daily_reward_enabled', true) then
    raise exception 'daily_reward_disabled' using errcode = 'P0001';
  end if;

  -- "Today" is the PLATFORM's day, not UTC and not the browser's clock —
  -- users near midnight otherwise double-claim or feel robbed (trap #17).
  v_tz := coalesce(
    (select value #>> '{}' from public.platform_settings where key = 'platform_timezone'),
    'UTC'
  );
  v_today := (now() at time zone v_tz)::date;

  v_amount := public.setting_int('daily_reward_amount', 1);

  -- Idempotency is the primary key, not application logic: the second claim
  -- of the day hits the constraint, whatever the caller raced.
  begin
    insert into public.daily_reward_claims (user_id, claim_date, amount, ledger_id)
    values (v_user, v_today, v_amount, gen_random_uuid());
  exception when unique_violation then
    raise exception 'already_claimed_today' using errcode = 'P0001';
  end;

  -- Grant AFTER the claim row exists; the ledger's own idempotency key is
  -- the second lock on the same door (the double-grant lesson, again).
  v_ledger := public.grant_credits(
    v_user, v_amount, 'daily_reward',
    'daily_reward', v_today::text, 'watch',
    'daily:' || v_user || ':' || v_today::text,
    '{}'::jsonb
  );

  update public.daily_reward_claims
  set ledger_id = v_ledger
  where user_id = v_user and claim_date = v_today;

  return jsonb_build_object('claimed', v_amount, 'date', v_today);
end;
$$;

-- ── promo codes ───────────────────────────────────────────────────────────
create table public.promo_campaigns (
  id              uuid primary key default gen_random_uuid(),
  code            text not null unique,
  name            text not null,
  amount          numeric not null check (amount > 0),
  starts_at       timestamptz not null default now(),
  ends_at         timestamptz,
  max_redemptions int,                    -- null = unlimited
  per_user_limit  int not null default 1,
  is_active       boolean not null default true,
  created_by      text,
  created_at      timestamptz not null default now(),
  constraint promo_code_shape check (code ~ '^[A-Z0-9-]{3,32}$')
);

create table public.promo_redemptions (
  campaign_id uuid not null references public.promo_campaigns (id) on delete cascade,
  user_id     text not null,
  ledger_id   uuid not null,
  redeemed_at timestamptz not null default now(),
  -- per_user_limit = 1 is the norm; the count in redeem_promo handles > 1.
  primary key (campaign_id, user_id, ledger_id)
);

create index promo_redemptions_campaign_idx on public.promo_redemptions (campaign_id);

alter table public.promo_campaigns  enable row level security;
alter table public.promo_redemptions enable row level security;

-- Campaigns are NOT client-readable: listing them would publish every code.
-- Redemption goes through redeem_promo(), which looks the code up itself.
create policy promo_campaigns_select_admin on public.promo_campaigns
  for select using ((select public.has_role('administrator')));
create policy promo_redemptions_select_own on public.promo_redemptions
  for select using (user_id = public.clerk_user_id());

create or replace function public.redeem_promo(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user     text;
  v_campaign public.promo_campaigns%rowtype;
  v_used     int;
  v_mine     int;
  v_ledger   uuid;
begin
  v_user := public.clerk_user_id();
  if v_user is null then
    raise exception 'unauthorized' using errcode = 'P0001';
  end if;

  select * into v_campaign
  from public.promo_campaigns
  where code = upper(trim(p_code)) and is_active;

  -- One error for "no such code", "expired" and "not started": telling an
  -- attacker WHICH guess was close is a gift. The admin view shows the truth.
  if not found or v_campaign.starts_at > now()
     or (v_campaign.ends_at is not null and v_campaign.ends_at < now()) then
    raise exception 'promo_invalid' using errcode = 'P0001';
  end if;

  -- Serialize per campaign so max_redemptions cannot be raced past the cap.
  perform pg_advisory_xact_lock(hashtextextended('promo:' || v_campaign.id::text, 0));

  if v_campaign.max_redemptions is not null then
    select count(*) into v_used from public.promo_redemptions where campaign_id = v_campaign.id;
    if v_used >= v_campaign.max_redemptions then
      raise exception 'promo_exhausted' using errcode = 'P0001';
    end if;
  end if;

  select count(*) into v_mine
  from public.promo_redemptions
  where campaign_id = v_campaign.id and user_id = v_user;
  if v_mine >= v_campaign.per_user_limit then
    raise exception 'promo_already_redeemed' using errcode = 'P0001';
  end if;

  v_ledger := public.grant_credits(
    v_user, v_campaign.amount, 'promo',
    'promo_campaign', v_campaign.id::text, 'watch',
    'promo:' || v_campaign.id::text || ':' || v_user || ':' || (v_mine + 1)::text,
    jsonb_build_object('code', v_campaign.code)
  );

  insert into public.promo_redemptions (campaign_id, user_id, ledger_id)
  values (v_campaign.id, v_user, v_ledger);

  return jsonb_build_object('granted', v_campaign.amount, 'name', v_campaign.name);
end;
$$;

-- ── grants ────────────────────────────────────────────────────────────────
-- Safe BECAUSE neither takes a user id — identity is the JWT.
grant execute on function public.claim_daily_reward() to authenticated;
grant execute on function public.redeem_promo(text) to authenticated;
revoke execute on function public.claim_daily_reward() from anon, public;
revoke execute on function public.redeem_promo(text) from anon, public;

-- ── avatars ───────────────────────────────────────────────────────────────
-- Public-read bucket (profile pictures are shown across the app; a signed
-- URL per avatar per render is cost without benefit). Writes are pinned by
-- storage RLS to a folder named by the caller's own Clerk id — the client
-- cannot choose anyone else's path, which is the "server generates the path"
-- rule enforced by policy instead of by a server.
update storage.buckets set public = true where id = 'avatars';

create policy avatars_read on storage.objects
  for select using (bucket_id = 'avatars');

create policy avatars_write_own on storage.objects
  for insert with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = public.clerk_user_id()
  );

create policy avatars_update_own on storage.objects
  for update using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = public.clerk_user_id()
  );

create policy avatars_delete_own on storage.objects
  for delete using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = public.clerk_user_id()
  );
