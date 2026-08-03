-- 0012_promo_admin_read.sql — the promos admin page counts redemptions;
-- 0010 gave promo_redemptions owner-only SELECT. Read-only widening, same
-- rationale as 0009: admin reads via RLS, admin writes via audited functions.

create policy promo_redemptions_select_admin on public.promo_redemptions
  for select using ((select public.has_role('administrator')));
