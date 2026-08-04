-- 0020_reward_streak.sql — 7-day escalating check-in
--
-- DramaBox-style rewards: consecutive daily claims climb a ladder, a missed
-- day resets to day 1, and the cycle repeats past day 7. The streak is
-- STORED on the claim row (O(1) claim, auditable) rather than recomputed
-- from the chain; yesterday's row is the only lookup.
--
-- claim_daily_reward keeps its no-arg signature — identity from
-- clerk_user_id(), safe to grant to authenticated (the 0010 shape) — and the
-- return value is a SUPERSET of the old one, so the existing wallet UI keeps
-- working until the rewards page replaces it.

alter table public.daily_reward_claims
  add column streak_day int not null default 1
    constraint daily_reward_streak_positive check (streak_day >= 1);

insert into public.platform_settings (key, value, description) values
  ('daily_reward_ladder', '[1,1,2,2,3,3,5]'::jsonb,
   'Coins per consecutive check-in day; 7 entries, cycles after day 7. Falls back to daily_reward_amount if malformed.')
on conflict (key) do nothing;

create or replace function public.claim_daily_reward()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user       text;
  v_tz         text;
  v_today      date;
  v_streak     int;
  v_ladder     jsonb;
  v_amount     numeric;
  v_next       numeric;
  v_ledger     uuid;
begin
  v_user := public.clerk_user_id();
  if v_user is null then
    raise exception 'unauthorized' using errcode = 'P0001';
  end if;

  if not public.setting_bool('daily_reward_enabled', true) then
    raise exception 'daily_reward_disabled' using errcode = 'P0001';
  end if;

  -- "Today" is the PLATFORM's day, not UTC and not the browser's clock (trap #17).
  v_tz := coalesce(
    (select value #>> '{}' from public.platform_settings where key = 'platform_timezone'),
    'UTC'
  );
  v_today := (now() at time zone v_tz)::date;

  -- Yesterday's claim continues the streak; anything else starts over.
  select coalesce(
    (select streak_day from public.daily_reward_claims
     where user_id = v_user and claim_date = v_today - 1),
    0
  ) + 1 into v_streak;

  select value into v_ladder
  from public.platform_settings where key = 'daily_reward_ladder';

  -- Ladder index cycles: day 8 pays like day 1. A malformed ladder falls
  -- back to the flat daily_reward_amount rather than failing the claim.
  v_amount := coalesce(
    (v_ladder ->> ((v_streak - 1) % 7))::numeric,
    public.setting_int('daily_reward_amount', 1)
  );
  v_next := coalesce(
    (v_ladder ->> (v_streak % 7))::numeric,
    public.setting_int('daily_reward_amount', 1)
  );

  -- Idempotency is the primary key, not application logic.
  begin
    insert into public.daily_reward_claims (user_id, claim_date, amount, ledger_id, streak_day)
    values (v_user, v_today, v_amount, gen_random_uuid(), v_streak);
  exception when unique_violation then
    raise exception 'already_claimed_today' using errcode = 'P0001';
  end;

  -- Grant AFTER the claim row exists; the ledger's own idempotency key is
  -- the second lock on the same door.
  v_ledger := public.grant_credits(
    v_user, v_amount, 'daily_reward',
    'daily_reward', v_today::text, 'watch',
    'daily:' || v_user || ':' || v_today::text,
    jsonb_build_object('streak_day', v_streak)
  );

  update public.daily_reward_claims
  set ledger_id = v_ledger
  where user_id = v_user and claim_date = v_today;

  return jsonb_build_object(
    'claimed',     v_amount,
    'date',        v_today,
    'streak_day',  v_streak,
    'next_amount', v_next
  );
end;
$$;

-- Same no-arg signature, but restate the grants anyway (trap #7): callable
-- by signed-in users only — identity comes from the JWT, not a parameter.
revoke execute on function public.claim_daily_reward() from public, anon;
grant execute on function public.claim_daily_reward() to authenticated, service_role;
