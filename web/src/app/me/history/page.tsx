import type { Metadata } from 'next'
import Link from 'next/link'

import { requireUser } from '@/lib/auth'
import { createServerSupabase } from '@/lib/supabase-server'
import { durationLabel } from '@/lib/labels'

export const metadata: Metadata = { title: 'Watch history' }

/**
 * Watch history with resume. last_position_seconds is the resume point;
 * total_seconds_watched is validated engagement — different numbers on
 * purpose (seeking moves one, not the other), both maintained server-side by
 * record_heartbeat.
 */
export default async function HistoryPage() {
  await requireUser()
  const supabase = await createServerSupabase()

  const { data } = await supabase
    .from('watch_history')
    .select(
      'video_id, last_position_seconds, total_seconds_watched, watch_count, completed, last_watched_at, videos (id, title, access_tier, credit_cost, duration_seconds, thumbnail_url)',
    )
    .order('last_watched_at', { ascending: false })
    .limit(50)

  const rows = ((data ?? []) as unknown as Array<{
    video_id: string
    last_position_seconds: number
    total_seconds_watched: number
    watch_count: number
    completed: boolean
    last_watched_at: string
    videos: {
      id: string
      title: string
      duration_seconds: number | null
      thumbnail_url: string | null
    } | null
  }>).filter((row) => row.videos)

  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Watch history</h1>

      {rows.length === 0 ? (
        <p className="mt-6 text-sm text-ink-muted">
          Nothing watched yet.{' '}
          <Link href="/browse" className="underline hover:text-ink">
            Browse the library
          </Link>
        </p>
      ) : (
        <ul className="mt-6 space-y-3">
          {rows.map((row) => {
            const video = row.videos!
            const duration = video.duration_seconds ?? 0
            const pct = duration > 0 ? Math.min(100, Math.round((row.last_position_seconds / duration) * 100)) : 0
            return (
              <li key={row.video_id}>
                <Link
                  href={`/watch/${video.id}`}
                  className="flex gap-4 rounded-xl border border-line bg-surface p-3 transition-colors hover:border-line-strong"
                >
                  <div className="relative h-20 w-36 shrink-0 overflow-hidden rounded-lg bg-surface-muted">
                    {video.thumbnail_url && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={video.thumbnail_url} alt="" className="h-full w-full object-cover" />
                    )}
                    {pct > 0 && !row.completed && (
                      <div className="absolute inset-x-0 bottom-0 h-1 bg-black/50">
                        <div className="h-full" style={{ width: `${pct}%`, background: 'var(--brand)' }} />
                      </div>
                    )}
                  </div>
                  <div className="min-w-0 flex-1 py-1">
                    <p className="truncate font-medium text-ink">{video.title}</p>
                    <p className="mt-1 text-xs text-ink-muted">
                      {row.completed
                        ? 'Finished'
                        : `Resume at ${durationLabel(row.last_position_seconds)} of ${durationLabel(duration)}`}
                      {' · '}watched {row.watch_count} {row.watch_count === 1 ? 'time' : 'times'}
                      {' · '}
                      {new Date(row.last_watched_at).toLocaleDateString()}
                    </p>
                  </div>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
