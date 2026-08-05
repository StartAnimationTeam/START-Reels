import Link from 'next/link'

import { creditLabel, episodeLabel, viewsLabel } from '@/lib/labels'
import type { CardSeries } from '@/lib/catalog'

/**
 * The 9:16 poster card — the browse atom since the pivot. Everything the
 * DramaBox grid communicates lives on the poster: VIP or coin badge top-right,
 * episode count bottom-left, title beneath.
 */
export function SeriesCard({ series }: { series: CardSeries }) {
  const paid = series.episode_credit_cost > 0 && series.free_episode_count === 0

  return (
    <Link
      href={`/series/${series.slug}`}
      className="group block overflow-hidden rounded-xl transition-transform hover:scale-[1.02]"
    >
      <div className="relative aspect-[2/3] overflow-hidden rounded-xl border border-line bg-surface-muted">
        {series.cover_url ? (
          // eslint-disable-next-line @next/next/no-img-element -- covers come
          // from public storage/CDN; next/image would proxy each through
          // Vercel for no gain.
          <img
            src={series.cover_url}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.04]"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-ink-faint" aria-hidden>
            <span className="h-8 w-8 rounded-full opacity-40" style={{ background: 'var(--brand-gradient)' }} />
          </div>
        )}

        {series.is_members_only ? (
          <span className="absolute right-2 top-2 rounded bg-amber-300/90 px-1.5 py-0.5 text-[11px] font-semibold text-black">
            Members Only
          </span>
        ) : paid ? (
          <span
            className="absolute right-2 top-2 rounded px-1.5 py-0.5 text-[11px] font-medium text-white"
            style={{ background: 'var(--brand-gradient)' }}
          >
            {creditLabel(series.episode_credit_cost)}/ep
          </span>
        ) : null}

        {series.total_episodes > 0 && (
          <span className="absolute bottom-2 left-2 rounded bg-black/75 px-1.5 py-0.5 text-[11px] tabular-nums text-white">
            {episodeLabel(series.total_episodes)}
          </span>
        )}

        {/* the social-proof badge: plays counted at session start, never
            page loads */}
        {series.view_count > 0 && (
          <span className="absolute bottom-2 right-2 flex items-center gap-1 rounded bg-black/75 px-1.5 py-0.5 text-[11px] tabular-nums text-white">
            <span aria-hidden>▶</span>
            {viewsLabel(series.view_count)}
          </span>
        )}
      </div>

      <h3 className="mt-2 line-clamp-2 text-sm font-medium leading-snug text-ink group-hover:text-white">
        {series.title}
      </h3>
    </Link>
  )
}
