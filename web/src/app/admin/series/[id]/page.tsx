import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { CoverUploader } from './CoverUploader'
import { EpisodeQueue } from './EpisodeQueue'
import { EpisodeTable } from './EpisodeTable'
import { SeriesActions } from './SeriesActions'
import { SeriesEditor } from './SeriesEditor'
import { hasRole } from '@/lib/auth'
import { activeCategories, allTags } from '@/lib/catalog'
import { createServerSupabase } from '@/lib/supabase-server'
import { SERIES_STATUS_LABELS } from '@/lib/labels'

/**
 * One series, everything about it: metadata editor, cover, lifecycle
 * actions, the episode roster, and the multi-file upload queue. All reads
 * through RLS (the staff policy shows drafts); every write goes through
 * series-manage / video-upload with the service role.
 */

interface Props {
  params: Promise<{ id: string }>
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params
  if (!/^[0-9a-f-]{36}$/.test(id)) return { title: 'Series' }
  const supabase = await createServerSupabase()
  const { data } = await supabase.from('series').select('title').eq('id', id).maybeSingle()
  return { title: data ? `${data.title} · Series` : 'Series' }
}

export default async function AdminSeriesDetailPage({ params }: Props) {
  const { id } = await params
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound()

  const supabase = await createServerSupabase()

  const { data: series } = await supabase
    .from('series')
    .select(
      'id, slug, title, synopsis, cover_url, status, free_episode_count, episode_credit_cost, is_members_only, total_episodes, is_featured, featured_rank, published_at, scheduled_publish_at',
    )
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle()
  if (!series) notFound()

  const [categories, tags, catRowsRes, tagRowsRes, episodesRes, settingsRes, viewerIsAdmin] =
    await Promise.all([
      activeCategories(supabase),
      allTags(supabase),
      supabase.from('series_categories').select('category_id, is_primary').eq('series_id', id),
      supabase.from('series_tags').select('tag_id').eq('series_id', id),
      supabase
        .from('videos')
        .select('id, title, episode_number, status, duration_seconds, created_at')
        .eq('series_id', id)
        .is('deleted_at', null)
        .order('episode_number', { ascending: true }),
      supabase.from('platform_settings').select('key, value').in('key', ['max_upload_bytes', 'platform_timezone']),
      hasRole('administrator'),
    ])

  // Primary category first — the editor treats index 0 as primary.
  const initialCategoryIds = (catRowsRes.data ?? [])
    .sort((a, b) => Number(b.is_primary) - Number(a.is_primary))
    .map((r) => r.category_id)
  const initialTagIds = (tagRowsRes.data ?? []).map((r) => r.tag_id)
  const episodes = episodesRes.data ?? []
  const setting = (k: string) => settingsRes.data?.find((s) => s.key === k)?.value
  const maxBytes = Number(setting('max_upload_bytes') ?? 5_368_709_120)
  const timeZone = String(setting('platform_timezone') ?? 'Asia/Manila').replace(/^"|"$/g, '')

  return (
    <div className="space-y-6">
      {/* ── header ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs text-ink-muted">
            <Link href="/admin/series" className="hover:text-ink hover:underline">Series</Link>
            {' / '}
            <span className="text-ink-faint">{series.slug}</span>
          </p>
          <div className="mt-1 flex items-center gap-3">
            <h2 className="text-lg font-semibold tracking-tight">{series.title}</h2>
            <span
              className="rounded-full border border-line-strong px-2 py-0.5 text-xs"
              style={
                series.status === 'published'
                  ? { color: 'var(--success)' }
                  : series.status === 'removed'
                    ? { color: 'var(--danger)' }
                    : undefined
              }
            >
              {SERIES_STATUS_LABELS[series.status] ?? series.status}
            </span>
            {series.status === 'published' && (
              <Link
                href={`/series/${series.slug}`}
                className="text-xs text-ink-muted hover:text-ink hover:underline"
              >
                View public page ↗
              </Link>
            )}
          </div>
        </div>

        <SeriesActions
          seriesId={series.id}
          title={series.title}
          status={series.status}
          isFeatured={series.is_featured}
          viewerIsAdmin={viewerIsAdmin}
          scheduledPublishAt={series.scheduled_publish_at}
          timeZone={timeZone}
        />
      </div>

      {/* ── cover + editor ─────────────────────────────────────────────── */}
      <div className="flex flex-col gap-6 lg:flex-row">
        <CoverUploader seriesId={series.id} coverUrl={series.cover_url} />
        <div className="min-w-0 flex-1">
          <SeriesEditor
            seriesId={series.id}
            initial={{
              title: series.title,
              synopsis: series.synopsis ?? '',
              freeEpisodeCount: series.free_episode_count,
              episodeCreditCost: series.episode_credit_cost,
              isMembersOnly: series.is_members_only,
            }}
            categories={categories}
            tags={tags}
            initialCategoryIds={initialCategoryIds}
            initialTagIds={initialTagIds}
          />
        </div>
      </div>

      {/* ── episodes ───────────────────────────────────────────────────── */}
      <section>
        <h3 className="text-sm font-medium text-ink-secondary">
          Episodes {episodes.length > 0 && <span className="text-ink-faint">({episodes.length})</span>}
        </h3>
        <EpisodeTable episodes={episodes} viewerIsAdmin={viewerIsAdmin} />
      </section>

      {/* ── upload queue ───────────────────────────────────────────────── */}
      <EpisodeQueue
        seriesId={series.id}
        seriesTitle={series.title}
        maxBytes={maxBytes}
        seriesRemoved={series.status === 'removed'}
      />
    </div>
  )
}
