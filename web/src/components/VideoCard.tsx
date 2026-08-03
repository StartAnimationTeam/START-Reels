import Link from 'next/link'

import { durationLabel, tierCostLabel } from '@/lib/labels'
import type { Database } from '@/lib/database.types'

type VideoRow = Pick<
  Database['public']['Tables']['videos']['Row'],
  'id' | 'title' | 'access_tier' | 'credit_cost' | 'duration_seconds' | 'thumbnail_url'
>

export function VideoCard({ video }: { video: VideoRow }) {
  const paid = video.access_tier !== 'free'

  return (
    <Link
      href={`/watch/${video.id}`}
      className="group block overflow-hidden rounded-xl border border-line bg-surface transition-all hover:border-line-strong hover:shadow-[var(--shadow-lift)]"
    >
      <div className="relative aspect-video bg-surface-muted">
        {video.thumbnail_url ? (
          // eslint-disable-next-line @next/next/no-img-element -- thumbnails come
          // from the Bunny CDN which already serves scaled variants; next/image
          // would proxy every one through Vercel for no gain.
          <img
            src={video.thumbnail_url}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
          />
        ) : (
          <div
            className="flex h-full w-full items-center justify-center text-ink-faint"
            aria-hidden
          >
            <span className="h-8 w-8 rounded-full opacity-40" style={{ background: 'var(--brand-gradient)' }} />
          </div>
        )}

        {video.duration_seconds != null && (
          <span className="absolute bottom-2 right-2 rounded bg-black/75 px-1.5 py-0.5 text-[11px] tabular-nums text-white">
            {durationLabel(video.duration_seconds)}
          </span>
        )}

        {paid && (
          <span
            className="absolute left-2 top-2 rounded-full px-2 py-0.5 text-[11px] font-medium text-white"
            style={{ background: 'var(--brand-gradient)' }}
          >
            {tierCostLabel(video.access_tier, video.credit_cost)}
          </span>
        )}
      </div>

      <div className="p-3">
        <h3 className="truncate text-sm font-medium text-ink group-hover:text-white">{video.title}</h3>
      </div>
    </Link>
  )
}
