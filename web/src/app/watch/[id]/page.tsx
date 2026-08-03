import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { currentUser } from '@/lib/auth'
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

  // Does the viewer already hold a live entitlement? Read through RLS — a
  // signed-out visitor simply gets none.
  let hasEntitlement = false
  if (userId) {
    const { data: ents } = await supabase
      .from('video_entitlements')
      .select('id')
      .eq('video_id', id)
      .is('revoked_at', null)
      .gt('expires_at', new Date().toISOString())
      .limit(1)
    hasEntitlement = Boolean(ents?.length)
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
        <h1 className="text-2xl font-semibold tracking-tight">{video.title}</h1>
        <p className="mt-1 text-sm text-ink-muted">
          {tierCostLabel(video.access_tier, video.credit_cost)}
          {' · '}
          {durationLabel(video.duration_seconds)}
        </p>
        {video.description && (
          <p className="mt-4 max-w-3xl whitespace-pre-line text-ink-secondary">{video.description}</p>
        )}
      </div>
    </div>
  )
}
