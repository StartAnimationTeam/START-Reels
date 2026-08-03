import { auth } from '@clerk/nextjs/server'

import { Hero } from '@/components/Hero'
import { VideoRail } from '@/components/VideoRail'
import {
  activeCategories,
  continueWatching,
  featuredVideos,
  recentVideos,
  recommendedVideos,
  videosInCategory,
} from '@/lib/catalog'
import { createAnonSupabase, createServerSupabase } from '@/lib/supabase-server'

/**
 * The home page: hero + rails. Netflix-shaped, deliberately.
 *
 * Two clients, on purpose: the PUBLIC rails (featured, recent, categories)
 * read through the anon client so the logged-out page — the top of the
 * signup funnel — is identical work; the PERSONAL rails (continue watching,
 * recommended) read as the signed-in user through RLS and simply don't exist
 * otherwise.
 */
export default async function HomePage() {
  const { userId } = await auth()
  const anon = createAnonSupabase()

  const [featured, recent, categories, trendingRes] = await Promise.all([
    featuredVideos(anon),
    recentVideos(anon),
    activeCategories(anon),
    // Trending is the hourly-refreshed materialized view — public catalog
    // data only, so the anon client reads it like any rail.
    anon
      .from('mv_trending_videos')
      .select('id, title, access_tier, credit_cost, duration_seconds, thumbnail_url')
      .order('trend_score', { ascending: false })
      .limit(12),
  ])
  const trendingRail = trendingRes.data ?? []

  let continueRail: Awaited<ReturnType<typeof continueWatching>> = []
  let recommendedRail: Awaited<ReturnType<typeof recommendedVideos>> = []
  if (userId) {
    const supabase = await createServerSupabase()
    ;[continueRail, recommendedRail] = await Promise.all([
      continueWatching(supabase),
      recommendedVideos(supabase),
    ])
  }

  // One rail per category, resolved in parallel; empty categories drop out.
  const categoryRails = (
    await Promise.all(
      categories.slice(0, 4).map(async (category) => ({
        category,
        videos: await videosInCategory(anon, category.id),
      })),
    )
  ).filter((rail) => rail.videos.length > 0)

  const hero = featured[0]
  const featuredRest = featured.slice(1)

  return (
    <div className="mx-auto max-w-7xl px-4 pb-16 pt-6 sm:px-6">
      {hero && <Hero video={hero} />}

      <div className="mt-10">
        <VideoRail title="Continue watching" videos={continueRail} />
        <VideoRail title="Trending" videos={trendingRail} />
        <VideoRail title="Recommended for you" videos={recommendedRail} />
        <VideoRail title="Featured" videos={featuredRest} />
        <VideoRail
          title="Recently added"
          videos={recent}
          seeAllHref="/browse"
          emptyNote="Nothing published yet — check back soon."
        />
        {categoryRails.map(({ category, videos }) => (
          <VideoRail
            key={category.id}
            title={category.name}
            videos={videos}
            seeAllHref={`/category/${category.slug}`}
          />
        ))}
      </div>
    </div>
  )
}
