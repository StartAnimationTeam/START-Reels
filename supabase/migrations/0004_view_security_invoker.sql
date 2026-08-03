-- 0004_view_security_invoker.sql
--
-- FIXES A REAL RLS HOLE found by scripts/test-rls.mjs on first run.
--
-- `credit_balances` is a VIEW over `credit_ledger`. RLS was enabled on the
-- table and the policy was correct, and the view STILL leaked: Bob could read
-- Alice's balance in full.
--
-- Why: a Postgres view executes with the privileges of its OWNER, not its
-- caller. The view is owned by `postgres`, which bypasses RLS, so the policy on
-- the underlying table was never consulted. The comment in 0003 claiming the
-- view "reads through credit_ledger RLS" was simply wrong.
--
-- This is the single most common way an otherwise-correct RLS setup leaks, and
-- it is invisible to inspection — the table looks locked down, the policy reads
-- correctly, and every direct query on the table behaves. Only a query through
-- the view as a real user shows it.
--
-- `security_invoker = on` (PostgreSQL 15+; this project is on 17.6) makes the
-- view run as the CALLER, so RLS on the base table applies.
--
-- RULE FOR THIS PROJECT: every view over an RLS-protected table must set
-- security_invoker. scripts/db-verify.mjs asserts it for all views, so a new
-- view cannot be added without one.

alter view public.credit_balances set (security_invoker = on);

comment on view public.credit_balances is
  'security_invoker = on — runs as the caller so credit_ledger RLS applies. '
  'Without it the view runs as its owner and leaks every user''s balance. '
  'See 0004_view_security_invoker.sql.';
