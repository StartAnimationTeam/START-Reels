'use client'

import { useUser } from '@clerk/nextjs'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

import { useSupabase } from '@/lib/supabase-browser'

/**
 * Optimistic series follow — FavoriteButton's contract at the series grain.
 * series_follows is client-writable the same way favorites is: WITH CHECK
 * pins user_id to the caller and no value moves. Optimistic because a
 * Following pill that lags feels broken; on failure the state snaps back and
 * the DB wins.
 */
export function FollowButton({
  seriesId,
  initiallyFollowed,
  className = '',
}: {
  seriesId: string
  initiallyFollowed: boolean
  className?: string
}) {
  const { user } = useUser()
  const supabase = useSupabase()
  const router = useRouter()
  const [followed, setFollowed] = useState(initiallyFollowed)
  const [, startTransition] = useTransition()

  if (!user || !supabase) return null

  const toggle = async () => {
    const next = !followed
    setFollowed(next) // optimistic

    const result = next
      ? await supabase.from('series_follows').insert({ user_id: user.id, series_id: seriesId })
      : await supabase.from('series_follows').delete().eq('series_id', seriesId).then((r) => r)

    if (result.error) {
      setFollowed(!next) // roll back; the DB is the truth
    } else {
      startTransition(() => router.refresh())
    }
  }

  return (
    <button
      onClick={() => void toggle()}
      aria-pressed={followed}
      className={`rounded-lg border px-4 py-2 text-sm font-medium transition-colors ${
        followed
          ? 'border-transparent text-white'
          : 'border-line-strong text-ink-secondary hover:border-brand hover:text-ink'
      } ${className}`}
      style={followed ? { background: 'var(--brand-gradient)' } : undefined}
    >
      {followed ? '✓ Following' : '+ My List'}
    </button>
  )
}
