import type { Metadata } from 'next'

import { VideoCard } from '@/components/VideoCard'
import { createAnonSupabase } from '@/lib/supabase-server'

export const metadata: Metadata = { title: 'Browse' }

// The public catalog changes when videos publish, not per-request.
export const revalidate = 60

/**
 * Phase 2 slice of browse: the published catalog, newest first. Search,
 * categories, rails and recommendations arrive in Phase 3 — this page exists
 * now so the watch flow is reachable by clicking, not just by URL.
 *
 * Anonymous client on purpose: the catalog is public (it is the top of the
 * signup funnel), and an anonymous read is exactly what the `anon` policy
 * allows — published, not deleted, and no provider_asset_id column at all.
 */
export default async function BrowsePage() {
  const supabase = createAnonSupabase()

  const { data: videos, error } = await supabase
    .from('videos')
    .select('id, title, access_tier, credit_cost, duration_seconds, thumbnail_url')
    .eq('status', 'published')
    .is('deleted_at', null)
    .order('published_at', { ascending: false })
    .limit(48)

  return (
    <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Browse</h1>

      {error ? (
        <p className="mt-6 text-sm text-ink-muted">
          The library isn’t available right now. Try again in a moment.
        </p>
      ) : !videos?.length ? (
        <p className="mt-6 text-sm text-ink-muted">
          Nothing published yet — check back soon.
        </p>
      ) : (
        <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {videos.map((video) => (
            <VideoCard key={video.id} video={video} />
          ))}
        </div>
      )}
    </div>
  )
}
