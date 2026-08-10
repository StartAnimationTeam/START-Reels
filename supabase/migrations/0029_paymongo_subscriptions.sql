-- 0029_paymongo_subscriptions.sql — the payment rail under memberships
--
-- PayMongo recurring subscriptions (weekly / monthly / annual) become the
-- second writer of the memberships row, beside the admin door from 0028.
-- The CEO's tier list adds WEEKLY, so the check constraint widens first.
--
-- Money-vs-entitlement doctrine, decided here and enforced structurally:
--   * ONLY a PAID INVOICE extends memberships.expires_at — via
--     apply_subscription_payment below, nothing else.
--   * Cancellation, past_due and unpaid never touch expires_at. Paid time
--     is paid time; natural expiry is the only clawback.
--   * Idempotency is two-layered: the webhook claims its EVENT id in
--     processed_webhook_events (trap #10), and this function claims the
--     INVOICE id — because subscription.activated and
--     subscription.invoice.paid may both carry the same first invoice
--     under different event ids. A replay at either layer is a no-op.
--
-- Provider ids stay server-side (trap #13's spirit): payment_subscriptions
-- exposes status columns to its owner through a COLUMN GRANT allowlist —
-- the 0005 provider_asset_id pattern — and provider_subscription_id is
-- deliberately not on the list.

-- ── weekly joins the tier list ────────────────────────────────────────────
alter table public.memberships drop constraint memberships_tier_check;
alter table public.memberships add constraint memberships_tier_check
  check (tier in ('weekly', 'monthly', 'annual'));

-- ── payment_customers: user ↔ PayMongo customer, forever ────────────────
-- RLS on, NO policies: service-role-only by design (the
-- processed_webhook_events stance) — the browser has no business reading
-- provider customer ids.
create table public.payment_customers (
  user_id              text primary key,
  provider             text not null default 'paymongo',
  provider_customer_id text not null unique,
  created_at           timestamptz not null default now()
);
alter table public.payment_customers enable row level security;

-- ── payment_subscriptions: the local mirror of the remote subscription ──
create table public.payment_subscriptions (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  text not null,
  provider                 text not null default 'paymongo',
  -- nullable: the local row is inserted BEFORE the remote create (the
  -- claim pattern) and back-filled once PayMongo answers.
  provider_subscription_id text unique,
  provider_plan_id         text,
  tier                     text not null check (tier in ('weekly', 'monthly', 'annual')),
  status                   text not null default 'pending' check (status in
    ('pending', 'incomplete', 'incomplete_cancelled', 'active', 'past_due', 'unpaid', 'cancelled')),
  current_period_end       timestamptz,
  cancelled_at             timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

-- One LIVE subscription per user, enforced by the database, not politeness.
-- A double-clicked Join loses this race instead of double-charging.
create unique index payment_subscriptions_one_live_idx
  on public.payment_subscriptions (user_id)
  where status in ('pending', 'incomplete', 'active', 'past_due');

create index payment_subscriptions_user_idx
  on public.payment_subscriptions (user_id, created_at desc);

alter table public.payment_subscriptions enable row level security;

create policy payment_subscriptions_select_own on public.payment_subscriptions
  for select using (user_id = public.clerk_user_id());

create policy payment_subscriptions_select_staff on public.payment_subscriptions
  for select using ((select public.is_staff()));

-- Column allowlist (0005 pattern): owners read their status, never the
-- provider ids. Grants are column-scoped; RLS above scopes the rows.
revoke select on public.payment_subscriptions from anon, authenticated;
grant select (user_id, tier, status, current_period_end, cancelled_at, created_at)
  on public.payment_subscriptions to authenticated;

-- ── payment_invoices: the revenue record AND the idempotency ledger ─────
-- The primary key IS the dedupe: an invoice extends a membership exactly
-- once, however many webhook deliveries carry it.
create table public.payment_invoices (
  provider_invoice_id text primary key,
  subscription_id     uuid,
  user_id             text not null,
  tier                text not null,
  amount_centavos     integer not null default 0,
  days_granted        integer not null,
  paid_at             timestamptz,
  created_at          timestamptz not null default now()
);

create index payment_invoices_user_idx on public.payment_invoices (user_id, created_at desc);

alter table public.payment_invoices enable row level security;

-- Staff read for the analytics tile; owners see their membership state via
-- memberships/payment_subscriptions, not raw invoices.
create policy payment_invoices_select_staff on public.payment_invoices
  for select using ((select public.is_staff()));

-- ── the one function that turns money into membership time ──────────────
create or replace function public.apply_subscription_payment(
  p_user_id                  text,
  p_tier                     text,
  p_provider_subscription_id text,
  p_provider_invoice_id      text,
  p_amount_centavos          integer default 0,
  p_paid_at                  timestamptz default now()
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_days       integer;
  v_inserted   boolean;
  v_expires    timestamptz;
  v_sub_id     uuid;
begin
  if p_user_id is null or p_provider_invoice_id is null then
    raise exception 'bad_request' using errcode = 'P0001';
  end if;

  v_days := case p_tier
    when 'weekly'  then 7
    when 'monthly' then 30
    when 'annual'  then 365
    else null
  end;
  if v_days is null then
    raise exception 'bad_request' using errcode = 'P0001';
  end if;

  select id into v_sub_id
  from public.payment_subscriptions
  where provider_subscription_id = p_provider_subscription_id;

  -- 1. The invoice row is the idempotency claim. A duplicate delivery —
  --    same invoice under ANY event id — stops here, expiry untouched.
  insert into public.payment_invoices
    (provider_invoice_id, subscription_id, user_id, tier, amount_centavos, days_granted, paid_at)
  values
    (p_provider_invoice_id, v_sub_id, p_user_id, p_tier, coalesce(p_amount_centavos, 0), v_days, p_paid_at)
  on conflict (provider_invoice_id) do nothing;
  get diagnostics v_inserted = row_count;

  if not v_inserted then
    select expires_at into v_expires from public.memberships where user_id = p_user_id;
    return jsonb_build_object('applied', false, 'duplicate', true, 'expires_at', v_expires);
  end if;

  -- 2. Extend from whichever is later: now, or the current expiry. Same
  --    semantics as the admin door — paid time stacks, never overlaps.
  insert into public.memberships (user_id, tier, started_at, expires_at, granted_by)
  values (p_user_id, p_tier, now(), now() + make_interval(days => v_days), 'paymongo')
  on conflict (user_id) do update set
    tier       = excluded.tier,
    started_at = case when memberships.expires_at > now() then memberships.started_at else now() end,
    expires_at = greatest(memberships.expires_at, now()) + make_interval(days => v_days),
    granted_by = 'paymongo',
    updated_at = now()
  returning expires_at into v_expires;

  -- 3. A paid invoice proves the subscription is alive.
  if v_sub_id is not null then
    update public.payment_subscriptions
    set status = 'active', current_period_end = v_expires, updated_at = now()
    where id = v_sub_id;
  end if;

  return jsonb_build_object(
    'applied', true, 'duplicate', false,
    'days_granted', v_days, 'expires_at', v_expires
  );
end;
$$;

-- Takes a p_user_id ⇒ NEVER client-callable (trap #7). db-verify's definer
-- scan asserts this stays true.
revoke execute on function public.apply_subscription_payment(text, text, text, text, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function public.apply_subscription_payment(text, text, text, text, integer, timestamptz)
  to service_role;
