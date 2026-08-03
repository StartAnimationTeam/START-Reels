-- 0014_rate_limits.sql — fixed-window rate limiting, in Postgres
--
-- Postgres rather than Redis, deliberately: at this platform's scale (5k
-- users) a fixed-window counter table is one indexed upsert per checked
-- request against a database we already run, with no new vendor, no new
-- secret, and testable like everything else. Upstash earns its place when
-- per-request Redis latency beats a Postgres round-trip that is already
-- happening — i.e. at a scale where the counter table is hot. Revisit then;
-- the call sites won't change shape.
--
-- Fixed window (not sliding): a caller can burst 2x at a window boundary.
-- For abuse-protection limits (not billing), that trade for a single upsert
-- is the right one.

create table public.rate_limits (
  key          text not null,           -- e.g. 'playback:user_abc'
  window_start timestamptz not null,
  count        int not null default 1,
  primary key (key, window_start)
);

alter table public.rate_limits enable row level security;
-- no policies: service-role and definer functions only

-- Returns true when the request is ALLOWED. One upsert, race-safe by ON
-- CONFLICT arithmetic — concurrent callers each increment atomically.
create or replace function public.check_rate_limit(
  p_key text,
  p_limit int,
  p_window_seconds int
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window timestamptz;
  v_count  int;
begin
  v_window := to_timestamp(
    floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds
  );

  insert into public.rate_limits (key, window_start, count)
  values (p_key, v_window, 1)
  on conflict (key, window_start)
  do update set count = public.rate_limits.count + 1
  returning count into v_count;

  return v_count <= p_limit;
end;
$$;

revoke execute on function public.check_rate_limit(text, int, int) from public, anon, authenticated;
grant execute on function public.check_rate_limit(text, int, int) to service_role;

-- ── promo guessing protection ─────────────────────────────────────────────
-- redeem_promo is browser-callable, and its deliberate single "promo_invalid"
-- error means an attacker learns nothing per guess — but they can still guess
-- fast. 10 attempts/hour per user makes brute-forcing a code space of
-- [A-Z0-9-]{3,32} a non-event. The limit is checked BEFORE the code lookup so
-- even the timing of a hit vs miss stays behind it.
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
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;

  select * into v_campaign
  from public.promo_campaigns
  where code = upper(trim(p_code)) and is_active;

  if not found or v_campaign.starts_at > now()
     or (v_campaign.ends_at is not null and v_campaign.ends_at < now()) then
    raise exception 'promo_invalid' using errcode = 'P0001';
  end if;

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

-- CREATE OR REPLACE with the SAME signature keeps existing grants (trap #7's
-- re-grant bite is on CHANGED signatures) — but restate them anyway, so this
-- migration is correct in isolation rather than by accident of history.
grant execute on function public.redeem_promo(text) to authenticated;
revoke execute on function public.redeem_promo(text) from anon, public;

-- ── window hygiene ────────────────────────────────────────────────────────
-- Old windows are dead weight; sweep them with the nightly job's schedule by
-- extending sweep_stale_holds' cleanup? No — separate concern, separate tiny
-- job: delete windows older than 2 days, daily.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'prune-rate-limits') then
    perform cron.unschedule('prune-rate-limits');
  end if;
  perform cron.schedule('prune-rate-limits', '40 19 * * *',
    $sql$delete from public.rate_limits where window_start < now() - interval '2 days'$sql$);
exception when others then
  raise notice 'pg_cron unavailable (%)', sqlerrm;
end $$;
