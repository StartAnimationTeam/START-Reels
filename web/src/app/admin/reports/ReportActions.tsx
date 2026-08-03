'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { useAdminApi } from '@/lib/admin'
import { errorLabel } from '@/lib/labels'

/**
 * Acting on a report. "Remove video" chains two audited calls — remove the
 * content (admin-videos, which refunds buyers) then resolve the report naming
 * what was done — so the queue and the catalog can't drift apart.
 */
export function ReportActions({
  reportId,
  uploaderId,
  videoId,
  videoStatus,
}: {
  reportId: string
  uploaderId: string | null
  videoId: string
  videoStatus: string | null
}) {
  const api = useAdminApi()
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [warning, setWarning] = useState(false)
  const [warnReason, setWarnReason] = useState('')

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
    }
  }

  const button =
    'rounded-md border border-line-strong px-2.5 py-1 text-xs text-ink-secondary transition-colors enabled:hover:border-brand enabled:hover:text-ink disabled:opacity-40'

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button disabled={busy} className={button}
        onClick={() => void run(() => api.moderation('dismiss', { reportId, note: 'No action needed' }))}>
        Dismiss
      </button>

      <button disabled={busy} className={button}
        onClick={() => void run(() => api.moderation('resolve', { reportId, actionTaken: 'Reviewed; content is fine' }))}>
        Resolve — content OK
      </button>

      {videoStatus === 'published' && (
        <button
          disabled={busy}
          className="rounded-md px-2.5 py-1 text-xs font-medium text-white disabled:opacity-40"
          style={{ background: 'var(--danger)' }}
          onClick={() =>
            void run(async () => {
              await api.video('remove', videoId, { reason: 'removed_via_report' })
              await api.moderation('resolve', { reportId, actionTaken: 'Video removed; buyers refunded' })
            })
          }
        >
          Remove video (refunds buyers)
        </button>
      )}

      {uploaderId && (!warning ? (
        <button disabled={busy} className={button} onClick={() => setWarning(true)}>
          Warn uploader…
        </button>
      ) : (
        <span className="flex items-center gap-1.5">
          <input
            value={warnReason}
            onChange={(e) => setWarnReason(e.target.value)}
            placeholder="Reason shown to the uploader"
            maxLength={500}
            className="rounded-md border border-line-strong bg-surface-muted px-2 py-1 text-xs focus:border-brand focus:outline-none"
            autoFocus
          />
          <button
            disabled={busy || !warnReason.trim()}
            className={button}
            onClick={() =>
              void run(async () => {
                await api.moderation('warn', {
                  userId: uploaderId, reason: warnReason.trim(), severity: 'warning', reportId,
                })
                await api.moderation('resolve', { reportId, actionTaken: 'Warned the uploader' })
              })
            }
          >
            Send
          </button>
        </span>
      ))}

      {error && <span className="text-xs" style={{ color: 'var(--danger)' }}>{errorLabel(error)}</span>}
    </div>
  )
}
