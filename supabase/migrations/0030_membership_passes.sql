-- 0030_membership_passes.sql — one-time membership passes (QRPh-first)
--
-- The org's PayMongo subscription approvals (cards/Maya) are still in
-- review, but ONE-TIME hosted checkout works today — QRPh is already
-- Active live, and test mode takes qrph/gcash/paymaya/card without any
-- approval. So the Member tab sells PASSES: pay once, get 7/30/365 days
-- on the same memberships row. No auto-renew — that is the honest QRPh
-- truth, and the UI says so. The subscription rail (0029) stays armed for
-- when the approvals land.
--
-- A pass payment reuses apply_subscription_payment() with the checkout
-- session id as the invoice key — same two-layer idempotency, same
-- extend-from-max semantics, same payment_invoices revenue record.

insert into public.platform_settings (key, value, description) values
  ('membership_passes_enabled', 'true'::jsonb,
   'Master switch for one-time membership passes on the Member page.'),
  ('membership_pass_prices',
   '{"weekly": 4900, "monthly": 14900, "annual": 99900}'::jsonb,
   'Pass prices in centavos, by tier. TEST placeholders until the CEO sets real prices.'),
  ('membership_pass_methods',
   '["qrph", "gcash", "paymaya", "card"]'::jsonb,
   'payment_method_types offered on the pass checkout page. Test mode takes all four; trim to what is Active at live cutover.')
on conflict (key) do nothing;
