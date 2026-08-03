'use client'

import { useUser } from '@clerk/nextjs'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

import { useSupabase } from '@/lib/supabase-browser'

/**
 * Optimistic favorite toggle — the one write the browser makes directly.
 *
 * It talks straight to Supabase through RLS: `favorites` is the single
 * client-writable table, its WITH CHECK pins user_id to the caller, and no
 * value moves. Optimistic because a heart that lags feels broken; on failure
 * the state snaps back and the truth (the DB) wins.
 */
export function FavoriteButton({
  videoId,
  initiallyFavorited,
  className = '',
}: {
  videoId: string
  initiallyFavorited: boolean
  className?: string
}) {
  const { user } = useUser()
  const supabase = useSupabase()
  const router = useRouter()
  const [favorited, setFavorited] = useState(initiallyFavorited)
  const [, startTransition] = useTransition()

  if (!user || !supabase) return null

  const toggle = async () => {
    const next = !favorited
    setFavorited(next) // optimistic

    const result = next
      ? await supabase.from('favorites').insert({ user_id: user.id, video_id: videoId })
      : await supabase.from('favorites').delete().eq('video_id', videoId).then((r) => r)

    if (result.error) {
      setFavorited(!next) // roll back; the DB is the truth
    } else {
      // My-list pages are Server Components; refresh so they reflect the change.
      startTransition(() => router.refresh())
    }
  }

  return (
    <button
      onClick={() => void toggle()}
      aria-pressed={favorited}
      aria-label={favorited ? 'Remove from My list' : 'Add to My list'}
      title={favorited ? 'Remove from My list' : 'Add to My list'}
      className={`flex h-9 w-9 items-center justify-center rounded-full border transition-colors ${
        favorited
          ? 'border-transparent text-white'
          : 'border-line-strong text-ink-secondary hover:border-brand hover:text-ink'
      } ${className}`}
      style={favorited ? { background: 'var(--brand-gradient)' } : undefined}
    >
      {favorited ? '✓' : '+'}
    </button>
  )
}
