-- 0016_settings_fn_revoke.sql
--
-- CI's SECURITY DEFINER guard flagged 0003, correctly: setting_int and
-- setting_bool were granted to `authenticated` deliberately, but the implicit
-- EXECUTE-to-PUBLIC from creation was never revoked — so `anon` could call
-- them and read platform settings without signing in. The table's own policy
-- says signed-in only; a definer function that bypasses it for anon is a
-- (mild) leak and a (real) inconsistency.
--
-- 0003 is applied and therefore immutable, so the fix lands here, and 0003
-- carries a grandfather note in ci.yml pointing at this file.

revoke execute on function public.setting_int(text, int) from public, anon;
revoke execute on function public.setting_bool(text, boolean) from public, anon;
grant execute on function public.setting_int(text, int) to authenticated, service_role;
grant execute on function public.setting_bool(text, boolean) to authenticated, service_role;
