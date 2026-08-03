import type { Metadata } from 'next'

import { SearchBox } from './SearchBox'
import { VideoCard } from '@/components/VideoCard'
import { searchVideos } from '@/lib/catalog'
import { createAnonSupabase } from '@/lib/supabase-server'

export const metadata: Metadata = { title: 'Search' }

/**
 * Server-rendered search over the ?q= param. The URL is the state: results
 * are linkable, the back button works, and there is no client cache to
 * invalidate. The search box just navigates.
 */
export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>
}) {
  const { q = '' } = await searchParams
  const query = q.trim()

  const results = query ? await searchVideos(createAnonSupabase(), query) : []

  return (
    <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Search</h1>

      <div className="mt-4 max-w-xl">
        <SearchBox initialQuery={query} />
      </div>

      {query && (
        <p className="mt-6 text-sm text-ink-muted">
          {results.length === 0
            ? `Nothing matched “${query}”. Try a different word — search covers titles and descriptions.`
            : `${results.length} result${results.length === 1 ? '' : 's'} for “${query}”`}
        </p>
      )}

      {results.length > 0 && (
        <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {results.map((video) => (
            <VideoCard key={video.id} video={video} />
          ))}
        </div>
      )}
    </div>
  )
}
