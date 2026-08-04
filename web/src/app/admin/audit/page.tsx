import type { Metadata } from 'next'
import Link from 'next/link'

import { createServerSupabase } from '@/lib/supabase-server'
import type { Json } from '@/lib/database.types'

export const metadata: Metadata = { title: 'Audit log · Admin' }

/**
 * The audit trail, read-only by construction: the table is append-only with
 * UPDATE/DELETE revoked from every role including service_role, so what this
 * page shows is what happened — there is no edit path to lie with.
 *
 * Enhanced past the raw codes: every entry NARRATES (who did what to which
 * *named* thing), targets resolve to titles/emails instead of UUIDs, money
 * consequences wear badges (refunds, Bunny deletion failures), details render
 * as a changed-keys diff instead of a JSON blob, and the log filters by
 * domain chips + actor + free text — all URL state, all server-rendered.
 * Timestamps group and read in PLATFORM time, same as scheduling (trap #17).
 */

// ── domains ────────────────────────────────────────────────────────────────
const DOMAINS = [
  { key: 'series', label: 'Series', prefix: 'series.' },
  { key: 'episodes', label: 'Episodes', prefix: 'video.' },
  { key: 'taxonomy', label: 'Categories & facets', prefix: 'taxonomy.' },
  { key: 'users', label: 'Users', prefix: 'user.' },
  { key: 'creators', label: 'Creators', prefix: 'creator_application.' },
  { key: 'reports', label: 'Reports', prefix: 'report.' },
  { key: 'promos', label: 'Promos', prefix: 'promo.' },
  { key: 'settings', label: 'Settings', prefix: 'settings.' },
] as const

// ── narration ──────────────────────────────────────────────────────────────
type Payload = Record<string, Json | undefined> | null

function get(p: Payload, key: string): string | null {
  const v = p?.[key]
  return typeof v === 'string' || typeof v === 'number' ? String(v) : null
}

/** One honest sentence per action. `target` is the resolved display name. */
function narrate(action: string, target: string, before: Payload, after: Payload): string {
  const map: Record<string, string> = {
    'series.create': `Created series ${target}`,
    'series.update': `Edited series ${target}`,
    'series.set_cover': `Uploaded a cover for ${target}`,
    'series.set_hero': `Uploaded a hero banner for ${target}`,
    'series.set_featured':
      get(after, 'is_featured') === 'true'
        ? `Featured ${target} at #${get(after, 'featured_rank') ?? '—'}`
        : `Unfeatured ${target}`,
    'series.publish': `Published series ${target}`,
    'series.remove': `Removed series ${target}`,
    'video.update_meta': `Edited episode ${target}`,
    'video.set_featured': `Toggled featured on episode ${target}`,
    'video.publish': `Published episode ${target}`,
    'video.reject': `Unpublished episode ${target}`,
    'video.remove': `Deleted episode ${target}`,
    'taxonomy.category_created': `Added category ${target}`,
    'taxonomy.category_updated': `Edited category ${target}`,
    'taxonomy.category_deleted': `Deleted category ${target}`,
    'taxonomy.tag_created': `Added facet ${target}`,
    'taxonomy.tag_deleted': `Deleted facet ${target}`,
    'promo.created': `Created promo ${target}${get(after, 'amount') ? ` worth ${get(after, 'amount')} coins` : ''}`,
    'promo.toggled': get(after, 'is_active') === 'true' ? `Activated promo ${target}` : `Deactivated promo ${target}`,
    'settings.updated': `Changed setting ${target}`,
    'user.grant_credits': `Granted coins to ${target}`,
    'user.deduct_credits': `Deducted coins from ${target}`,
    'user.suspend': `Suspended ${target}`,
    'user.unsuspend': `Lifted the suspension on ${target}`,
    'user.ban': `Banned ${target}`,
    'user.unban': `Unbanned ${target}`,
    'user.warned': `Warned ${target}`,
    'user.role_granted': `Granted a role to ${target}`,
    'user.role_revoked': `Revoked a role from ${target}`,
    'creator_application.approved': `Approved ${target} as a creator`,
    'creator_application.rejected': `Rejected ${target}’s creator application`,
    'report.resolved': `Resolved a report on ${target}`,
    'report.dismissed': `Dismissed a report on ${target}`,
  }
  return map[action] ?? `${action.replace(/[._]/g, ' ')} — ${target}`
}

// ── the changed-keys diff ──────────────────────────────────────────────────
function isRecord(v: Json | null | undefined): v is { [key: string]: Json } {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function show(v: Json | undefined): string {
  if (v === undefined || v === null) return '—'
  if (typeof v === 'string') return v.length > 80 ? `${v.slice(0, 77)}…` : v
  return JSON.stringify(v)
}

function Diff({ before, after }: { before: Json | null; after: Json | null }) {
  if (!isRecord(before) || !isRecord(after)) {
    return (
      <pre className="mt-1 overflow-x-auto rounded bg-surface-muted p-2 text-[11px] text-ink-secondary">
        {JSON.stringify({ before, after }, null, 2)}
      </pre>
    )
  }
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]),
  )
  if (keys.length === 0) {
    return <p className="mt-1 text-xs text-ink-faint">No field changes recorded.</p>
  }
  return (
    <div className="mt-1 overflow-x-auto rounded-lg border border-line">
      <table className="w-full min-w-[420px] text-xs">
        <thead>
          <tr className="border-b border-line bg-surface text-left text-ink-muted">
            <th className="px-3 py-1.5 font-medium">Field</th>
            <th className="px-3 py-1.5 font-medium">Before</th>
            <th className="px-3 py-1.5 font-medium">After</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--border)]">
          {keys.map((k) => (
            <tr key={k}>
              <td className="px-3 py-1.5 font-mono text-ink-secondary">{k}</td>
              <td className="px-3 py-1.5 text-ink-muted">{show(before[k])}</td>
              <td className="px-3 py-1.5 text-ink">{show(after[k])}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── the page ───────────────────────────────────────────────────────────────
export default async function AdminAuditPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; cat?: string; actor?: string }>
}) {
  const params = await searchParams
  const query = (params.q ?? '').trim().slice(0, 60)
  const domain = DOMAINS.find((d) => d.key === params.cat)
  const actorFilter = (params.actor ?? '').trim()

  const supabase = await createServerSupabase()

  let auditQuery = supabase
    .from('audit_logs')
    .select('id, actor_id, action, target_type, target_id, before, after, created_at')
    .order('created_at', { ascending: false })
    .limit(200)
  if (domain) auditQuery = auditQuery.ilike('action', `${domain.prefix}%`)
  if (query) auditQuery = auditQuery.ilike('action', `%${query}%`)
  if (actorFilter) auditQuery = auditQuery.eq('actor_id', actorFilter)

  const [{ data: logs }, tzRes, { data: staffRows }] = await Promise.all([
    auditQuery,
    supabase.from('platform_settings').select('value').eq('key', 'platform_timezone').maybeSingle(),
    supabase.from('user_roles').select('user_id').in('role', ['moderator', 'administrator']),
  ])
  const rows = logs ?? []
  const timeZone = String(tzRes.data?.value ?? 'Asia/Manila').replace(/^"|"$/g, '')

  // ── resolve names: actors, staff (for the filter), and targets ──────────
  const staffIds = [...new Set((staffRows ?? []).map((r) => r.user_id))]
  const actorIds = [...new Set(rows.map((r) => r.actor_id).filter((a): a is string => Boolean(a)))]
  const userTargetIds = rows
    .filter((r) => r.target_type === 'user' || r.target_type === 'creator_application')
    .map((r) => (r.target_type === 'user' ? r.target_id : null))
    .filter((x): x is string => Boolean(x))
  const profileIds = [...new Set([...staffIds, ...actorIds, ...userTargetIds])]

  const seriesIds = [
    ...new Set(rows.filter((r) => r.target_type === 'series' && r.target_id).map((r) => r.target_id!)),
  ]
  const videoIds = [
    ...new Set(rows.filter((r) => r.target_type === 'video' && r.target_id).map((r) => r.target_id!)),
  ]

  const [{ data: profiles }, { data: seriesRows }, { data: videoRows }] = await Promise.all([
    profileIds.length
      ? supabase.from('profiles').select('user_id, email').in('user_id', profileIds)
      : Promise.resolve({ data: [] as Array<{ user_id: string; email: string }> }),
    seriesIds.length
      ? supabase.from('series').select('id, title').in('id', seriesIds)
      : Promise.resolve({ data: [] as Array<{ id: string; title: string }> }),
    videoIds.length
      ? supabase.from('videos').select('id, title').in('id', videoIds)
      : Promise.resolve({ data: [] as Array<{ id: string; title: string }> }),
  ])
  const emailById = new Map((profiles ?? []).map((p) => [p.user_id, p.email]))
  const seriesTitle = new Map((seriesRows ?? []).map((s) => [s.id, s.title]))
  const videoTitle = new Map((videoRows ?? []).map((v) => [v.id, v.title]))

  const targetName = (r: (typeof rows)[number]): string => {
    const before = isRecord(r.before) ? r.before : null
    const after = isRecord(r.after) ? r.after : null
    if (r.target_type === 'series')
      return `“${seriesTitle.get(r.target_id ?? '') ?? get(after, 'title') ?? get(before, 'title') ?? 'a deleted series'}”`
    if (r.target_type === 'video')
      return `“${videoTitle.get(r.target_id ?? '') ?? get(after, 'title') ?? get(before, 'title') ?? 'a deleted episode'}”`
    if (r.target_type === 'user') return emailById.get(r.target_id ?? '') ?? r.target_id ?? 'a user'
    if (r.target_type === 'category' || r.target_type === 'tag')
      return `“${get(after, 'name') ?? get(before, 'name') ?? r.target_id ?? '—'}”`
    if (r.target_type === 'promo_campaign') return get(after, 'code') ?? r.target_id?.slice(0, 8) ?? '—'
    if (r.target_type === 'platform_setting') return r.target_id ?? '—'
    // creator_application targets carry the applicant in the payload
    return get(after, 'email') ?? get(before, 'email') ?? r.target_id?.slice(0, 12) ?? '—'
  }

  // ── group by platform day ────────────────────────────────────────────────
  const dayOf = (iso: string) =>
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso))
  const today = dayOf(new Date().toISOString())
  const yesterday = dayOf(new Date(Date.now() - 86400_000).toISOString())
  const dayHeading = (day: string) =>
    day === today
      ? 'Today'
      : day === yesterday
        ? 'Yesterday'
        : new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' })

  const groups: Array<{ day: string; entries: typeof rows }> = []
  for (const r of rows) {
    const day = dayOf(r.created_at)
    const last = groups[groups.length - 1]
    if (last && last.day === day) last.entries.push(r)
    else groups.push({ day, entries: [r] })
  }

  // ── filter chips: flip one param, keep the rest ──────────────────────────
  const href = (next: Partial<{ q: string; cat: string; actor: string }>) => {
    const merged = { q: query, cat: params.cat ?? '', actor: actorFilter, ...next }
    const usp = new URLSearchParams()
    if (merged.q) usp.set('q', merged.q)
    if (merged.cat) usp.set('cat', merged.cat)
    if (merged.actor) usp.set('actor', merged.actor)
    const s = usp.toString()
    return s ? `/admin/audit?${s}` : '/admin/audit'
  }
  const chip = (active: boolean) =>
    `whitespace-nowrap rounded-full border px-3 py-1 text-xs transition-colors ${
      active ? 'border-transparent font-medium text-white' : 'border-line text-ink-secondary hover:border-line-strong hover:text-ink'
    }`
  const chipStyle = (active: boolean) => (active ? { background: 'var(--brand-gradient)' } : undefined)

  const timeLabel = (iso: string) =>
    new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZone })

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h2 className="text-lg font-semibold tracking-tight">Audit log</h2>
        <form method="get" className="flex gap-2">
          {params.cat && <input type="hidden" name="cat" value={params.cat} />}
          {actorFilter && <input type="hidden" name="actor" value={actorFilter} />}
          <input
            name="q"
            defaultValue={query}
            placeholder="Search actions… (e.g. remove)"
            className="rounded-lg border border-line-strong bg-surface-muted px-3 py-1.5 text-sm focus:border-brand focus:outline-none"
          />
          <button className="rounded-lg border border-line-strong px-3 py-1.5 text-sm text-ink-secondary hover:border-brand hover:text-ink">
            Search
          </button>
        </form>
      </div>

      {/* domain chips */}
      <div className="no-scrollbar -mx-4 mt-3 flex gap-1.5 overflow-x-auto px-4 sm:-mx-6 sm:px-6">
        <Link href={href({ cat: '' })} className={chip(!domain)} style={chipStyle(!domain)}>
          All
        </Link>
        {DOMAINS.map((d) => (
          <Link
            key={d.key}
            href={href({ cat: domain?.key === d.key ? '' : d.key })}
            className={chip(domain?.key === d.key)}
            style={chipStyle(domain?.key === d.key)}
          >
            {d.label}
          </Link>
        ))}
      </div>

      {/* actor chips — the staff roster; tap the active one to clear */}
      {staffIds.length > 1 && (
        <div className="no-scrollbar -mx-4 mt-2 flex items-center gap-1.5 overflow-x-auto px-4 sm:-mx-6 sm:px-6">
          <span className="text-xs text-ink-faint">By:</span>
          {staffIds.map((id) => (
            <Link
              key={id}
              href={href({ actor: actorFilter === id ? '' : id })}
              className={chip(actorFilter === id)}
              style={chipStyle(actorFilter === id)}
            >
              {emailById.get(id) ?? id.slice(0, 12)}
            </Link>
          ))}
        </div>
      )}

      {rows.length === 0 ? (
        <p className="mt-4 text-sm text-ink-muted">
          {query || domain || actorFilter ? 'No entries match these filters.' : 'No admin actions recorded yet.'}
        </p>
      ) : (
        <div className="mt-4 space-y-6">
          {groups.map((group) => (
            <section key={group.day}>
              <h3 className="text-xs font-medium uppercase tracking-widest text-ink-faint">
                {dayHeading(group.day)}
              </h3>
              <ul className="mt-2 space-y-2">
                {group.entries.map((entry) => {
                  const before = isRecord(entry.before) ? entry.before : null
                  const after = isRecord(entry.after) ? entry.after : null
                  const refunded = Number(get(after, 'entitlements_revoked') ?? 0)
                  const bunnyFailed = Number(get(after, 'bunny_failed') ?? 0)
                  const bunnyDeleted = get(after, 'bunny_deleted')
                  return (
                    <li key={entry.id} className="rounded-lg border border-line bg-surface px-4 py-2.5 text-sm">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span className="text-ink">{narrate(entry.action, targetName(entry), before, after)}</span>

                        {refunded > 0 && (
                          <span
                            className="rounded-full px-2 py-0.5 text-[11px] font-medium text-black"
                            style={{ background: 'var(--warning)' }}
                          >
                            refunded {refunded} unlock{refunded === 1 ? '' : 's'}
                          </span>
                        )}
                        {bunnyFailed > 0 && (
                          <span
                            className="rounded-full px-2 py-0.5 text-[11px] font-medium text-white"
                            style={{ background: 'var(--danger)' }}
                          >
                            {bunnyFailed} Bunny deletion{bunnyFailed === 1 ? '' : 's'} failed — orphaned GB
                          </span>
                        )}
                        {bunnyDeleted === 'false' && (
                          <span
                            className="rounded-full px-2 py-0.5 text-[11px] font-medium text-white"
                            style={{ background: 'var(--danger)' }}
                          >
                            Bunny deletion failed
                          </span>
                        )}

                        <span className="ml-auto text-xs text-ink-faint" title={entry.created_at}>
                          {emailById.get(entry.actor_id ?? '') ?? entry.actor_id ?? 'system'}
                          {' · '}
                          {timeLabel(entry.created_at)}
                        </span>
                      </div>

                      {(entry.before || entry.after) && (
                        <details className="mt-1">
                          <summary className="cursor-pointer text-xs text-ink-faint hover:text-ink-muted">
                            <span className="font-mono">{entry.action}</span> — what changed
                          </summary>
                          <Diff before={entry.before} after={entry.after} />
                        </details>
                      )}
                    </li>
                  )
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
