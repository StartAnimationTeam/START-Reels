import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { auth } from '@clerk/nextjs/server'

import { EpisodeGrid } from '@/components/EpisodeGrid'
import { FollowButton } from '@/components/FollowButton'
import {
  isFollowed,
  seriesBySlug,
  seriesEpisodes,
  seriesFacets,
  type SeriesProgressRow,
} from '@/lib/catalog'
import { comingSoonLabel, episodeLabel, seriesPricingLabel } from '@/lib/labels'
import { createAnonSupabase, createServerSupabase } from '@/lib/supabase-server'

/**
 * The series page: cover, synopsis, facet chips, follow, the episode grid,
 * and one obvious continue/start button. Lock badges are display; the real
 * gate is unlock_video behind /watch.
 */

export const revalidate = 0 // entitlement + progress are per-viewer

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> {
  const { slug } = await params
  const series = await seriesBySlug(createAnonSupabase(), slug)
  return {
    title: series?.title ?? 'Series',
    description: series?.synopsis ?? undefined,
  }
}

export default async function SeriesPage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  const { userId } = await auth()

  // The series + episodes read as the VIEWER: a signed-in creator sees their
  // own draft through RLS; anon sees published only.
  const supabase = userId ? await createServerSupabase() : createAnonSupabase()

  const series = await seriesBySlug(supabase, slug)
  if (!series) notFound()

  const [episodes, facets] = await Promise.all([
    seriesEpisodes(supabase, series.id),
    seriesFacets(supabase, series.id),
  ])

  let unlockedIds = new Set<string>()
  let progress: SeriesProgressRow | null = null
  let followed = false
  if (userId && episodes.length) {
    const now = new Date().toISOString()
    const [entRes, progRes, followedRes] = await Promise.all([
      supabase
        .from('video_entitlements')
        .select('video_id, expires_at, revoked_at')
        .in('video_id', episodes.map((e) => e.id))
        .gt('expires_at', now)
        .is('revoked_at', null),
      supabase
        .from('series_progress')
        .select('series_id, last_episode_number, last_position_seconds, last_episode_completed, last_watched_at')
        .eq('series_id', series.id)
        .maybeSingle(),
      isFollowed(supabase, series.id),
    ])
    unlockedIds = new Set((entRes.data ?? []).map((e) => e.video_id))
    progress = (progRes.data ?? null) as SeriesProgressRow | null
    followed = followedRes
  }

  // Continue at the furthest episode; a finished furthest episode advances
  // to the next one; nothing watched starts at EP.1.
  const nextByProgress = progress
    ? progress.last_episode_completed
      ? (episodes.find((e) => (e.episode_number ?? 0) > progress!.last_episode_number) ??
         episodes.find((e) => e.episode_number === progress!.last_episode_number))
      : episodes.find((e) => e.episode_number === progress!.last_episode_number)
    : episodes[0]
  const continueLabel = progress
    ? `Continue ${episodeLabel(nextByProgress?.episode_number ?? 1)}`
    : `Watch ${episodeLabel(1)}`

  return (
    <div className="mx-auto max-w-4xl px-4 pb-24 sm:px-6">
      {/* ── header: cover + facts ─────────────────────────────────────── */}
      <div className="relative -mx-4 sm:mx-0 sm:mt-6 sm:rounded-2xl sm:border sm:border-line sm:bg-surface">
        <div className="flex gap-5 p-4 sm:p-6">
          <div className="w-32 shrink-0 overflow-hidden rounded-xl border border-line bg-surface-muted sm:w-44">
            <div className="aspect-[2/3]">
              {series.cover_url && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={series.cover_url} alt="" className="h-full w-full object-cover" />
              )}
            </div>
          </div>

          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{series.title}</h1>

            <p className="mt-2 text-sm text-ink-muted">
              {episodeLabel(series.total_episodes)} ·{' '}
              {seriesPricingLabel(series.free_episode_count, series.episode_credit_cost)}
              {series.is_members_only && (
                <span className="ml-2 rounded bg-amber-300/90 px-1.5 py-0.5 text-[11px] font-semibold text-black">
                  Members Only
                </span>
              )}
            </p>

            {facets.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {facets.map((facet) => (
                  <span
                    key={facet.id}
                    className="rounded-full border border-line bg-surface-muted px-2.5 py-0.5 text-xs text-ink-secondary"
                  >
                    {facet.name}
                  </span>
                ))}
              </div>
            )}

            {series.synopsis && (
              <p className="mt-3 hidden text-sm leading-relaxed text-ink-secondary sm:block sm:line-clamp-4">
                {series.synopsis}
              </p>
            )}
          </div>
        </div>

        {series.synopsis && (
          <p className="px-4 pb-4 text-sm leading-relaxed text-ink-secondary sm:hidden">{series.synopsis}</p>
        )}
      </div>

      {/* ── coming soon ───────────────────────────────────────────────── */}
      {series.status === 'draft' && series.scheduled_publish_at && (
        <p
          className="mt-5 rounded-xl border px-4 py-3 text-sm font-medium"
          style={{ borderColor: 'var(--accent-pink)', color: 'var(--accent-pink)' }}
        >
          ⏱ {comingSoonLabel(series.scheduled_publish_at)} — follow it and it lands in My List the
          moment it drops.
        </p>
      )}

      {/* ── actions ───────────────────────────────────────────────────── */}
      <div className="mt-5 flex items-center gap-3">
        {nextByProgress && (
          <Link
            href={`/watch/${nextByProgress.id}`}
            className="flex-1 rounded-lg px-6 py-3 text-center text-sm font-semibold text-white shadow-[var(--shadow-brand)] transition-transform hover:scale-[1.01] sm:flex-none sm:px-10"
            style={{ background: 'var(--brand-gradient)' }}
          >
            ▶ {continueLabel}
          </Link>
        )}
        <FollowButton seriesId={series.id} initiallyFollowed={followed} />
      </div>

      {/* ── episodes ──────────────────────────────────────────────────── */}
      <h2 className="mt-8 text-lg font-semibold tracking-tight">Episodes</h2>
      <div className="mt-4">
        <EpisodeGrid
          episodes={episodes}
          freeEpisodeCount={series.free_episode_count}
          unlockedIds={unlockedIds}
          lastWatched={progress?.last_episode_number}
        />
      </div>
    </div>
  )
}
