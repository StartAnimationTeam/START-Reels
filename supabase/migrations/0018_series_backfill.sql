-- 0018_series_backfill.sql — every existing video becomes a 1-episode series
--
-- Series-first means ONE content model: after this migration no published
-- video is series-less. Pricing maps so that 0019's series-based unlock
-- resolves to exactly what each video costs today:
--
--   free video        → free_episode_count 1, cost 1  (ep 1 <= 1 → free)
--   premium/exclusive → free_episode_count 0, cost = old credit_cost
--
-- Idempotent: guarded on series_id IS NULL, so a retried apply (db-apply.mjs
-- replays a failed line) cannot double-create series. Slugs copy over as-is —
-- different table, no collision, and existing catalog URLs keep meaning.

do $$
declare
  v      record;
  v_sid  uuid;
begin
  for v in
    select * from public.videos
    where series_id is null
    order by created_at
  loop
    insert into public.series
      (slug, title, synopsis, cover_url, creator_id, status,
       free_episode_count, episode_credit_cost, published_at, created_at)
    values
      (v.slug,
       v.title,
       v.description,
       v.thumbnail_url,   -- 16:9 placeholder until a portrait cover is set
       v.creator_id,
       case
         when v.status = 'published' then 'published'::public.series_status
         when v.status = 'removed'   then 'removed'::public.series_status
         else 'draft'::public.series_status
       end,
       case when v.access_tier = 'free' then 1 else 0 end,
       greatest(v.credit_cost, 1),
       v.published_at,
       v.created_at)
    returning id into v_sid;

    update public.videos
    set series_id = v_sid, episode_number = 1
    where id = v.id;

    -- Carry the video's categories up to its series.
    insert into public.series_categories (series_id, category_id, is_primary)
    select v_sid, vc.category_id, vc.is_primary
    from public.video_categories vc
    where vc.video_id = v.id
    on conflict (series_id, category_id) do nothing;
  end loop;
end;
$$;

-- Favorites become series follows. Original favorites rows stay — they are
-- history, and the watch UI no longer reads them.
insert into public.series_follows (user_id, series_id, created_at)
select f.user_id, vv.series_id, f.created_at
from public.favorites f
join public.videos vv on vv.id = f.video_id
where vv.series_id is not null
on conflict (user_id, series_id) do nothing;
