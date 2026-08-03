import type { Metadata } from 'next'
import Link from 'next/link'

import { requireUser, rolesOf } from '@/lib/auth'
import { createServerSupabase } from '@/lib/supabase-server'
import { durationLabel, tierCostLabel, VIDEO_STATUS_LABELS } from '@/lib/labels'

export const metadata: Metadata = { title: 'Creator studio' }

/**
 * One page, three states, decided by data rather than routes:
 *   not a creator, no application  → the pitch + apply CTA
 *   application pending/rejected   → its status, honestly
 *   creator                        → the dashboard: videos, views, watch time
 */
export default async function CreatorPage() {
  const userId = await requireUser()
  const supabase = await createServerSupabase()
  const roles = await rolesOf(userId)
  const isCreator = roles.length > 0 // creator, moderator or administrator may upload

  if (!isCreator) {
    const { data: application } = await supabase
      .from('creator_applications')
      .select('status, submitted_at, decision_note')
      .order('submitted_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    return (
      <div className="mx-auto max-w-2xl px-4 py-12 sm:px-6">
        <h1 className="text-2xl font-semibold tracking-tight">Creator studio</h1>

        {!application ? (
          <div className="mt-6 rounded-xl border border-line bg-surface p-6">
            <p className="text-ink-secondary">
              Creators upload videos to the library. Uploads go through
              moderation before they publish, and your dashboard tracks views
              and watch time.
            </p>
            <Link
              href="/creator/apply"
              className="mt-4 inline-block rounded-lg px-5 py-2.5 text-sm font-medium text-white shadow-[var(--shadow-brand)]"
              style={{ background: 'var(--brand-gradient)' }}
            >
              Apply to become a creator
            </Link>
          </div>
        ) : application.status === 'pending' ? (
          <div className="mt-6 rounded-xl border border-line bg-surface p-6">
            <p className="font-medium text-ink">Your application is being reviewed.</p>
            <p className="mt-1 text-sm text-ink-muted">
              Submitted {new Date(application.submitted_at).toLocaleDateString()}. You’ll get
              access here the moment it’s approved.
            </p>
          </div>
        ) : (
          <div className="mt-6 rounded-xl border border-line bg-surface p-6">
            <p className="font-medium text-ink">Your application wasn’t approved.</p>
            {application.decision_note && (
              <p className="mt-1 text-sm text-ink-secondary">“{application.decision_note}”</p>
            )}
            <Link
              href="/creator/apply"
              className="mt-4 inline-block rounded-lg border border-line-strong px-4 py-2 text-sm text-ink-secondary hover:border-brand hover:text-ink"
            >
              Apply again
            </Link>
          </div>
        )}
      </div>
    )
  }

  // ── creator dashboard ─────────────────────────────────────────────────
  const { data: videos } = await supabase
    .from('videos')
    .select('id, title, status, access_tier, credit_cost, duration_seconds, view_count, total_watch_seconds, rejection_reason, created_at')
    .eq('creator_id', userId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(100)

  const rows = videos ?? []
  const totalViews = rows.reduce((sum, v) => sum + (v.view_count ?? 0), 0)
  const totalWatch = rows.reduce((sum, v) => sum + (v.total_watch_seconds ?? 0), 0)

  return (
    <div className="mx-auto max-w-5xl px-4 py-12 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Creator studio</h1>
        <Link
          href="/creator/upload"
          className="rounded-lg px-5 py-2.5 text-sm font-medium text-white shadow-[var(--shadow-brand)]"
          style={{ background: 'var(--brand-gradient)' }}
        >
          Upload a video
        </Link>
      </div>

      <div className="mt-6 grid grid-cols-3 gap-4">
        {[
          { label: 'Videos', value: String(rows.length) },
          { label: 'Total views', value: String(totalViews) },
          { label: 'Watch time', value: durationLabel(totalWatch) },
        ].map((tile) => (
          <div key={tile.label} className="rounded-xl border border-line bg-surface p-4">
            <p className="text-xs text-ink-muted">{tile.label}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{tile.value}</p>
          </div>
        ))}
      </div>

      {rows.length === 0 ? (
        <p className="mt-8 text-sm text-ink-muted">No uploads yet — your first one goes through moderation before it publishes.</p>
      ) : (
        <ul className="mt-8 space-y-2">
          {rows.map((video) => (
            <li
              key={video.id}
              className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 text-sm"
            >
              <span className="min-w-0 flex-1 truncate font-medium text-ink">{video.title}</span>
              <span
                className="rounded-full border border-line-strong px-2 py-0.5 text-xs"
                style={
                  video.status === 'published'
                    ? { color: 'var(--success)', borderColor: 'var(--success)' }
                    : video.status === 'rejected'
                      ? { color: 'var(--danger)', borderColor: 'var(--danger)' }
                      : video.status === 'pending_review'
                        ? { color: 'var(--warning)', borderColor: 'var(--warning)' }
                        : undefined
                }
                title={video.rejection_reason ?? undefined}
              >
                {VIDEO_STATUS_LABELS[video.status] ?? video.status}
              </span>
              <span className="text-xs text-ink-muted">{tierCostLabel(video.access_tier, video.credit_cost)}</span>
              <span className="w-20 text-right text-xs tabular-nums text-ink-muted">{video.view_count} views</span>
              <span className="w-20 text-right text-xs tabular-nums text-ink-muted">{durationLabel(video.total_watch_seconds)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
