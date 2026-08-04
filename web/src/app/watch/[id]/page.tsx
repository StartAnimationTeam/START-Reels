import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { currentUser } from '@/lib/auth'
import { createAnonSupabase, createServerSupabase } from '@/lib/supabase-server'
import { WatchExperience, type EpisodeNav } from './WatchExperience'

/**
 * Server component: loads the episode, its series and its siblings through
 * RLS and hands the client everything it proved — entitlement map, resume
 * position, coin balance. The catalog rows it reads cannot contain
 * provider_asset_id (the 0005 column grant), and every claim the client
 * could tamper with is re-proved by unlock_video / video-playback.
 */

interface Props {
  params: Promise<{ id: string }>
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params
  const supabase = createAnonSupabase()
  const { data } = await supabase.from('videos').select('title').eq('id', id).maybeSingle()
  return { title: data?.title ?? 'Watch' }
}

export default async function WatchPage({ params }: Props) {
  const { id } = await params
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound()

  const userId = await currentUser()
  const supabase = userId ? await createServerSupabase() : createAnonSupabase()

  const { data: video } = await supabase
    .from('videos')
    .select('id, title, thumbnail_url, series_id, episode_number, access_tier, credit_cost')
    .eq('id', id)
    .maybeSingle()

  // RLS already hid unpublished episodes from everyone but the creator/staff,
  // so a null here is genuinely "not for you" — 404, not 403.
  if (!video || !video.series_id) notFound()

  const [{ data: series }, { data: siblings }] = await Promise.all([
    supabase
      .from('series')
      .select('id, slug, title, free_episode_count, episode_credit_cost, total_episodes')
      .eq('id', video.series_id)
      .maybeSingle(),
    supabase
      .from('videos')
      .select('id, episode_number')
      .eq('series_id', video.series_id)
      .eq('status', 'published')
      .is('deleted_at', null)
      .order('episode_number', { ascending: true }),
  ])
  if (!series) notFound()

  const episodes = siblings ?? []
  const myIndex = episodes.findIndex((e) => e.id === video.id)

  // Entitlements, resume and balance — the viewer's own rows through RLS.
  let unlockedIds = new Set<string>()
  let resumeAt = 0
  let balance = 0
  if (userId) {
    const now = new Date().toISOString()
    const [entRes, historyRes, balanceRes] = await Promise.all([
      supabase
        .from('video_entitlements')
        .select('video_id')
        .in('video_id', episodes.map((e) => e.id))
        .gt('expires_at', now)
        .is('revoked_at', null),
      supabase
        .from('watch_history')
        .select('last_position_seconds, completed')
        .eq('video_id', video.id)
        .maybeSingle(),
      // available_balance, never committed_balance (trap #18).
      supabase.from('credit_balances').select('available_balance').maybeSingle(),
    ])
    unlockedIds = new Set((entRes.data ?? []).map((e) => e.video_id))
    // Resume mid-episode; a finished episode restarts from the top.
    resumeAt = historyRes.data?.completed ? 0 : Number(historyRes.data?.last_position_seconds ?? 0)
    balance = Number(balanceRes.data?.available_balance ?? 0)
  }

  const nav = (e: { id: string; episode_number: number | null } | undefined): EpisodeNav | null =>
    e
      ? {
          id: e.id,
          episodeNumber: e.episode_number ?? 0,
          open: (e.episode_number ?? 0) <= series.free_episode_count || unlockedIds.has(e.id),
        }
      : null

  const myNumber = video.episode_number ?? 0
  const episodeCost = myNumber <= series.free_episode_count ? 0 : series.episode_credit_cost

  return (
    <WatchExperience
      videoId={video.id}
      episodeNumber={myNumber}
      seriesTitle={series.title}
      seriesSlug={series.slug}
      totalEpisodes={series.total_episodes}
      episodeCost={episodeCost}
      lockedEpisodeCost={series.episode_credit_cost}
      thumbnailUrl={video.thumbnail_url}
      signedIn={Boolean(userId)}
      initiallyEntitled={unlockedIds.has(video.id)}
      resumeAt={resumeAt}
      balance={balance}
      prev={nav(myIndex > 0 ? episodes[myIndex - 1] : undefined)}
      next={nav(myIndex >= 0 ? episodes[myIndex + 1] : undefined)}
    />
  )
}
