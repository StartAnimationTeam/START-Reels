import type { Metadata } from 'next'
import { auth } from '@clerk/nextjs/server'

import { FeedPlayer, type FeedSlide } from './FeedPlayer'
import { recommendedSeries, trendingSeries, newSeries, type CardSeries } from '@/lib/catalog'
import { createAnonSupabase, createServerSupabase } from '@/lib/supabase-server'

export const metadata: Metadata = { title: 'For You' }
export const revalidate = 0 // slides depend on the viewer

/**
 * For You: the recommender picks the shows (trending for anonymous viewers,
 * cold-starting to newest), the client swipes their EP.1s. All slide facts —
 * entitlement, free window, facets — are proved here through RLS; the
 * client's mint calls re-prove them server-side.
 */
export default async function FeedPage() {
  const { userId } = await auth()
  const anon = createAnonSupabase()
  const supabase = userId ? await createServerSupabase() : anon

  let shows: CardSeries[] = userId
    ? await recommendedSeries(supabase, 12)
    : await trendingSeries(anon, 12)
  if (!shows.length) shows = await trendingSeries(anon, 12)
  if (!shows.length) shows = await newSeries(anon, 12)
  // The recommender can surface a series whose last episode was just
  // deleted; an empty show can't be a slide.
  shows = shows.filter((s) => s.total_episodes > 0)

  if (!shows.length) {
    return <FeedPlayer slides={[]} signedIn={Boolean(userId)} userId={userId} />
  }

  const showIds = shows.map((s) => s.id)

  // EP.1 rows, facets and (signed-in) entitlements — three batched reads,
  // not one per slide.
  const [{ data: firstEpisodes }, { data: tagRows }] = await Promise.all([
    supabase
      .from('videos')
      .select('id, series_id, thumbnail_url, episode_number, like_count')
      .in('series_id', showIds)
      .eq('episode_number', 1)
      .eq('status', 'published')
      .is('deleted_at', null),
    supabase.from('series_tags').select('series_id, tags (name)').in('series_id', showIds),
  ])

  const ep1BySeries = new Map(
    (firstEpisodes ?? []).map((e) => [e.series_id as string, e]),
  )

  const facetsBySeries = new Map<string, string[]>()
  for (const row of (tagRows ?? []) as unknown as Array<{ series_id: string; tags: { name: string } | null }>) {
    if (!row.tags) continue
    const list = facetsBySeries.get(row.series_id) ?? []
    list.push(row.tags.name)
    facetsBySeries.set(row.series_id, list)
  }

  let unlockedIds = new Set<string>()
  let likedIds = new Set<string>()
  let followedIds = new Set<string>()
  let isMember = false
  if (userId && ep1BySeries.size) {
    const ep1Ids = [...ep1BySeries.values()].map((e) => e.id)
    const [{ data: ents }, { data: myLikes }, { data: myFollows }, { data: membership }] = await Promise.all([
      supabase
        .from('video_entitlements')
        .select('video_id')
        .in('video_id', ep1Ids)
        .gt('expires_at', new Date().toISOString())
        .is('revoked_at', null),
      supabase.from('episode_likes').select('video_id').in('video_id', ep1Ids),
      supabase.from('series_follows').select('series_id').in('series_id', showIds),
      supabase.from('memberships').select('expires_at').maybeSingle(),
    ])
    unlockedIds = new Set((ents ?? []).map((e) => e.video_id))
    likedIds = new Set((myLikes ?? []).map((l) => l.video_id))
    followedIds = new Set((myFollows ?? []).map((f) => f.series_id))
    isMember = Boolean(membership && Date.parse(membership.expires_at) > Date.now())
  }

  // Fetch synopses in one read (CardSeries doesn't carry them).
  const { data: synopses } = await supabase
    .from('series')
    .select('id, synopsis')
    .in('id', showIds)
  const synopsisById = new Map((synopses ?? []).map((s) => [s.id, s.synopsis]))

  const slides: FeedSlide[] = shows
    .map((show) => {
      const ep1 = ep1BySeries.get(show.id)
      return {
        seriesId: show.id,
        seriesSlug: show.slug,
        seriesTitle: show.title,
        synopsis: synopsisById.get(show.id) ?? null,
        facets: facetsBySeries.get(show.id) ?? [],
        totalEpisodes: show.total_episodes,
        videoId: ep1?.id ?? null,
        thumbnailUrl: ep1?.thumbnail_url ?? null,
        coverUrl: show.cover_url,
        // Members ride every premiere free (0028) — the DB re-proves it.
        open: Boolean(ep1) && (isMember || show.free_episode_count >= 1 || unlockedIds.has(ep1!.id)),
        likeCount: Number(ep1?.like_count ?? 0),
        liked: ep1 ? likedIds.has(ep1.id) : false,
        followed: followedIds.has(show.id),
      }
    })
    // A series with no playable EP.1 can't be a slide.
    .filter((slide) => slide.videoId !== null || slide.coverUrl !== null)

  return <FeedPlayer slides={slides} signedIn={Boolean(userId)} userId={userId} />
}
