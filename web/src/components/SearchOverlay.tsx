'use client'

import { usePathname } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'

import { SeriesCard } from '@/components/SeriesCard'
import {
  activeCategories,
  allTags,
  searchSeries,
  type CardSeries,
  type SeriesFilters,
} from '@/lib/catalog'
import { useSupabase } from '@/lib/supabase-browser'

/**
 * Search as a TAKEOVER, not a page: the ⌕ icon and the home pill open this
 * full-screen overlay in place — type, filter, tap a result, and the
 * overlay closes as the card navigates. Reads go through the RLS browser
 * client with the same searchSeries/activeCategories/allTags helpers the
 * old route used; only the transport changed.
 *
 * Reset clears the query and every filter in one tap. Escape closes.
 * (/search still exists for deep links; nothing points at it anymore.)
 */

const ACCESS_OPTIONS = [
  { key: 'free', label: 'Free' },
  { key: 'paid', label: 'Paid' },
  { key: 'vip', label: 'Members Only' },
] as const

interface Taxonomy {
  categories: Array<{ id: string; name: string }>
  tags: Array<{ id: string; name: string }>
}

export function SearchOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  const supabase = useSupabase()
  const pathname = usePathname()

  const [q, setQ] = useState('')
  const [cat, setCat] = useState<string | null>(null)
  const [tag, setTag] = useState<string | null>(null)
  const [access, setAccess] = useState<SeriesFilters['access'] | null>(null)
  const [taxonomy, setTaxonomy] = useState<Taxonomy | null>(null)
  const [results, setResults] = useState<CardSeries[] | null>(null)
  const [busy, setBusy] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const anyFilter = Boolean(cat || tag || access)

  // A navigation (tapping a result) must take the overlay with it.
  const openedAt = useRef(pathname)
  useEffect(() => {
    if (open && pathname !== openedAt.current) onClose()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname])
  useEffect(() => {
    if (open) openedAt.current = pathname
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Escape closes; the page behind must not scroll while we're up.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [open, onClose])

  // Taxonomy once per session, on first open.
  useEffect(() => {
    if (!open || !supabase || taxonomy) return
    void Promise.all([activeCategories(supabase), allTags(supabase)]).then(([categories, tags]) =>
      setTaxonomy({ categories, tags }),
    )
  }, [open, supabase, taxonomy])

  // Debounced search — empty query + filters is a browse, same as the old page.
  useEffect(() => {
    if (!open || !supabase) return
    setBusy(true)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      void searchSeries(supabase, q, {
        categoryId: cat ?? undefined,
        tagId: tag ?? undefined,
        access: access ?? undefined,
      }, 30)
        .then(setResults)
        .finally(() => setBusy(false))
    }, 300)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [open, supabase, q, cat, tag, access])

  const reset = () => {
    setQ('')
    setCat(null)
    setTag(null)
    setAccess(null)
  }

  if (!open) return null

  const chip = (active: boolean) =>
    `whitespace-nowrap rounded-full border px-3 py-1 text-xs transition-colors ${
      active
        ? 'border-transparent font-medium text-white'
        : 'border-line text-ink-secondary hover:border-line-strong hover:text-ink'
    }`
  const chipStyle = (active: boolean) => (active ? { background: 'var(--brand-gradient)' } : undefined)

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-background" role="dialog" aria-modal="true" aria-label="Search">
      {/* ── header: input + reset + close ─────────────────────────────── */}
      <div className="mx-auto w-full max-w-7xl px-4 pt-4 sm:px-6">
        <div className="flex items-center gap-2">
          <input
            autoFocus
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search shows — titles and synopses…"
            aria-label="Search series"
            className="min-w-0 flex-1 rounded-lg border border-line-strong bg-surface-muted px-4 py-2.5 text-sm text-ink placeholder:text-ink-faint focus:border-brand focus:outline-none"
          />
          <button
            onClick={reset}
            disabled={!q && !anyFilter}
            className="rounded-lg border border-line-strong px-3.5 py-2.5 text-sm text-ink-secondary transition-colors enabled:hover:border-brand enabled:hover:text-ink disabled:opacity-40"
          >
            Reset
          </button>
          <button
            onClick={onClose}
            aria-label="Close search"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-line-strong text-ink-secondary transition-colors hover:border-brand hover:text-ink"
          >
            ✕
          </button>
        </div>

        {/* ── filter rows ───────────────────────────────────────────────── */}
        <div className="mt-4 space-y-2.5">
          <div className="no-scrollbar -mx-4 flex items-center gap-1.5 overflow-x-auto px-4 sm:-mx-6 sm:px-6">
            <button onClick={() => setCat(null)} className={chip(!cat)} style={chipStyle(!cat)}>All</button>
            {(taxonomy?.categories ?? []).map((c) => (
              <button
                key={c.id}
                onClick={() => setCat(cat === c.id ? null : c.id)}
                className={chip(cat === c.id)}
                style={chipStyle(cat === c.id)}
              >
                {c.name}
              </button>
            ))}
          </div>

          <div className="no-scrollbar -mx-4 flex items-center gap-1.5 overflow-x-auto px-4 sm:-mx-6 sm:px-6">
            <button onClick={() => setAccess(null)} className={chip(!access)} style={chipStyle(!access)}>All</button>
            {ACCESS_OPTIONS.map((o) => (
              <button
                key={o.key}
                onClick={() => setAccess(access === o.key ? null : o.key)}
                className={chip(access === o.key)}
                style={chipStyle(access === o.key)}
              >
                {o.label}
              </button>
            ))}
          </div>

          {(taxonomy?.tags.length ?? 0) > 0 && (
            <div className="no-scrollbar -mx-4 flex items-center gap-1.5 overflow-x-auto px-4 sm:-mx-6 sm:px-6">
              <button onClick={() => setTag(null)} className={chip(!tag)} style={chipStyle(!tag)}>All</button>
              {taxonomy!.tags.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTag(tag === t.id ? null : t.id)}
                  className={chip(tag === t.id)}
                  style={chipStyle(tag === t.id)}
                >
                  {t.name}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── results ──────────────────────────────────────────────────────── */}
      <div
        className="mx-auto mt-4 w-full max-w-7xl flex-1 overflow-y-auto px-4 sm:px-6"
        style={{ paddingBottom: 'calc(2.5rem + var(--safe-bottom))' }}
      >
        {results === null || busy ? (
          <p className="text-sm text-ink-muted">Searching…</p>
        ) : results.length === 0 ? (
          <p className="text-sm text-ink-muted">
            {q
              ? `Nothing matched “${q}”${anyFilter ? ' with these filters' : ''} — try a different word or hit Reset.`
              : 'Nothing here yet — loosen a filter or hit Reset.'}
          </p>
        ) : (
          <>
            <p className="mb-3 text-sm text-ink-muted">
              {q
                ? `${results.length} result${results.length === 1 ? '' : 's'} for “${q}”`
                : anyFilter
                  ? `${results.length} show${results.length === 1 ? '' : 's'} match`
                  : 'Browse everything, newest first'}
            </p>
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 sm:gap-4 lg:grid-cols-6">
              {results.map((s) => (
                <SeriesCard key={s.id} series={s} />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
