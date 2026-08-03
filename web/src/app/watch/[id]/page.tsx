import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { FavoriteButton } from '@/components/FavoriteButton'
import { ReportButton } from '@/components/ReportButton'
import { currentUser } from '@/lib/auth'
import { isFavorited } from '@/lib/catalog'
import { createAnonSupabase, createServerSupabase } from '@/lib/supabase-server'
import { durationLabel, tierCostLabel } from '@/lib/labels'
import { WatchGate } from './WatchGate'

/**
 * Server component: loads the video's PUBLIC metadata through RLS and decides
 * which client state to hand off. The catalog row it reads cannot contain
 * provider_asset_id — the column grant in 0005 makes that a database
 * guarantee, not a discipline.
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
    .select(
      'id, title, description, access_tier, credit_cost, duration_seconds, thumbnail_url, status, creator_id, published_at',
    )
    .eq('id', id)
    .maybeSingle()

  // RLS already hid unpublished videos from everyone but the creator/staff,
  // so a null here is genuinely "not for you" — 404, not 403: revealing that a
  // hidden video EXISTS is itself a leak.
  if (!video) notFound()

  // Does the viewer already hold a live entitlement, and is this saved? Both
  // read through RLS — a signed-out visitor simply gets neither.
  let hasEntitlement = false
  let favorited = false
  if (userId) {
    const [{ data: ents }, fav] = await Promise.all([
      supabase
        .from('video_entitlements')
        .select('id')
        .eq('video_id', id)
        .is('revoked_at', null)
        .gt('expires_at', new Date().toISOString())
        .limit(1),
      isFavorited(supabase, id),
    ])
    hasEntitlement = Boolean(ents?.length)
    favorited = fav
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <WatchGate
        videoId={video.id}
        title={video.title}
        tier={video.access_tier}
        creditCost={video.credit_cost}
        thumbnailUrl={video.thumbnail_url}
        signedIn={Boolean(userId)}
        initiallyEntitled={hasEntitlement}
      />

      <div className="mt-6 animate-rise">
        <div className="flex items-start justify-between gap-4">
          <h1 className="text-2xl font-semibold tracking-tight">{video.title}</h1>
          {userId && <FavoriteButton videoId={video.id} initiallyFavorited={favorited} />}
        </div>
        <p className="mt-1 text-sm text-ink-muted">
          {tierCostLabel(video.access_tier, video.credit_cost)}
          {' · '}
          {durationLabel(video.duration_seconds)}
        </p>
        {video.description && (
          <p className="mt-4 max-w-3xl whitespace-pre-line text-ink-secondary">{video.description}</p>
        )}
        {userId && (
          <div className="mt-6">
            <ReportButton videoId={video.id} />
          </div>
        )}
      </div>
    </div>
  )
}
