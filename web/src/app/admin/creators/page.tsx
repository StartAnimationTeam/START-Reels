import type { Metadata } from 'next'

import { ApplicationActions } from './ApplicationActions'
import { createServerSupabase } from '@/lib/supabase-server'

export const metadata: Metadata = { title: 'Creators · Admin' }

/**
 * The creator application queue. Pending first — that is the work; decided
 * ones trail below for context. Approval grants the creator role through
 * admin-users, which audits (and the role trigger records it a second time).
 */
export default async function AdminCreatorsPage() {
  const supabase = await createServerSupabase()

  const { data: applications } = await supabase
    .from('creator_applications')
    .select('id, user_id, status, bio, portfolio_url, submitted_at, reviewed_at, decision_note')
    .order('submitted_at', { ascending: false })
    .limit(100)

  const rows = applications ?? []
  const pending = rows.filter((a) => a.status === 'pending')
  const decided = rows.filter((a) => a.status !== 'pending')

  // One profiles read for every application in view — never per row.
  const userIds = [...new Set(rows.map((a) => a.user_id))]
  const { data: profiles } = userIds.length
    ? await supabase.from('profiles').select('user_id, email, display_name').in('user_id', userIds)
    : { data: [] }
  const profileById = new Map((profiles ?? []).map((p) => [p.user_id, p]))

  const Card = ({ application, actionable }: { application: (typeof rows)[number]; actionable: boolean }) => {
    const profile = profileById.get(application.user_id)
    return (
      <li className="rounded-xl border border-line bg-surface p-4">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="font-medium text-ink">{profile?.display_name ?? '—'}</span>
          <span className="text-xs text-ink-muted">{profile?.email}</span>
          <span className="ml-auto text-xs text-ink-faint">
            {new Date(application.submitted_at).toLocaleDateString()}
          </span>
        </div>
        {application.bio && (
          <p className="mt-2 whitespace-pre-line text-sm text-ink-secondary">{application.bio}</p>
        )}
        {application.portfolio_url && (
          <a
            href={application.portfolio_url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-block text-sm underline text-ink-secondary hover:text-ink"
          >
            Portfolio ↗
          </a>
        )}
        <div className="mt-3">
          {actionable ? (
            <ApplicationActions applicationId={application.id} />
          ) : (
            <p className="text-xs text-ink-muted">
              {application.status === 'approved' ? 'Approved' : 'Rejected'}
              {application.decision_note ? ` — “${application.decision_note}”` : ''}
              {application.reviewed_at ? ` · ${new Date(application.reviewed_at).toLocaleDateString()}` : ''}
            </p>
          )}
        </div>
      </li>
    )
  }

  return (
    <div>
      <h2 className="text-lg font-semibold tracking-tight">
        Creator applications
        {pending.length > 0 && (
          <span className="ml-2 rounded-full px-2 py-0.5 text-xs font-medium text-white" style={{ background: 'var(--brand-gradient)' }}>
            {pending.length} pending
          </span>
        )}
      </h2>

      {pending.length === 0 ? (
        <p className="mt-4 text-sm text-ink-muted">No applications waiting.</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {pending.map((application) => (
            <Card key={application.id} application={application} actionable />
          ))}
        </ul>
      )}

      {decided.length > 0 && (
        <>
          <h3 className="mt-8 text-sm font-medium text-ink-secondary">Decided</h3>
          <ul className="mt-3 space-y-3">
            {decided.map((application) => (
              <Card key={application.id} application={application} actionable={false} />
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
