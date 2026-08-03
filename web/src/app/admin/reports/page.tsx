import type { Metadata } from 'next'
import Link from 'next/link'

import { ReportActions } from './ReportActions'
import { createServerSupabase } from '@/lib/supabase-server'

export const metadata: Metadata = { title: 'Reports · Admin' }

const REASON_LABELS: Record<string, string> = {
  inappropriate: 'Inappropriate',
  copyright: 'Copyright',
  spam: 'Spam',
  wrong_metadata: 'Wrong metadata',
  other: 'Other',
}

/** The moderation queue: open reports first, with the context to act. */
export default async function AdminReportsPage() {
  const supabase = await createServerSupabase()

  const { data: reports } = await supabase
    .from('video_reports')
    .select('id, reporter_id, video_id, reason, detail, status, action_taken, reviewed_at, created_at')
    .order('created_at', { ascending: false })
    .limit(100)

  const rows = reports ?? []
  const open = rows.filter((r) => r.status === 'open' || r.status === 'reviewing')
  const closed = rows.filter((r) => r.status === 'actioned' || r.status === 'dismissed')

  const videoIds = [...new Set(rows.map((r) => r.video_id))]
  const { data: videos } = videoIds.length
    ? await supabase.from('videos').select('id, title, creator_id, status').in('id', videoIds)
    : { data: [] }
  const videoById = new Map((videos ?? []).map((v) => [v.id, v]))

  return (
    <div>
      <h2 className="text-lg font-semibold tracking-tight">
        Reports
        {open.length > 0 && (
          <span className="ml-2 rounded-full px-2 py-0.5 text-xs font-medium text-white" style={{ background: 'var(--danger)' }}>
            {open.length} open
          </span>
        )}
      </h2>

      {open.length === 0 ? (
        <p className="mt-4 text-sm text-ink-muted">Nothing to review.</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {open.map((report) => {
            const video = videoById.get(report.video_id)
            return (
              <li key={report.id} className="rounded-xl border border-line bg-surface p-4">
                <div className="flex flex-wrap items-baseline gap-2 text-sm">
                  <span className="rounded-full border border-line-strong px-2 py-0.5 text-xs text-ink-secondary">
                    {REASON_LABELS[report.reason] ?? report.reason}
                  </span>
                  {video ? (
                    <Link href={`/watch/${video.id}`} className="font-medium text-ink underline-offset-2 hover:underline">
                      {video.title}
                    </Link>
                  ) : (
                    <span className="text-ink-muted">(video no longer visible)</span>
                  )}
                  <span className="ml-auto text-xs text-ink-faint">
                    {new Date(report.created_at).toLocaleString()}
                  </span>
                </div>
                {report.detail && <p className="mt-2 text-sm text-ink-secondary">“{report.detail}”</p>}
                <div className="mt-3">
                  <ReportActions
                    reportId={report.id}
                    uploaderId={video?.creator_id ?? null}
                    videoId={report.video_id}
                    videoStatus={video?.status ?? null}
                  />
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {closed.length > 0 && (
        <>
          <h3 className="mt-8 text-sm font-medium text-ink-secondary">Decided</h3>
          <ul className="mt-3 space-y-2">
            {closed.map((report) => (
              <li key={report.id} className="rounded-lg border border-line bg-surface px-4 py-2.5 text-sm">
                <span className="text-ink-secondary">
                  {videoById.get(report.video_id)?.title ?? '(gone)'} — {report.status}
                </span>
                {report.action_taken && <span className="text-ink-muted"> · “{report.action_taken}”</span>}
                <span className="float-right text-xs text-ink-faint">
                  {report.reviewed_at ? new Date(report.reviewed_at).toLocaleDateString() : ''}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
