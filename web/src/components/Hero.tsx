import Link from 'next/link'

import { durationLabel, tierCostLabel } from '@/lib/labels'
import type { Database } from '@/lib/database.types'

type VideoRow = Pick<
  Database['public']['Tables']['videos']['Row'],
  'id' | 'title' | 'description' | 'access_tier' | 'credit_cost' | 'duration_seconds' | 'thumbnail_url'
>

/** The top featured video, full-bleed. Rank 1 of the featured list. */
export function Hero({ video }: { video: VideoRow }) {
  return (
    <section
      className="relative -mx-4 overflow-hidden sm:-mx-6 sm:rounded-2xl"
      style={
        video.thumbnail_url
          ? {
              backgroundImage:
                `linear-gradient(75deg, rgb(11 7 16 / 0.92) 25%, rgb(11 7 16 / 0.45) 60%, rgb(11 7 16 / 0.25)), url(${video.thumbnail_url})`,
              backgroundSize: 'cover',
              backgroundPosition: 'center',
            }
          : { background: 'var(--surface-brand)' }
      }
    >
      <div className="flex min-h-[320px] flex-col justify-end p-6 sm:min-h-[400px] sm:p-10">
        <p className="text-xs font-medium uppercase tracking-widest" style={{ color: 'var(--accent-pink)' }}>
          Featured
        </p>
        <h1 className="mt-2 max-w-2xl text-3xl font-semibold tracking-tight sm:text-4xl">
          {video.title}
        </h1>
        {video.description && (
          <p className="mt-3 max-w-xl text-sm text-ink-secondary sm:text-base line-clamp-3">
            {video.description}
          </p>
        )}
        <div className="mt-5 flex flex-wrap items-center gap-4">
          <Link
            href={`/watch/${video.id}`}
            className="rounded-lg px-6 py-2.5 text-sm font-medium text-white shadow-[var(--shadow-brand)] transition-transform hover:scale-[1.02]"
            style={{ background: 'var(--brand-gradient)' }}
          >
            ▶ Watch
          </Link>
          <span className="text-sm text-ink-muted">
            {tierCostLabel(video.access_tier, video.credit_cost)}
            {video.duration_seconds ? ` · ${durationLabel(video.duration_seconds)}` : ''}
          </span>
        </div>
      </div>
    </section>
  )
}
