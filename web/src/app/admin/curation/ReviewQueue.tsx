'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { useAdminApi } from '@/lib/admin'
import { durationLabel, episodeLabel, errorLabel } from '@/lib/labels'

/**
 * Creator uploads waiting for a decision — the one job the old Videos table
 * did that nothing else had picked up. Approve publishes (409
 * video_not_ready while still encoding); Reject keeps the row with a reason
 * the creator sees on their dashboard.
 */

interface PendingRow {
  id: string
  title: string
  episode_number: number | null
  seriesTitle: string | null
  duration_seconds: number | null
  created_at: string
}

export function ReviewQueue({ pending }: { pending: PendingRow[] }) {
  const api = useAdminApi()
  const router = useRouter()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<{ id: string; code: string } | null>(null)

  const run = async (id: string, fn: () => Promise<unknown>) => {
    setBusyId(id)
    setError(null)
    try {
      await fn()
      router.refresh()
    } catch (err) {
      setError({ id, code: err instanceof Error ? err.message : 'unknown_error' })
    } finally {
      setBusyId(null)
    }
  }

  const btn =
    'rounded-md border border-line-strong px-2.5 py-1 text-xs text-ink-secondary transition-colors enabled:hover:border-brand enabled:hover:text-ink disabled:opacity-40'

  return (
    <section>
      <h2 className="text-lg font-semibold tracking-tight">
        Review queue {pending.length > 0 && <span className="text-ink-faint">({pending.length})</span>}
      </h2>
      <p className="mt-1 text-sm text-ink-muted">Creator uploads land here after encoding.</p>

      {pending.length === 0 ? (
        <p className="mt-4 rounded-xl border border-line bg-surface p-4 text-sm text-ink-muted">
          Queue’s clear — nothing waiting for review.
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-[var(--border)] rounded-xl border border-line">
          {pending.map((v) => (
            <li key={v.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-ink">
                  {v.episode_number != null && (
                    <span className="mr-1.5 rounded border border-line-strong px-1 py-0.5 text-[10px] tabular-nums text-ink-muted">
                      {episodeLabel(v.episode_number)}
                    </span>
                  )}
                  {v.title}
                </p>
                <p className="mt-0.5 text-xs text-ink-muted">
                  {v.seriesTitle ?? 'Standalone'} · {durationLabel(v.duration_seconds)} ·{' '}
                  {new Date(v.created_at).toLocaleDateString()}
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-1.5">
                <Link
                  href={`/watch/${v.id}`}
                  target="_blank"
                  className="rounded-md border border-line-strong px-2.5 py-1 text-xs text-ink-secondary transition-colors hover:border-brand hover:text-ink"
                >
                  Preview ↗
                </Link>
                <button
                  disabled={busyId === v.id}
                  onClick={() => void run(v.id, () => api.video('publish', v.id))}
                  className="rounded-md px-2.5 py-1 text-xs font-medium text-white disabled:opacity-40"
                  style={{ background: 'var(--brand-gradient)' }}
                >
                  Approve
                </button>
                <button
                  disabled={busyId === v.id}
                  onClick={() =>
                    void run(v.id, () => api.video('reject', v.id, { reason: 'Not approved for the library' }))
                  }
                  className={btn}
                >
                  Reject
                </button>
              </div>

              {error?.id === v.id && (
                <p className="w-full text-xs" style={{ color: 'var(--danger)' }}>{errorLabel(error.code)}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
