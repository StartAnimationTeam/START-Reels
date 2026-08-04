'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { useAdminApi } from '@/lib/admin'
import { episodeLabel, errorLabel } from '@/lib/labels'

/**
 * The ordered Featured list. Position IS the product: #1 renders as the
 * home hero, everything after fills the "Exclusive Originals" shelf in this
 * order. Moves persist by writing BOTH affected ranks (set_featured, audited
 * per write) — which also self-heals the duplicate rank-1s left by the old
 * per-video Feature button era.
 */

interface FeaturedRow {
  id: string
  title: string
  cover_url: string | null
  status: string
  featured_rank: number | null
  total_episodes: number
}

export function FeaturedManager({
  featured,
  candidates,
}: {
  featured: FeaturedRow[]
  candidates: Array<{ id: string; title: string }>
}) {
  const api = useAdminApi()
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pickId, setPickId] = useState('')

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

  const setRank = (seriesId: string, rank: number) =>
    api.series('set_featured', { seriesId, featured: true, rank })

  const move = (index: number, dir: -1 | 1) => {
    const other = index + dir
    if (other < 0 || other >= featured.length) return
    // Persist both positions as clean 1-based ranks.
    void run(async () => {
      await setRank(featured[index].id, other + 1)
      await setRank(featured[other].id, index + 1)
    })
  }

  const add = () => {
    if (!pickId) return
    void run(() => setRank(pickId, featured.length + 1)).then(() => setPickId(''))
  }

  const btn =
    'rounded-md border border-line-strong px-2.5 py-1 text-xs text-ink-secondary transition-colors enabled:hover:border-brand enabled:hover:text-ink disabled:opacity-40'

  return (
    <section>
      <h2 className="text-lg font-semibold tracking-tight">Featured</h2>
      <p className="mt-1 text-sm text-ink-muted">
        #1 is the home hero; the rest fill the “Exclusive Originals” shelf in this order.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <select
          value={pickId}
          onChange={(e) => setPickId(e.target.value)}
          disabled={busy || candidates.length === 0}
          className="w-full max-w-xs rounded-lg border border-line-strong bg-surface-muted px-3 py-2 text-sm focus:border-brand focus:outline-none"
        >
          <option value="">
            {candidates.length ? 'Add a series to Featured…' : 'Every published series is already featured'}
          </option>
          {candidates.map((c) => (
            <option key={c.id} value={c.id}>{c.title}</option>
          ))}
        </select>
        <button
          onClick={add}
          disabled={busy || !pickId}
          className="rounded-lg px-4 py-2 text-sm font-medium text-white shadow-[var(--shadow-brand)] disabled:opacity-40"
          style={{ background: 'var(--brand-gradient)' }}
        >
          Feature
        </button>
      </div>

      {error && <p className="mt-2 text-sm" style={{ color: 'var(--danger)' }}>{errorLabel(error)}</p>}

      {featured.length === 0 ? (
        <p className="mt-4 text-sm text-ink-muted">
          Nothing featured — the home hero falls back to nothing, so pick at least one show.
        </p>
      ) : (
        <ol className="mt-4 divide-y divide-[var(--border)] rounded-xl border border-line">
          {featured.map((s, index) => (
            <li key={s.id} className="flex items-center gap-3 px-4 py-2.5">
              <span
                className={`w-8 shrink-0 text-center text-lg font-bold tabular-nums ${
                  index === 0 ? 'brand-gradient-text' : 'text-ink-faint'
                }`}
              >
                {index + 1}
              </span>
              <span className="block h-12 w-8 shrink-0 overflow-hidden rounded border border-line bg-surface-muted">
                {s.cover_url && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={s.cover_url} alt="" loading="lazy" className="h-full w-full object-cover" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink">{s.title}</p>
                <p className="text-xs text-ink-muted">
                  {index === 0 ? 'Hero · ' : ''}
                  {episodeLabel(s.total_episodes)}
                  {s.status !== 'published' && (
                    <span style={{ color: 'var(--warning)' }}> · not published — viewers can’t see it</span>
                  )}
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-1.5">
                <button disabled={busy || index === 0} onClick={() => move(index, -1)} className={btn} aria-label="Move up">
                  ↑
                </button>
                <button
                  disabled={busy || index === featured.length - 1}
                  onClick={() => move(index, 1)}
                  className={btn}
                  aria-label="Move down"
                >
                  ↓
                </button>
                <button
                  disabled={busy}
                  onClick={() => void run(() => api.series('set_featured', { seriesId: s.id, featured: false }))}
                  className={btn}
                >
                  Unfeature
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
