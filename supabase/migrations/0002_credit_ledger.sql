-- 0002_credit_ledger.sql — append-only credit ledger, pending → committed/reversed
--
-- Ported from START AI Studio's 0001_credit_system.sql + 0005_reserve_credits_lock.sql,
-- with four deliberate changes:
--   1. ONE credit type, not six. AI Studio shipped six with four unspendable and
--      users saw a balance they could never spend.
--   2. `reason` is a parameter. Theirs hardcodes 'ai_job_debit' inside
--      reserve_credits, so every row lies about why it exists.
--   3. `set search_path` pinned on every SECURITY DEFINER function. Without it a
--      definer function resolves objects against the CALLER's search_path.
--   4. Explicit REVOKE. See CLAUDE.md trap #7 — these take a p_user_id, so left
--      world-executable they let anyone with the publishable key move anyone's
--      credits.
-- The advisory lock is present from the start rather than added in a later fix.

create type public.credit_type   as enum ('watch');
create type public.ledger_status as enum ('pending', 'committed', 'reversed');

create type public.ledger_reason as enum (
  'signup_grant',       -- granted by clerk-webhook on user.created
  'daily_reward',
  'promo',
  'admin_grant',
  'watch_debit',        -- the only spend path in the MVP
  'refund',             -- video deleted while entitlement unconsumed
  'manual_adjustment',
  'top_up'              -- reserved: Stripe, post-MVP. Nothing writes it yet.
);

create table public.credit_ledger (
  id              uuid primary key default gen_random_uuid(),
  user_id         text not null,
  credit_type     public.credit_type not null default 'watch',
  amount          numeric not null,          -- positive = credit, negative = debit
  status          public.ledger_status not null default 'committed',
  reason          public.ledger_reason not null,
  reference_type  text,                      -- 'video_unlock' | 'daily_reward' | 'promo_campaign' | 'admin_grant' | 'clerk_event'
  reference_id    text,
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),

  constraint credit_ledger_amount_nonzero check (amount <> 0),
  -- a pending row is always a hold, and a hold is always a debit
  constraint credit_ledger_pending_is_debit check (status <> 'pending' or amount < 0)
);

create index credit_ledger_user_idx      on public.credit_ledger (user_id, credit_type, status);
create index credit_ledger_reference_idx on public.credit_ledger (reference_type, reference_id);
create index credit_ledger_created_idx   on public.credit_ledger (user_id, created_at desc);
-- the sweep scans only outstanding holds; keep it cheap as the ledger grows
create index credit_ledger_pending_idx   on public.credit_ledger (created_at)
  where status = 'pending';

comment on table public.credit_ledger is
  'Append-only. Never UPDATE amount except via settle_credit_hold, never DELETE.';

-- ── balances ──────────────────────────────────────────────────────────────
-- available = committed + outstanding holds (which are negative).
-- The UI must show available_balance, never committed_balance — otherwise a
-- user with open holds sees credits they cannot spend. (CLAUDE.md trap #18)
create or replace view public.credit_balances as
select
  user_id,
  credit_type,
  coalesce(sum(amount) filter (where status = 'committed'), 0) as committed_balance,
  coalesce(sum(amount) filter (where status = 'pending'),   0) as pending_holds,
  coalesce(sum(amount) filter (where status = 'committed'), 0)
    + coalesce(sum(amount) filter (where status = 'pending'), 0) as available_balance
from public.credit_ledger
group by user_id, credit_type;

-- ── reserve ───────────────────────────────────────────────────────────────
-- Writes a PENDING NEGATIVE row, which immediately reduces available balance.
-- That alone kills the obvious abuse: a user with 1 credit cannot open 50
-- premium videos in 50 tabs, because holds 2..50 fail the balance check.
--
-- The advisory lock closes a check-then-insert race: two concurrent calls for
-- the same (user, credit_type) could both read the same balance before either
-- inserted. Two tabs hitting Play at once is the common case here, not an edge
-- case. Calls for different users are unaffected — the key is that pair.
create or replace function public.reserve_credits(
  p_user_id        text,
  p_credit_type    public.credit_type,
  p_amount         numeric,                  -- positive; stored as a negative hold
  p_reason         public.ledger_reason,
  p_reference_type text,
  p_reference_id   text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_available numeric;
  v_ledger_id uuid;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'reserve_amount_must_be_positive: %', p_amount
      using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_user_id || ':' || p_credit_type::text, 0)
  );

  select coalesce(available_balance, 0) into v_available
  from public.credit_balances
  where user_id = p_user_id and credit_type = p_credit_type;

  if coalesce(v_available, 0) < p_amount then
    raise exception 'insufficient_credits: have %, need %', coalesce(v_available, 0), p_amount
      using errcode = 'P0001';
  end if;

  insert into public.credit_ledger
    (user_id, credit_type, amount, status, reason, reference_type, reference_id)
  values
    (p_user_id, p_credit_type, -p_amount, 'pending', p_reason, p_reference_type, p_reference_id)
  returning id into v_ledger_id;

  return v_ledger_id;
end;
$$;

-- ── settle ────────────────────────────────────────────────────────────────
-- committed on success, reversed on failure — a failed watch costs nothing.
-- Idempotent by raising: a second call finds no pending row. Callers that may
-- legitimately double-settle (the heartbeat) swallow that specific error.
create or replace function public.settle_credit_hold(
  p_ledger_id     uuid,
  p_success       boolean,
  p_actual_amount numeric default null       -- null keeps the reserved amount
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.credit_ledger%rowtype;
begin
  select * into v_row
  from public.credit_ledger
  where id = p_ledger_id and status = 'pending'
  for update;

  if not found then
    raise exception 'ledger_hold_not_found_or_already_settled: %', p_ledger_id
      using errcode = 'P0001';
  end if;

  if not p_success then
    update public.credit_ledger set status = 'reversed' where id = p_ledger_id;
    return;
  end if;

  if p_actual_amount is not null and p_actual_amount <> abs(v_row.amount) then
    if p_actual_amount <= 0 then
      -- nothing actually consumed: reverse rather than write a zero row
      update public.credit_ledger set status = 'reversed' where id = p_ledger_id;
    else
      update public.credit_ledger
      set amount = -p_actual_amount, status = 'committed'
      where id = p_ledger_id;
    end if;
  else
    update public.credit_ledger set status = 'committed' where id = p_ledger_id;
  end if;
end;
$$;

-- ── grant ─────────────────────────────────────────────────────────────────
-- Signup grants, daily rewards, promos, admin comps. Immediately committed.
--
-- p_idempotency_key is the whole point: webhooks are at-least-once, and a Clerk
-- retry once silently double-granted in AI Studio while the balance view
-- quietly doubled. Passing a key makes a replay a no-op that returns the
-- ORIGINAL row id rather than minting a second grant.
create or replace function public.grant_credits(
  p_user_id         text,
  p_amount          numeric,                 -- positive
  p_reason          public.ledger_reason,
  p_reference_type  text default null,
  p_reference_id    text default null,
  p_credit_type     public.credit_type default 'watch',
  p_idempotency_key text default null,
  p_metadata        jsonb default '{}'::jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ledger_id uuid;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'grant_amount_must_be_positive: %', p_amount
      using errcode = 'P0001';
  end if;

  if p_idempotency_key is not null then
    perform pg_advisory_xact_lock(hashtextextended('grant:' || p_idempotency_key, 0));

    select id into v_ledger_id
    from public.credit_ledger
    where metadata ->> 'idempotency_key' = p_idempotency_key
    limit 1;

    if found then
      return v_ledger_id;                    -- replay: return the original
    end if;
  end if;

  insert into public.credit_ledger
    (user_id, credit_type, amount, status, reason, reference_type, reference_id, metadata)
  values
    (p_user_id, p_credit_type, p_amount, 'committed', p_reason,
     p_reference_type, p_reference_id,
     case when p_idempotency_key is null then p_metadata
          else p_metadata || jsonb_build_object('idempotency_key', p_idempotency_key)
     end)
  returning id into v_ledger_id;

  return v_ledger_id;
end;
$$;

-- backs the idempotency lookup above
create index credit_ledger_idempotency_idx
  on public.credit_ledger ((metadata ->> 'idempotency_key'))
  where metadata ? 'idempotency_key';

-- ── convenience reader ────────────────────────────────────────────────────
create or replace function public.available_credits(
  p_user_id     text,
  p_credit_type public.credit_type default 'watch'
) returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select available_balance from public.credit_balances
     where user_id = p_user_id and credit_type = p_credit_type),
    0
  )
$$;

-- ── LOCK DOWN ─────────────────────────────────────────────────────────────
-- CLAUDE.md trap #7. Every function above takes a p_user_id, so if any is left
-- executable by `anon`/`authenticated`, anyone holding the publishable key —
-- which ships in the browser bundle — can move anyone's credits.
-- A `create or replace` that CHANGES A SIGNATURE re-grants EXECUTE to PUBLIC,
-- so this block must be repeated in any migration that alters these.
revoke execute on function
  public.reserve_credits(text, public.credit_type, numeric, public.ledger_reason, text, text),
  public.settle_credit_hold(uuid, boolean, numeric),
  public.grant_credits(text, numeric, public.ledger_reason, text, text, public.credit_type, text, jsonb),
  public.available_credits(text, public.credit_type)
from public, anon, authenticated;

-- Supabase's default privileges grant EXECUTE on new functions to anon,
-- authenticated AND service_role separately, so the revoke above leaves
-- service_role working. Granting it explicitly anyway: relying on a platform
-- default means a change to that default silently breaks every Edge Function,
-- and the failure would look like "credits stopped working" rather than "a
-- grant went missing".
grant execute on function
  public.reserve_credits(text, public.credit_type, numeric, public.ledger_reason, text, text),
  public.settle_credit_hold(uuid, boolean, numeric),
  public.grant_credits(text, numeric, public.ledger_reason, text, text, public.credit_type, text, jsonb),
  public.available_credits(text, public.credit_type)
to service_role;

-- The view is read through RLS on the underlying table (0003), not granted here.
