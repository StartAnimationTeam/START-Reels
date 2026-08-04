import type { Metadata } from 'next'
import Link from 'next/link'
import { auth } from '@clerk/nextjs/server'

import { SeriesCard } from '@/components/SeriesCard'
import { continueWatchingSeries, followedSeries } from '@/lib/catalog'
import { episodeProgressLabel } from '@/lib/labels'
import { createServerSupabase } from '@/lib/supabase-server'

export const metadata: Metadata = { title: 'My List' }

/** Following + continue watching, both at the series grain. */
export default async function MyListPage() {
  const { userId } = await auth()

  if (!userId) {
    return (
      <div className="mx-auto max-w-2xl px-4 pb-24 pt-16 text-center sm:px-6">
        <h1 className="text-2xl font-semibold tracking-tight">My List</h1>
        <p className="mt-3 text-sm text-ink-muted">
          Sign in to follow shows and pick up where you left off.
        </p>
        <Link
          href="/sign-up"
          className="mt-6 inline-block rounded-lg px-6 py-2.5 text-sm font-medium text-white shadow-[var(--shadow-brand)]"
          style={{ background: 'var(--brand-gradient)' }}
        >
          Sign up free
        </Link>
      </div>
    )
  }

  const supabase = await createServerSupabase()
  const [following, watching] = await Promise.all([
    followedSeries(supabase),
    continueWatchingSeries(supabase),
  ])

  return (
    <div className="mx-auto max-w-7xl px-4 pb-24 pt-8 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">My List</h1>

      <h2 className="mt-8 text-lg font-semibold tracking-tight">Following</h2>
      {following.length === 0 ? (
        <p className="mt-3 text-sm text-ink-muted">
          Nothing yet — tap “+ My List” on any show to keep it here.
        </p>
      ) : (
        <div className="mt-4 grid grid-cols-3 gap-3 sm:grid-cols-4 sm:gap-4 lg:grid-cols-6">
          {following.map((s) => (
            <SeriesCard key={s.id} series={s} />
          ))}
        </div>
      )}

      {watching.length > 0 && (
        <>
          <h2 className="mt-10 text-lg font-semibold tracking-tight">Continue watching</h2>
          <ul className="mt-4 space-y-3">
            {watching.map(({ series, progress }) => (
              <li key={series.id}>
                <Link
                  href={`/series/${series.slug}`}
                  className="flex items-center gap-4 rounded-xl border border-line bg-surface p-3 transition-colors hover:border-line-strong"
                >
                  <div className="h-20 w-14 shrink-0 overflow-hidden rounded-lg bg-surface-muted">
                    {series.cover_url && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={series.cover_url} alt="" loading="lazy" className="h-full w-full object-cover" />
                    )}
                  </div>
                  <div className="min-w-0">
                    <h3 className="truncate font-medium text-ink">{series.title}</h3>
                    <p className="mt-1 text-xs text-ink-muted">
                      {episodeProgressLabel(progress.last_episode_number, series.total_episodes)}
                    </p>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
