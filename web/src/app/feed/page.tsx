import type { Metadata } from 'next'

import { SeriesRail } from '@/components/SeriesRail'
import { trendingSeries } from '@/lib/catalog'
import { createAnonSupabase } from '@/lib/supabase-server'

export const metadata: Metadata = { title: 'For You' }

/**
 * PLACEHOLDER — the vertical swipe feed lands in pivot Phase 6. A boundary
 * must say so (trap #15): this page states what's coming and still gives the
 * tab something real to do, rather than rendering a blank that reads as
 * broken.
 */
export default async function FeedPage() {
  const trending = await trendingSeries(createAnonSupabase(), 12)

  return (
    <div className="mx-auto max-w-7xl px-4 pb-24 pt-8 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">For You</h1>
      <p className="mt-2 text-sm text-ink-muted">
        The swipeable feed is almost here. Until it arrives, here’s what everyone’s watching.
      </p>

      <div className="mt-8">
        <SeriesRail title="Most Trending" series={trending} seeAllHref="/?tab=rankings" />
      </div>
    </div>
  )
}
