'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { SchedulePicker } from '@/components/SchedulePicker'
import { useAdminApi } from '@/lib/admin'
import { comingSoonLabel, errorLabel } from '@/lib/labels'

/**
 * Lifecycle buttons. Publish is refused (409 series_not_ready) until at
 * least one episode has encoded and published — the button stays enabled so
 * a retry after the webhook lands just works. Remove is ADMIN-only, hidden
 * (not disabled) for moderators per the admin/users precedent, and runs the
 * revoke-and-refund path — hence the two-click confirm that says so.
 *
 * Schedule sets a release timer on a draft: the series appears in the
 * public Coming Soon shelf immediately, and the minutely publisher flips it
 * live at the chosen time (if an episode is ready). Manual Publish always
 * wins and clears any timer.
 */
export function SeriesActions({
  seriesId,
  title,
  status,
  isFeatured,
  viewerIsAdmin,
  scheduledPublishAt,
}: {
  seriesId: string
  title: string
  status: string
  isFeatured: boolean
  viewerIsAdmin: boolean
  scheduledPublishAt: string | null
}) {
  const api = useAdminApi()
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)

  const run = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      setConfirmRemove(false)
      router.refresh()
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown_error')
      return false
    } finally {
      setBusy(false)
    }
  }

  const btn =
    'rounded-md border border-line-strong px-2.5 py-1 text-xs text-ink-secondary transition-colors enabled:hover:border-brand enabled:hover:text-ink disabled:opacity-40'

  return (
    <div className="flex flex-col items-end gap-2">
      {status !== 'published' && status !== 'removed' && scheduledPublishAt && (
        new Date(scheduledPublishAt).getTime() <= Date.now() ? (
          // The timer fired but the publisher held: it never releases a
          // series with zero watchable episodes. Say so, or this reads as
          // "the timer is broken" (trap #15).
          <p className="max-w-md text-right text-xs" style={{ color: 'var(--warning)' }}>
            ⏱ Premiere time passed — waiting for the first episode to finish
            encoding. It publishes within a minute of one being ready, or press
            Publish now once episodes appear below.
          </p>
        ) : (
          <p className="text-xs" style={{ color: 'var(--warning)' }}>
            ⏱ {comingSoonLabel(scheduledPublishAt)} — live in Coming Soon
          </p>
        )
      )}

      <div className="flex flex-wrap items-center justify-end gap-2">
        {status !== 'published' && status !== 'removed' && (
          <button
            disabled={busy}
            onClick={() => void run(() => api.series('publish_series', { seriesId }))}
            className="rounded-md px-3 py-1 text-xs font-medium text-white shadow-[var(--shadow-brand)] disabled:opacity-40"
            style={{ background: 'var(--brand-gradient)' }}
          >
            Publish now
          </button>
        )}

        {status !== 'published' && status !== 'removed' && (
          <>
            <button disabled={busy} onClick={() => setPickerOpen(true)} className={btn}>
              {scheduledPublishAt ? 'Reschedule…' : 'Publish later…'}
            </button>
            {scheduledPublishAt && (
              <button
                disabled={busy}
                onClick={() =>
                  void run(() => api.series('update_series', { seriesId, scheduledPublishAt: null }))
                }
                className={btn}
              >
                Clear timer
              </button>
            )}
          </>
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

      <SchedulePicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        busy={busy}
        title={title}
        onConfirm={(when) =>
          void run(() =>
            api.series('update_series', { seriesId, scheduledPublishAt: when.toISOString() }),
          ).then((ok) => ok && setPickerOpen(false))
        }
      />
    </div>
  )
}
