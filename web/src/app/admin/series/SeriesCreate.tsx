'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { useAdminApi } from '@/lib/admin'
import { errorLabel } from '@/lib/labels'

/**
 * Title-only create. The server generates the slug and defaults the pricing
 * (first 3 episodes free, 1 coin after); everything else — synopsis, cover,
 * categories, facets — is edited on the detail page this lands on.
 */
export function SeriesCreate() {
  const api = useAdminApi()
  const router = useRouter()
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const create = async () => {
    if (!title.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      const { series } = await api.series('create_series', { title: title.trim() })
      if (series?.id) router.push(`/admin/series/${series.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown_error')
      setBusy(false)
    }
  }

  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <p className="text-sm font-medium text-ink-secondary">New series</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void create()}
          placeholder="Series title"
          maxLength={200}
          disabled={busy}
          className="w-full max-w-sm rounded-lg border border-line-strong bg-surface-muted px-3 py-2 text-sm focus:border-brand focus:outline-none"
        />
        <button
          onClick={() => void create()}
          disabled={busy || !title.trim()}
          className="rounded-lg px-5 py-2 text-sm font-medium text-white shadow-[var(--shadow-brand)] transition-transform enabled:hover:scale-[1.02] disabled:opacity-40"
          style={{ background: 'var(--brand-gradient)' }}
        >
          {busy ? 'Creating…' : 'Create'}
        </button>
        <span className="text-xs text-ink-muted">
          Cover, synopsis, pricing and episodes come next, on the series page.
        </span>
      </div>
      {error && (
        <p className="mt-2 text-sm" style={{ color: 'var(--danger)' }}>{errorLabel(error)}</p>
      )}
    </div>
  )
}
