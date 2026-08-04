'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { useAdminApi } from '@/lib/admin'
import { errorLabel } from '@/lib/labels'
import type { AccessTier, VideoStatus } from '@/lib/database.types'

/**
 * Row actions. Each one round-trips through admin-videos (server-verified,
 * audited) and refreshes the table — the DB is the truth, the table shows it.
 *
 * `remove` confirms in-line rather than with window.confirm: it refunds real
 * credits, and the confirmation names that consequence instead of asking
 * "are you sure?".
 */
export function VideoActions({
  videoId,
  status,
  tier,
  creditCost,
  featured,
}: {
  videoId: string
  status: VideoStatus
  tier: AccessTier
  creditCost: number
  featured: boolean
}) {
  const api = useAdminApi()
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown_error')
    } finally {
      setBusy(false)
      setConfirmingRemove(false)
    }
  }

  const button =
    'rounded-md border border-line-strong px-2.5 py-1 text-xs text-ink-secondary transition-colors enabled:hover:border-brand enabled:hover:text-ink disabled:opacity-40'

  const cycleTier = () => {
    // free -> premium -> exclusive(3) -> free: quick tier editing without a
    // modal. Exact exclusive pricing (2..5) is set at upload; this is triage.
    const next: { tier: AccessTier; cost: number } =
      tier === 'free' ? { tier: 'premium', cost: 1 }
      : tier === 'premium' ? { tier: 'exclusive', cost: 3 }
      : { tier: 'free', cost: 0 }
    return api.video('update_meta', videoId, { accessTier: next.tier, creditCost: next.cost })
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {(status === 'pending_review' || status === 'rejected' || status === 'processing') && (
        <button disabled={busy} className={button} onClick={() => void run(() => api.video('publish', videoId))}>
          Publish
        </button>
      )}
      {status === 'pending_review' && (
        <button
          disabled={busy}
          className={button}
          onClick={() => void run(() => api.video('reject', videoId, { reason: 'Not approved for the library' }))}
        >
          Reject
        </button>
      )}
      {status === 'published' && (
        <>
          <button disabled={busy} className={button} onClick={() => void run(cycleTier)} title={`Currently ${tier} (${creditCost})`}>
            Tier ▸
          </button>
          <button
            disabled={busy}
            className={button}
            onClick={() => void run(() => api.video('set_featured', videoId, { featured: !featured, rank: 1 }))}
          >
            {featured ? 'Unfeature' : 'Feature'}
          </button>
        </>
      )}

      {!confirmingRemove ? (
        <button disabled={busy} className={button} onClick={() => setConfirmingRemove(true)}>
          Delete…
        </button>
      ) : (
        <button
          disabled={busy}
          className="rounded-md px-2.5 py-1 text-xs font-medium text-white"
          style={{ background: 'var(--danger)' }}
          onClick={() => void run(() => api.video('remove', videoId, { reason: 'removed_by_admin' }))}
        >
          Confirm — refunds unlocks
        </button>
      )}

      {error && <span className="text-xs" style={{ color: 'var(--danger)' }}>{errorLabel(error)}</span>}
    </div>
  )
}
