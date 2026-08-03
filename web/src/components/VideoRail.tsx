import Link from 'next/link'

import { VideoCard } from './VideoCard'
import type { Database } from '@/lib/database.types'

type VideoRow = Pick<
  Database['public']['Tables']['videos']['Row'],
  'id' | 'title' | 'access_tier' | 'credit_cost' | 'duration_seconds' | 'thumbnail_url'
>

/**
 * A horizontal rail — the Netflix row. Native scroll with snap points rather
 * than JS-driven carousels: works with touch, trackpads, keyboards and screen
 * readers for free, and there is nothing to break.
 *
 * Renders nothing when empty ON PURPOSE for optional rails (continue
 * watching, recommended): an empty "Continue watching" for a new user is
 * noise. Rails that should always exist (featured, recent) pass emptyNote so
 * a genuinely empty state says so instead of vanishing (CLAUDE.md trap #15
 * applies to content too).
 */
export function VideoRail({
  title,
  videos,
  seeAllHref,
  emptyNote,
}: {
  title: string
  videos: VideoRow[]
  seeAllHref?: string
  emptyNote?: string
}) {
  if (videos.length === 0 && !emptyNote) return null

  return (
    <section className="mt-10 first:mt-0">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {seeAllHref && videos.length > 0 && (
          <Link href={seeAllHref} className="text-sm text-ink-muted transition-colors hover:text-ink">
            See all
          </Link>
        )}
      </div>

      {videos.length === 0 ? (
        <p className="text-sm text-ink-muted">{emptyNote}</p>
      ) : (
        <div className="no-scrollbar -mx-4 flex snap-x snap-mandatory gap-4 overflow-x-auto px-4 pb-2 sm:-mx-6 sm:px-6">
          {videos.map((video) => (
            <div key={video.id} className="w-56 shrink-0 snap-start sm:w-64">
              <VideoCard video={video} />
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
