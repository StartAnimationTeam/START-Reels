-- 0027_ad_rewards.sql — the rewarded-ad coin rail
--
-- ONE grant rail, two doors. The web door (ads-claim, Clerk-authenticated)
-- rides Google's GPT rewarded event — web rewarded has NO server-side
-- verification, so its trust ceiling is the client's word, bounded hard by
-- the daily cap × amount. The native door (ads-ssv) verifies Google's
-- ECDSA-signed SSV callback and is the real thing once the AdMob app
-- exists. Both call grant_ad_reward(); nothing else may.
--
-- No enum surgery: the ledger reason stays 'promo' with reference_type
-- 'ad_reward' (the closed-enum convention since 0019). Idempotency is the
-- events table's UNIQUE (provider, transaction_id) plus grant_credits'
-- own key — a replayed callback returns the original grant, never doubles.

create table public.ad_reward_events (
  id             uuid primary key default gen_random_uuid(),
  user_id        text not null,
  provider       text not null check (provider in ('gpt_web', 'admob', 'test')),
  transaction_id text not null,
  amount         numeric not null,
  ledger_id      uuid,
  metadata       jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  unique (provider, transaction_id)
);

create index ad_reward_events_user_idx on public.ad_reward_events (user_id, created_at desc);

alter table public.ad_reward_events enable row level security;

create policy ad_reward_events_select_own on public.ad_reward_events
  for select using (user_id = public.clerk_user_id());

-- Staff read for the analytics tile (the 0024 pattern).
create policy ad_reward_events_select_staff on public.ad_reward_events
  for select using ((select public.is_staff()));

-- No client INSERT/UPDATE/DELETE policies: grant_ad_reward is the only writer.

insert into public.platform_settings (key, value, description) values
  ('ad_rewards_enabled', 'true'::jsonb,
   'Master switch for watch-ad-earn-coins.'),
  ('ad_reward_amount', '5'::jsonb,
   'Coins granted per completed rewarded ad.'),
  ('ad_reward_daily_cap', '10'::jsonb,
   'Max rewarded-ad grants per user per platform day.'),
  ('ad_reward_min_interval_seconds', '30'::jsonb,
   'Minimum seconds between two rewarded-ad grants for one user.'),
  ('ad_test_mode', 'false'::jsonb,
   'When true, ads-ssv accepts the secret-gated unsigned test rail.')
on conflict (key) do nothing;

-- ── the grant rail ────────────────────────────────────────────────────────
create or replace function public.grant_ad_reward(
  p_user_id        text,
  p_provider       text,
  p_transaction_id text,
  p_metadata       jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing  public.ad_reward_events%rowtype;
  v_tz        text;
  v_today     date;
  v_count     int;
  v_cap       int;
  v_interval  int;
  v_amount    numeric;
  v_ledger    uuid;
  v_event_id  uuid;
begin
  if p_provider not in ('gpt_web', 'admob', 'test') then
    raise exception 'bad_request' using errcode = 'P0001';
  end if;
  if p_user_id is null or p_transaction_id is null or length(p_transaction_id) < 4 then
    raise exception 'bad_request' using errcode = 'P0001';
  end if;

  if not public.setting_bool('ad_rewards_enabled', true) then
    raise exception 'ad_rewards_disabled' using errcode = 'P0001';
  end if;

  -- One user's grants serialize; different users never queue behind each other.
  perform pg_advisory_xact_lock(hashtextextended('adreward:' || p_user_id, 0));

  -- 1. DUPLICATE BEFORE CAP: a replayed callback must return the original
  --    grant, never an error — Google retries on anything that looks wrong.
  select * into v_existing
  from public.ad_reward_events
  where provider = p_provider and transaction_id = p_transaction_id;
  if found then
    return jsonb_build_object(
      'status', 'duplicate', 'amount', v_existing.amount, 'ledger_id', v_existing.ledger_id
    );
  end if;

  -- 2. The PLATFORM's day, never UTC-by-accident (trap #17).
  v_tz := coalesce(
    (select value #>> '{}' from public.platform_settings where key = 'platform_timezone'),
    'UTC'
  );
  v_today := (now() at time zone v_tz)::date;
  v_cap := public.setting_int('ad_reward_daily_cap', 10);

  select count(*) into v_count
  from public.ad_reward_events
  where user_id = p_user_id
    and (created_at at time zone v_tz)::date = v_today;
  if v_count >= v_cap then
    raise exception 'ad_reward_cap_reached' using errcode = 'P0001';
  end if;

  -- 3. Rapid-fire guard: rewarded ads take ~30s to watch; two grants inside
  --    the interval means automation, not attention.
  v_interval := public.setting_int('ad_reward_min_interval_seconds', 30);
  if exists (
    select 1 from public.ad_reward_events
    where user_id = p_user_id
      and created_at > now() - make_interval(secs => v_interval)
  ) then
    raise exception 'ad_reward_too_soon' using errcode = 'P0001';
  end if;

  v_amount := public.setting_int('ad_reward_amount', 5);
  if v_amount <= 0 then
    raise exception 'ad_rewards_disabled' using errcode = 'P0001';
  end if;

  -- 4. The event row is the idempotency claim; a concurrent replay loses
  --    the unique race and returns the winner's grant.
  begin
    insert into public.ad_reward_events (user_id, provider, transaction_id, amount, metadata)
    values (p_user_id, p_provider, p_transaction_id, v_amount, coalesce(p_metadata, '{}'::jsonb))
    returning id into v_event_id;
  exception when unique_violation then
    select * into v_existing
    from public.ad_reward_events
    where provider = p_provider and transaction_id = p_transaction_id;
    return jsonb_build_object(
      'status', 'duplicate', 'amount', v_existing.amount, 'ledger_id', v_existing.ledger_id
    );
  end;

  -- 5. Coins AFTER the claim exists; the ledger's own idempotency key is
  --    the second lock on the same door.
  v_ledger := public.grant_credits(
    p_user_id, v_amount, 'promo',
    'ad_reward', p_transaction_id, 'watch',
    'ad:' || p_provider || ':' || p_transaction_id,
    coalesce(p_metadata, '{}'::jsonb)
  );

  update public.ad_reward_events set ledger_id = v_ledger where id = v_event_id;

  return jsonb_build_object(
    'status', 'granted',
    'amount', v_amount,
    'ledger_id', v_ledger,
    'today_count', v_count + 1,
    'daily_cap', v_cap
  );
end;
$$;

-- Takes a p_user_id ⇒ NEVER client-callable (trap #7). db-verify's definer
-- scan asserts this stays true.
revoke execute on function public.grant_ad_reward(text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.grant_ad_reward(text, text, text, jsonb)
  to service_role;
