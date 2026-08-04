'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { useAdminApi } from '@/lib/admin'
import { errorLabel } from '@/lib/labels'

/**
 * The metadata form. ONE Save = one update_series call = one audit row —
 * deliberate, against the SettingsPanel per-field pattern: a series edit is
 * usually several fields at once, and array replacement (categories, tags)
 * only makes sense batched.
 *
 * categoryIds order matters: the server marks index 0 primary.
 */

interface Values {
  title: string
  synopsis: string
  freeEpisodeCount: number
  episodeCreditCost: number
  isMembersOnly: boolean
}

export function SeriesEditor({
  seriesId,
  initial,
  categories,
  tags,
  initialCategoryIds,
  initialTagIds,
}: {
  seriesId: string
  initial: Values
  categories: Array<{ id: string; name: string }>
  tags: Array<{ id: string; name: string }>
  initialCategoryIds: string[] // primary first
  initialTagIds: string[]
}) {
  const api = useAdminApi()
  const router = useRouter()

  const [values, setValues] = useState<Values>(initial)
  const [categoryIds, setCategoryIds] = useState<string[]>(initialCategoryIds)
  const [tagIds, setTagIds] = useState<string[]>(initialTagIds)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const set = <K extends keyof Values>(key: K, value: Values[K]) => {
    setSaved(false)
    setValues((v) => ({ ...v, [key]: value }))
  }

  const toggleCategory = (id: string) => {
    setSaved(false)
    setCategoryIds((ids) =>
      ids.includes(id) ? ids.filter((x) => x !== id) : ids.length < 10 ? [...ids, id] : ids,
    )
  }

  const makePrimary = (id: string) => {
    setSaved(false)
    setCategoryIds((ids) => [id, ...ids.filter((x) => x !== id)])
  }

  const toggleTag = (id: string) => {
    setSaved(false)
    setTagIds((ids) =>
      ids.includes(id) ? ids.filter((x) => x !== id) : ids.length < 12 ? [...ids, id] : ids,
    )
  }

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.series('update_series', {
        seriesId,
        title: values.title.trim(),
        synopsis: values.synopsis,
        freeEpisodeCount: values.freeEpisodeCount,
        episodeCreditCost: values.episodeCreditCost,
        isMembersOnly: values.isMembersOnly,
        categoryIds,
        tagIds,
      })
      setSaved(true)
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown_error')
    } finally {
      setBusy(false)
    }
  }

  const chip = (active: boolean) =>
    `rounded-full border px-2.5 py-1 text-xs transition-colors ${
      active
        ? 'border-transparent text-white'
        : 'border-line-strong text-ink-secondary hover:border-brand hover:text-ink'
    }`

  return (
    <div className="rounded-xl border border-line bg-surface p-5">
      <div className="space-y-4">
        <div>
          <label className="text-sm font-medium text-ink-secondary" htmlFor="se-title">Title</label>
          <input
            id="se-title"
            value={values.title}
            onChange={(e) => set('title', e.target.value)}
            maxLength={200}
            className="mt-1 w-full rounded-lg border border-line-strong bg-surface-muted px-3 py-2 text-sm focus:border-brand focus:outline-none"
          />
        </div>

        <div>
          <label className="text-sm font-medium text-ink-secondary" htmlFor="se-synopsis">
            Synopsis <span className="font-normal text-ink-faint">(shown on the series page and feed)</span>
          </label>
          <textarea
            id="se-synopsis"
            value={values.synopsis}
            onChange={(e) => set('synopsis', e.target.value)}
            rows={4}
            maxLength={5000}
            className="mt-1 w-full rounded-lg border border-line-strong bg-surface-muted px-3 py-2 text-sm focus:border-brand focus:outline-none"
          />
        </div>

        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label className="text-sm font-medium text-ink-secondary" htmlFor="se-free">Free episodes</label>
            <input
              id="se-free"
              type="number"
              min={0}
              max={500}
              value={values.freeEpisodeCount}
              onChange={(e) => set('freeEpisodeCount', Math.max(0, Math.min(500, Number(e.target.value) || 0)))}
              className="mt-1 block w-24 rounded-lg border border-line-strong bg-surface-muted px-3 py-2 text-sm focus:border-brand focus:outline-none"
            />
          </div>
          <div>
            <label className="text-sm font-medium text-ink-secondary" htmlFor="se-cost">Coins per episode</label>
            <input
              id="se-cost"
              type="number"
              min={0}
              max={20}
              value={values.episodeCreditCost}
              onChange={(e) => set('episodeCreditCost', Math.max(0, Math.min(20, Number(e.target.value) || 0)))}
              className="mt-1 block w-24 rounded-lg border border-line-strong bg-surface-muted px-3 py-2 text-sm focus:border-brand focus:outline-none"
            />
          </div>
          <label className="flex items-center gap-2 pb-2 text-sm text-ink-secondary">
            <input
              type="checkbox"
              checked={values.isMembersOnly}
              onChange={(e) => set('isMembersOnly', e.target.checked)}
              className="h-4 w-4 accent-[var(--brand)]"
            />
            Members only <span className="text-xs text-ink-faint">(VIP shelf; unenforced until memberships launch)</span>
          </label>
        </div>

        <div>
          <p className="text-sm font-medium text-ink-secondary">
            Categories <span className="font-normal text-ink-faint">(up to 10 — click ★ to set the primary)</span>
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {categories.map((c) => {
              const active = categoryIds.includes(c.id)
              const primary = categoryIds[0] === c.id
              return (
                <span key={c.id} className="inline-flex items-center">
                  <button
                    onClick={() => toggleCategory(c.id)}
                    className={chip(active)}
                    style={active ? { background: 'var(--brand-gradient)' } : undefined}
                  >
                    {primary ? '★ ' : ''}
                    {c.name}
                  </button>
                  {active && !primary && (
                    <button
                      onClick={() => makePrimary(c.id)}
                      title="Make primary"
                      className="ml-0.5 text-xs text-ink-faint hover:text-ink"
                    >
                      ★
                    </button>
                  )}
                </span>
              )
            })}
          </div>
        </div>

        <div>
          <p className="text-sm font-medium text-ink-secondary">
            Facets <span className="font-normal text-ink-faint">(up to 12 — the chips viewers see: “Secret Baby”, “Revenge”…)</span>
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {tags.map((t) => {
              const active = tagIds.includes(t.id)
              return (
                <button
                  key={t.id}
                  onClick={() => toggleTag(t.id)}
                  className={chip(active)}
                  style={active ? { background: 'var(--brand-gradient)' } : undefined}
                >
                  {t.name}
                </button>
              )
            })}
          </div>
        </div>

        {error && <p className="text-sm" style={{ color: 'var(--danger)' }}>{errorLabel(error)}</p>}

        <div className="flex items-center gap-3">
          <button
            onClick={() => void save()}
            disabled={busy || !values.title.trim()}
            className="rounded-lg px-5 py-2.5 text-sm font-medium text-white shadow-[var(--shadow-brand)] transition-transform enabled:hover:scale-[1.02] disabled:opacity-40"
            style={{ background: 'var(--brand-gradient)' }}
          >
            {busy ? 'Saving…' : saved ? 'Saved ✓' : 'Save changes'}
          </button>
          <span className="text-xs text-ink-muted">
            Pricing changes apply to future unlocks only — spent coins are never rewritten.
          </span>
        </div>
      </div>
    </div>
  )
}
