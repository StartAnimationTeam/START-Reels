import Link from 'next/link'

import { SeriesCard } from './SeriesCard'
import type { CardSeries } from '@/lib/catalog'

/**
 * A horizontal shelf of poster cards — VideoRail's shape at the series grain,
 * narrower columns because posters are 2:3. Same native scroll-snap, same
 * render-nothing-when-optional contract (pass emptyNote for shelves that
 * should explain their emptiness instead of vanishing — trap #15 applies to
 * content too).
 */
export function SeriesRail({
  title,
  series,
  seeAllHref,
  emptyNote,
}: {
  title: string
  series: CardSeries[]
  seeAllHref?: string
  emptyNote?: string
}) {
  if (series.length === 0 && !emptyNote) return null

  return (
    <section className="mt-8 first:mt-0">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {seeAllHref && series.length > 0 && (
          <Link href={seeAllHref} className="text-sm text-ink-muted transition-colors hover:text-ink">
            See all
          </Link>
        )}
      </div>

      {series.length === 0 ? (
        <p className="text-sm text-ink-muted">{emptyNote}</p>
      ) : (
        <div className="no-scrollbar -mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2 sm:-mx-6 sm:px-6">
          {series.map((s) => (
            <div key={s.id} className="w-32 shrink-0 snap-start sm:w-40">
              <SeriesCard series={s} />
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
