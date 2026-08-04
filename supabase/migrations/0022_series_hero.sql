-- 0022_series_hero.sql — a dedicated banner image for featured series
--
-- The home hero is a WIDE stage; cover_url is a 9:16 poster. Feeding the
-- poster to the banner crops it into soup, so featured series get their own
-- landscape asset, uploaded from the admin Curation page via series-manage
-- (set_hero — same service-role path as covers, same bucket).
--
-- Display falls back hero_url → cover_url, so nothing breaks for series
-- that never get one. `series` uses default table grants (no 0005-style
-- allowlist), so the new column is client-visible without a grant dance.

alter table public.series add column hero_url text;
