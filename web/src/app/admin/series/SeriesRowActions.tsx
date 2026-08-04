'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { useAdminApi } from '@/lib/admin'
import { errorLabel } from '@/lib/labels'

/**
 * The list row's Delete — same audited remove_series the detail page runs:
 * revoke-and-refund every live episode, then soft-delete the lot. Rendered
 * only for administrators (the function 403s anyone else regardless).
 */
export function SeriesRowActions({ seriesId }: { seriesId: string }) {
  const api = useAdminApi()
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const remove = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.series('remove_series', { seriesId, reason: 'removed_by_admin' })
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown_error')
      setBusy(false)
      setConfirming(false)
    }
  }

  return (
    <div className="flex items-center justify-end gap-1.5">
      {confirming ? (
        <>
          <button
            disabled={busy}
            onClick={() => void remove()}
            className="rounded-md px-2.5 py-1 text-xs font-medium text-white disabled:opacity-40"
            style={{ background: 'var(--danger)' }}
          >
            {busy ? 'Deleting…' : 'Confirm — refunds unlocks'}
          </button>
          <button
            disabled={busy}
            onClick={() => setConfirming(false)}
            className="rounded-md border border-line-strong px-2.5 py-1 text-xs text-ink-secondary enabled:hover:text-ink disabled:opacity-40"
          >
            Keep
          </button>
        </>
      ) : (
        <button
          disabled={busy}
          onClick={() => setConfirming(true)}
          className="rounded-md border border-line-strong px-2.5 py-1 text-xs text-ink-secondary transition-colors enabled:hover:border-[var(--danger)] enabled:hover:text-[var(--danger)] disabled:opacity-40"
        >
          Delete…
        </button>
      )}
      {error && <span className="text-xs" style={{ color: 'var(--danger)' }}>{errorLabel(error)}</span>}
    </div>
  )
}
