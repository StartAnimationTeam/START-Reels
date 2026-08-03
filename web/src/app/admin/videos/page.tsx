import type { Metadata } from 'next'

import { VideoActions } from './VideoActions'
import { createServerSupabase } from '@/lib/supabase-server'
import { durationLabel, tierCostLabel, VIDEO_STATUS_LABELS } from '@/lib/labels'

export const metadata: Metadata = { title: 'Videos · Admin' }

/**
 * Every video in every status, newest first — the staff RLS policy makes the
 * whole catalog visible here while the public still sees only `published`.
 * Reads are RLS; every button goes through admin-videos, which audits.
 */
export default async function AdminVideosPage() {
  const supabase = await createServerSupabase()

  const { data: videos } = await supabase
    .from('videos')
    .select('id, title, status, access_tier, credit_cost, duration_seconds, is_featured, featured_rank, view_count, created_at, rejection_reason')
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(200)

  const rows = videos ?? []

  return (
    <div>
      <h2 className="text-lg font-semibold tracking-tight">Videos</h2>

      {rows.length === 0 ? (
        <p className="mt-4 text-sm text-ink-muted">No videos yet — upload one.</p>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-xl border border-line">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-line bg-surface text-left text-xs text-ink-muted">
                <th className="px-4 py-2.5 font-medium">Title</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">Access</th>
                <th className="px-4 py-2.5 font-medium">Length</th>
                <th className="px-4 py-2.5 font-medium">Views</th>
                <th className="px-4 py-2.5 font-medium">Featured</th>
                <th className="px-4 py-2.5 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {rows.map((video) => (
                <tr key={video.id} className="bg-background">
                  <td className="max-w-[280px] truncate px-4 py-2.5 text-ink" title={video.title}>
                    {video.title}
                    {video.rejection_reason && (
                      <span className="block truncate text-xs text-ink-faint" title={video.rejection_reason}>
                        {video.rejection_reason}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className="rounded-full border border-line-strong px-2 py-0.5 text-xs"
                      style={
                        video.status === 'published'
                          ? { color: 'var(--success)', borderColor: 'var(--success)' }
                          : video.status === 'rejected'
                            ? { color: 'var(--danger)', borderColor: 'var(--danger)' }
                            : undefined
                      }
                    >
                      {VIDEO_STATUS_LABELS[video.status] ?? video.status}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-ink-secondary">
                    {tierCostLabel(video.access_tier, video.credit_cost)}
                  </td>
                  <td className="px-4 py-2.5 tabular-nums text-ink-secondary">
                    {durationLabel(video.duration_seconds)}
                  </td>
                  <td className="px-4 py-2.5 tabular-nums text-ink-secondary">{video.view_count}</td>
                  <td className="px-4 py-2.5 text-ink-secondary">
                    {video.is_featured ? `#${video.featured_rank ?? '—'}` : '—'}
                  </td>
                  <td className="px-4 py-2.5">
                    <VideoActions
                      videoId={video.id}
                      status={video.status}
                      tier={video.access_tier}
                      creditCost={video.credit_cost}
                      featured={video.is_featured}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
