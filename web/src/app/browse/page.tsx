import type { Metadata } from 'next'
import Link from 'next/link'

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

  const [{ data: videos, error }, { data: categories }] = await Promise.all([
    supabase
      .from('videos')
      .select('id, title, access_tier, credit_cost, duration_seconds, thumbnail_url')
      .eq('status', 'published')
      .is('deleted_at', null)
      .order('published_at', { ascending: false })
      .limit(48),
    supabase
      .from('categories')
      .select('slug, name')
      .eq('is_active', true)
      .order('sort_order', { ascending: true }),
  ])

  return (
    <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Browse</h1>
        <Link
          href="/search"
          className="rounded-lg border border-line-strong px-4 py-2 text-sm text-ink-secondary transition-colors hover:border-brand hover:text-ink"
        >
          Search…
        </Link>
      </div>

      {(categories?.length ?? 0) > 0 && (
        <div className="no-scrollbar mt-4 flex gap-2 overflow-x-auto">
          {categories!.map((category) => (
            <Link
              key={category.slug}
              href={`/category/${category.slug}`}
              className="shrink-0 rounded-full border border-line-strong px-3.5 py-1.5 text-sm text-ink-secondary transition-colors hover:border-brand hover:text-ink"
            >
              {category.name}
            </Link>
          ))}
        </div>
      )}

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
