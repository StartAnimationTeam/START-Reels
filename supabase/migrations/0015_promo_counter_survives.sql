-- 0015_promo_counter_survives.sql
--
-- FIXES A REAL HOLE test-ratelimit.mjs caught on first run: redeem_promo
-- counted attempts with check_rate_limit and then RAISED on a bad code — and
-- the raise ABORTS THE TRANSACTION, rolling back the counter increment.
-- Ten wrong guesses left the counter at zero; the guessing limit never
-- engaged. PostgREST wraps each RPC in one transaction, so anything a
-- function wants to PERSIST across a failure must not signal that failure by
-- raising.
--
-- The fix: failure paths RETURN jsonb {error: code} instead of raising. The
-- increment commits with the (successful) transaction, and attempt #11 is
-- refused even with a correct code. `unauthorized` still raises — an
-- unauthenticated call has nothing worth persisting.
--
-- (rate_limited itself may return-or-raise equivalently: once the counter
-- exceeds the limit, refused attempts' increments are irrelevant — but it
-- returns too, for one consistent contract: this function reports failures
-- as data, and lib/labels.ts translates them identically either way.)

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

  if not public.check_rate_limit('promo:' || v_user, 10, 3600) then
    return jsonb_build_object('error', 'rate_limited');
  end if;

  select * into v_campaign
  from public.promo_campaigns
  where code = upper(trim(p_code)) and is_active;

  if not found or v_campaign.starts_at > now()
     or (v_campaign.ends_at is not null and v_campaign.ends_at < now()) then
    return jsonb_build_object('error', 'promo_invalid');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('promo:' || v_campaign.id::text, 0));

  if v_campaign.max_redemptions is not null then
    select count(*) into v_used from public.promo_redemptions where campaign_id = v_campaign.id;
    if v_used >= v_campaign.max_redemptions then
      return jsonb_build_object('error', 'promo_exhausted');
    end if;
  end if;

  select count(*) into v_mine
  from public.promo_redemptions
  where campaign_id = v_campaign.id and user_id = v_user;
  if v_mine >= v_campaign.per_user_limit then
    return jsonb_build_object('error', 'promo_already_redeemed');
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

grant execute on function public.redeem_promo(text) to authenticated;
revoke execute on function public.redeem_promo(text) from anon, public;
