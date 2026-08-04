import type { Metadata } from 'next'
import Link from 'next/link'

import { SearchBox } from './SearchBox'
import { SeriesCard } from '@/components/SeriesCard'
import { activeCategories, allTags, searchSeries, type SeriesFilters } from '@/lib/catalog'
import { createAnonSupabase } from '@/lib/supabase-server'

export const metadata: Metadata = { title: 'Search' }

/**
 * Search + discover. The URL is ALL the state — ?q, ?cat, ?tag, ?access —
 * so every combination is linkable, the back button walks filter history,
 * and the filter chips are plain server-rendered links (the house rule:
 * reads through RLS server components, no client data fetching).
 *
 * An empty query is not an empty page: with or without filters it browses
 * the catalog newest-first, so the search screen doubles as the "show me
 * everything that's…" screen.
 */

const ACCESS_OPTIONS = [
  { key: 'free', label: 'Free' },
  { key: 'paid', label: 'Paid' },
  { key: 'vip', label: 'Members Only' },
] as const

interface Params {
  q?: string
  cat?: string
  tag?: string
  access?: string
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<Params>
}) {
  const params = await searchParams
  const query = (params.q ?? '').trim()
  const anon = createAnonSupabase()

  const filters: SeriesFilters = {
    categoryId: params.cat || undefined,
    tagId: params.tag || undefined,
    access: ACCESS_OPTIONS.some((o) => o.key === params.access)
      ? (params.access as SeriesFilters['access'])
      : undefined,
  }

  const [categories, tags, results] = await Promise.all([
    activeCategories(anon),
    allTags(anon),
    searchSeries(anon, query, filters, 48),
  ])

  // Chip hrefs: flip ONE key, keep the rest. Tapping the active chip clears it.
  const href = (key: keyof Params, value: string | null) => {
    const next = new URLSearchParams()
    const state: Params = { ...params, [key]: value ?? undefined }
    if (state.q?.trim()) next.set('q', state.q.trim())
    if (state.cat) next.set('cat', state.cat)
    if (state.tag) next.set('tag', state.tag)
    if (state.access) next.set('access', state.access)
    const qs = next.toString()
    return qs ? `/search?${qs}` : '/search'
  }

  const chip = (active: boolean) =>
    `whitespace-nowrap rounded-full border px-3 py-1 text-xs transition-colors ${
      active
        ? 'border-transparent font-medium text-white'
        : 'border-line text-ink-secondary hover:border-line-strong hover:text-ink'
    }`
  const chipStyle = (active: boolean) =>
    active ? { background: 'var(--brand-gradient)' } : undefined

  const anyFilter = Boolean(filters.categoryId || filters.tagId || filters.access)

  return (
    <div className="mx-auto max-w-7xl px-4 pb-24 pt-8 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Search</h1>

      <div className="mt-4 max-w-xl">
        <SearchBox initialQuery={query} />
      </div>

      {/* ── filter rows: All | … per dimension, DramaBox-style ─────────── */}
      <div className="mt-5 space-y-2.5">
        <div className="no-scrollbar -mx-4 flex items-center gap-1.5 overflow-x-auto px-4 sm:-mx-6 sm:px-6">
          <Link href={href('cat', null)} className={chip(!filters.categoryId)} style={chipStyle(!filters.categoryId)}>
            All
          </Link>
          {categories.map((c) => (
            <Link
              key={c.id}
              href={href('cat', filters.categoryId === c.id ? null : c.id)}
              className={chip(filters.categoryId === c.id)}
              style={chipStyle(filters.categoryId === c.id)}
            >
              {c.name}
            </Link>
          ))}
        </div>

        <div className="no-scrollbar -mx-4 flex items-center gap-1.5 overflow-x-auto px-4 sm:-mx-6 sm:px-6">
          <Link href={href('access', null)} className={chip(!filters.access)} style={chipStyle(!filters.access)}>
            All
          </Link>
          {ACCESS_OPTIONS.map((o) => (
            <Link
              key={o.key}
              href={href('access', filters.access === o.key ? null : o.key)}
              className={chip(filters.access === o.key)}
              style={chipStyle(filters.access === o.key)}
            >
              {o.label}
            </Link>
          ))}
        </div>

        {tags.length > 0 && (
          <div className="no-scrollbar -mx-4 flex items-center gap-1.5 overflow-x-auto px-4 sm:-mx-6 sm:px-6">
            <Link href={href('tag', null)} className={chip(!filters.tagId)} style={chipStyle(!filters.tagId)}>
              All
            </Link>
            {tags.map((t) => (
              <Link
                key={t.id}
                href={href('tag', filters.tagId === t.id ? null : t.id)}
                className={chip(filters.tagId === t.id)}
                style={chipStyle(filters.tagId === t.id)}
              >
                {t.name}
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* ── results ────────────────────────────────────────────────────── */}
      <p className="mt-6 text-sm text-ink-muted">
        {results.length === 0
          ? query
            ? `Nothing matched “${query}”${anyFilter ? ' with these filters' : ''}. Try a different word or loosen a filter.`
            : 'Nothing here yet — loosen a filter or check back soon.'
          : query
            ? `${results.length} result${results.length === 1 ? '' : 's'} for “${query}”`
            : anyFilter
              ? `${results.length} show${results.length === 1 ? '' : 's'} match`
              : 'Browse everything, newest first'}
      </p>

      {results.length > 0 && (
        <div className="mt-4 grid grid-cols-3 gap-3 sm:grid-cols-4 sm:gap-4 lg:grid-cols-6">
          {results.map((s) => (
            <SeriesCard key={s.id} series={s} />
          ))}
        </div>
      )}
    </div>
  )
}
