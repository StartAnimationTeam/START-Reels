import type { Metadata } from 'next'
import Link from 'next/link'

import { VideoCard } from '@/components/VideoCard'
import { requireUser } from '@/lib/auth'
import { favoriteVideos } from '@/lib/catalog'
import { createServerSupabase } from '@/lib/supabase-server'

export const metadata: Metadata = { title: 'My list' }

export default async function FavoritesPage() {
  await requireUser()
  const supabase = await createServerSupabase()
  const videos = await favoriteVideos(supabase)

  return (
    <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">My list</h1>

      {videos.length === 0 ? (
        <p className="mt-6 text-sm text-ink-muted">
          Nothing saved yet. Use the <span className="font-medium text-ink">+</span> on any video to
          add it here.{' '}
          <Link href="/browse" className="underline hover:text-ink">
            Browse the library
          </Link>
        </p>
      ) : (
        <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {videos.map((video) => (
            <VideoCard key={video.id} video={video} />
          ))}
        </div>
      )}
    </div>
  )
}
