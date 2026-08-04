import type { Metadata } from 'next'

import { FeaturedManager } from './FeaturedManager'
import { ReviewQueue } from './ReviewQueue'
import { createServerSupabase } from '@/lib/supabase-server'

export const metadata: Metadata = { title: 'Curation' }

/**
 * What the home screen promotes, in one place:
 *
 *   Featured — an ORDERED list of series. Rank #1 is the hero banner; ranks
 *   2+ fill the "Exclusive Originals" shelf. (Featuring individual videos
 *   stopped meaning anything at the pivot — the home page reads series.)
 *
 *   Review queue — creator uploads waiting at pending_review. Approvals
 *   lived on the old Videos table; they moved here with it.
 */
export default async function AdminCurationPage() {
  const supabase = await createServerSupabase()

  const [featuredRes, candidatesRes, pendingRes] = await Promise.all([
    supabase
      .from('series')
      .select('id, title, cover_url, status, featured_rank, total_episodes')
      .eq('is_featured', true)
      .is('deleted_at', null)
      .neq('status', 'removed')
      .order('featured_rank', { ascending: true, nullsFirst: false })
      .order('published_at', { ascending: false }),
    supabase
      .from('series')
      .select('id, title')
      .eq('status', 'published')
      .eq('is_featured', false)
      .is('deleted_at', null)
      .gt('total_episodes', 0)
      .order('published_at', { ascending: false })
      .limit(100),
    supabase
      .from('videos')
      .select('id, title, episode_number, series_id, created_at, duration_seconds')
      .eq('status', 'pending_review')
      .is('deleted_at', null)
      .order('created_at', { ascending: true })
      .limit(100),
  ])

  const pending = pendingRes.data ?? []

  // Series titles for the queue rows, one batched read.
  const seriesIds = [...new Set(pending.map((p) => p.series_id).filter(Boolean))] as string[]
  const { data: seriesRows } = seriesIds.length
    ? await supabase.from('series').select('id, title').in('id', seriesIds)
    : { data: [] as Array<{ id: string; title: string }> }
  const seriesTitles = new Map((seriesRows ?? []).map((s) => [s.id, s.title]))

  return (
    <div className="space-y-10">
      <FeaturedManager
        featured={featuredRes.data ?? []}
        candidates={candidatesRes.data ?? []}
      />
      <ReviewQueue
        pending={pending.map((p) => ({
          ...p,
          seriesTitle: p.series_id ? (seriesTitles.get(p.series_id) ?? null) : null,
        }))}
      />
    </div>
  )
}
