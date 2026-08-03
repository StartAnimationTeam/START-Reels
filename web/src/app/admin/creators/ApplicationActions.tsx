'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { useAdminApi } from '@/lib/admin'
import { errorLabel } from '@/lib/labels'

export function ApplicationActions({ applicationId }: { applicationId: string }) {
  const api = useAdminApi()
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [rejecting, setRejecting] = useState(false)
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)

  const decide = async (approve: boolean) => {
    setBusy(true)
    setError(null)
    try {
      await api.user('decide_application', 'user_ignored', {
        applicationId,
        approve,
        note: note.trim() || undefined,
      })
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown_error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        disabled={busy}
        onClick={() => void decide(true)}
        className="rounded-lg px-4 py-1.5 text-sm font-medium text-white disabled:opacity-40"
        style={{ background: 'var(--brand-gradient)' }}
      >
        Approve
      </button>

      {!rejecting ? (
        <button
          disabled={busy}
          onClick={() => setRejecting(true)}
          className="rounded-lg border border-line-strong px-4 py-1.5 text-sm text-ink-secondary hover:border-brand hover:text-ink disabled:opacity-40"
        >
          Reject…
        </button>
      ) : (
        <span className="flex flex-wrap items-center gap-2">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Reason shown to the applicant"
            maxLength={500}
            className="rounded-lg border border-line-strong bg-surface-muted px-3 py-1.5 text-sm focus:border-brand focus:outline-none"
            autoFocus
          />
          <button
            disabled={busy}
            onClick={() => void decide(false)}
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
            style={{ background: 'var(--danger)' }}
          >
            Reject
          </button>
        </span>
      )}

      {error && <span className="text-xs" style={{ color: 'var(--danger)' }}>{errorLabel(error)}</span>}
    </div>
  )
}
