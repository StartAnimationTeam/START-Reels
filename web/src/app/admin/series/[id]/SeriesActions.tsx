'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { useAdminApi } from '@/lib/admin'
import { errorLabel } from '@/lib/labels'

/**
 * Lifecycle buttons. Publish is refused (409 series_not_ready) until at
 * least one episode has encoded and published — the button stays enabled so
 * a retry after the webhook lands just works. Remove is ADMIN-only, hidden
 * (not disabled) for moderators per the admin/users precedent, and runs the
 * revoke-and-refund path — hence the two-click confirm that says so.
 */
export function SeriesActions({
  seriesId,
  status,
  isFeatured,
  viewerIsAdmin,
}: {
  seriesId: string
  status: string
  isFeatured: boolean
  viewerIsAdmin: boolean
}) {
  const api = useAdminApi()
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      setConfirmRemove(false)
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown_error')
    } finally {
      setBusy(false)
    }
  }

  const btn =
    'rounded-md border border-line-strong px-2.5 py-1 text-xs text-ink-secondary transition-colors enabled:hover:border-brand enabled:hover:text-ink disabled:opacity-40'

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {status !== 'published' && status !== 'removed' && (
          <button
            disabled={busy}
            onClick={() => void run(() => api.series('publish_series', { seriesId }))}
            className="rounded-md px-3 py-1 text-xs font-medium text-white shadow-[var(--shadow-brand)] disabled:opacity-40"
            style={{ background: 'var(--brand-gradient)' }}
          >
            Publish series
          </button>
        )}

        {status === 'published' && (
          <button
            disabled={busy}
            onClick={() =>
              void run(() => api.series('set_featured', { seriesId, featured: !isFeatured, rank: 1 }))
            }
            className={btn}
          >
            {isFeatured ? 'Unfeature' : 'Feature'}
          </button>
        )}

        {viewerIsAdmin && status !== 'removed' && (
          confirmRemove ? (
            <button
              disabled={busy}
              onClick={() =>
                void run(() => api.series('remove_series', { seriesId, reason: 'removed_by_admin' }))
              }
              className="rounded-md px-2.5 py-1 text-xs font-medium text-white disabled:opacity-40"
              style={{ background: 'var(--danger)' }}
            >
              Confirm — refunds unlocks
            </button>
          ) : (
            <button disabled={busy} onClick={() => setConfirmRemove(true)} className={btn}>
              Remove…
            </button>
          )
        )}
      </div>

      {error && <p className="text-sm" style={{ color: 'var(--danger)' }}>{errorLabel(error)}</p>}
    </div>
  )
}
