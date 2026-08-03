import type { Metadata } from 'next'

import { createServerSupabase } from '@/lib/supabase-server'

export const metadata: Metadata = { title: 'Audit log · Admin' }

/**
 * The audit trail, read-only by construction: the table is append-only with
 * UPDATE/DELETE revoked from every role including service_role, so what this
 * page shows is what happened — there is no edit path to lie with.
 */
export default async function AdminAuditPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>
}) {
  const { q = '' } = await searchParams
  const query = q.trim().slice(0, 60)

  const supabase = await createServerSupabase()
  let auditQuery = supabase
    .from('audit_logs')
    .select('id, actor_id, action, target_type, target_id, before, after, created_at')
    .order('created_at', { ascending: false })
    .limit(200)
  if (query) auditQuery = auditQuery.ilike('action', `%${query}%`)

  const { data: logs } = await auditQuery
  const rows = logs ?? []

  const actorIds = [...new Set(rows.map((r) => r.actor_id).filter((a): a is string => Boolean(a)))]
  const { data: actors } = actorIds.length
    ? await supabase.from('profiles').select('user_id, email').in('user_id', actorIds)
    : { data: [] }
  const emailById = new Map((actors ?? []).map((a) => [a.user_id, a.email]))

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h2 className="text-lg font-semibold tracking-tight">Audit log</h2>
        <form method="get" className="flex gap-2">
          <input
            name="q"
            defaultValue={query}
            placeholder="Filter by action… (e.g. video.remove)"
            className="rounded-lg border border-line-strong bg-surface-muted px-3 py-1.5 text-sm focus:border-brand focus:outline-none"
          />
          <button className="rounded-lg border border-line-strong px-3 py-1.5 text-sm text-ink-secondary hover:border-brand hover:text-ink">
            Filter
          </button>
        </form>
      </div>

      {rows.length === 0 ? (
        <p className="mt-4 text-sm text-ink-muted">
          {query ? `No entries match “${query}”.` : 'No admin actions recorded yet.'}
        </p>
      ) : (
        <ul className="mt-4 space-y-2">
          {rows.map((entry) => (
            <li key={entry.id} className="rounded-lg border border-line bg-surface px-4 py-2.5 text-sm">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-mono text-xs text-ink">{entry.action}</span>
                <span className="text-xs text-ink-muted">
                  {entry.target_type}
                  {entry.target_id ? ` · ${entry.target_id.slice(0, 20)}` : ''}
                </span>
                <span className="ml-auto text-xs text-ink-faint">
                  {emailById.get(entry.actor_id ?? '') ?? entry.actor_id ?? 'system'}
                  {' · '}
                  {new Date(entry.created_at).toLocaleString()}
                </span>
              </div>
              {(entry.before || entry.after) && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-xs text-ink-faint hover:text-ink-muted">details</summary>
                  <pre className="mt-1 overflow-x-auto rounded bg-surface-muted p-2 text-[11px] text-ink-secondary">
                    {JSON.stringify({ before: entry.before, after: entry.after }, null, 2)}
                  </pre>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
