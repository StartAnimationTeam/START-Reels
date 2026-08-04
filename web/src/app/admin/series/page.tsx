import type { Metadata } from 'next'
import Link from 'next/link'

import { SeriesCreate } from './SeriesCreate'
import { SeriesRowActions } from './SeriesRowActions'
import { hasRole } from '@/lib/auth'
import { createServerSupabase } from '@/lib/supabase-server'
import { episodeLabel, SERIES_STATUS_LABELS, seriesPricingLabel } from '@/lib/labels'

export const metadata: Metadata = { title: 'Series' }

/**
 * The Video Library's front page: every series in every status. Reads go
 * straight through RLS — the staff SELECT policy on `series` (0017) shows
 * drafts here that the public catalog never sees. Writes all happen on the
 * detail page through series-manage.
 */
export default async function AdminSeriesPage() {
  const supabase = await createServerSupabase()

  const [{ data: series }, viewerIsAdmin, tzRes] = await Promise.all([
    supabase
      .from('series')
      .select(
        'id, slug, title, status, cover_url, free_episode_count, episode_credit_cost, is_members_only, total_episodes, is_featured, featured_rank, published_at, scheduled_publish_at, created_at',
      )
      .is('deleted_at', null)
      // The 0018 backfill carried 'removed' over WITHOUT deleted_at; either
      // way, a removed series is history, not library.
      .neq('status', 'removed')
      .order('created_at', { ascending: false })
      .limit(200),
    hasRole('administrator'),
    supabase.from('platform_settings').select('value').eq('key', 'platform_timezone').maybeSingle(),
  ])

  const rows = series ?? []
  // Timers read in PLATFORM time (trap #17), not the admin device's clock.
  const timeZone = String(tzRes.data?.value ?? 'Asia/Manila').replace(/^"|"$/g, '')

  return (
    <div>
      <SeriesCreate />

      {rows.length === 0 ? (
        <p className="mt-6 text-sm text-ink-muted">
          No series yet — create the first one above, then upload its episodes from the series page.
        </p>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-xl border border-line">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="border-b border-line bg-surface text-left text-xs text-ink-muted">
              <tr>
                <th className="px-4 py-2.5 font-medium">Series</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">Episodes</th>
                <th className="px-4 py-2.5 font-medium">Pricing</th>
                <th className="px-4 py-2.5 font-medium">Members</th>
                <th className="px-4 py-2.5 font-medium">Featured</th>
                {viewerIsAdmin && <th className="px-4 py-2.5 text-right font-medium">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {rows.map((s) => (
                <tr key={s.id} className="transition-colors hover:bg-surface">
                  <td className="px-4 py-2.5">
                    <Link href={`/admin/series/${s.id}`} className="flex items-center gap-3">
                      <span className="block h-14 w-10 shrink-0 overflow-hidden rounded-md border border-line bg-surface-muted">
                        {s.cover_url && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={s.cover_url} alt="" loading="lazy" className="h-full w-full object-cover" />
                        )}
                      </span>
                      <span className="font-medium text-ink hover:underline">{s.title}</span>
                    </Link>
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className="rounded-full border border-line-strong px-2 py-0.5 text-xs"
                      style={
                        s.status === 'published'
                          ? { color: 'var(--success)' }
                          : s.status === 'removed'
                            ? { color: 'var(--danger)' }
                            : s.scheduled_publish_at
                              ? { color: 'var(--warning)' }
                              : undefined
                      }
                    >
                      {s.status === 'draft' && s.scheduled_publish_at
                        ? `⏱ ${new Date(s.scheduled_publish_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone })}`
                        : (SERIES_STATUS_LABELS[s.status] ?? s.status)}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 tabular-nums text-ink-secondary">
                    {s.total_episodes > 0 ? episodeLabel(s.total_episodes) : '—'}
                  </td>
                  <td className="px-4 py-2.5 text-ink-secondary">
                    {seriesPricingLabel(s.free_episode_count, s.episode_credit_cost)}
                  </td>
                  <td className="px-4 py-2.5 text-ink-secondary">{s.is_members_only ? 'VIP' : '—'}</td>
                  <td className="px-4 py-2.5 tabular-nums text-ink-secondary">
                    {s.is_featured ? `#${s.featured_rank ?? '—'}` : '—'}
                  </td>
                  {viewerIsAdmin && (
                    <td className="px-4 py-2.5">
                      <SeriesRowActions seriesId={s.id} />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
