import type { Metadata } from 'next'

import { SeriesRail } from '@/components/SeriesRail'
import { MEMBERSHIP_COMING_SOON } from '@/lib/labels'
import { createAnonSupabase } from '@/lib/supabase-server'
import type { CardSeries } from '@/lib/catalog'

export const metadata: Metadata = { title: 'Member' }

/**
 * PLACEHOLDER — the membership shell (tier cards + benefits) lands in pivot
 * Phase 6, and real payments later still. The boundary says so out loud
 * (trap #15) instead of showing a dead Join button.
 */
export default async function MemberPage() {
  const anon = createAnonSupabase()
  const { data } = await anon
    .from('series')
    .select('id, slug, title, cover_url, free_episode_count, episode_credit_cost, is_members_only, total_episodes')
    .eq('status', 'published')
    .is('deleted_at', null)
    .eq('is_members_only', true)
    .order('published_at', { ascending: false })
    .limit(12)
  const vipShelf = (data ?? []) as CardSeries[]

  return (
    <div className="mx-auto max-w-7xl px-4 pb-24 pt-8 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Membership</h1>
      <p className="mt-2 max-w-xl text-sm text-ink-muted">{MEMBERSHIP_COMING_SOON}</p>

      <div className="mt-8">
        <SeriesRail
          title="Members Only"
          series={vipShelf}
          emptyNote="Members-only shows appear here as they premiere."
        />
      </div>
    </div>
  )
}
