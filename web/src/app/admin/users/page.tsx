import type { Metadata } from 'next'

import { UserActions } from './UserActions'
import { hasRole } from '@/lib/auth'
import { createServerSupabase } from '@/lib/supabase-server'
import { roleLabel } from '@/lib/labels'

export const metadata: Metadata = { title: 'Users · Admin' }

/**
 * User table with search over the DENORMALIZED email/name columns — this is
 * why clerk-webhook copies them into profiles: an admin searching 5k users
 * cannot call the Clerk API per row (the sibling project's role admin does,
 * and degrades to raw ids).
 */
export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>
}) {
  const { q = '' } = await searchParams
  const query = q.trim().slice(0, 100)

  const supabase = await createServerSupabase()
  const viewerIsAdmin = await hasRole('administrator')

  let profileQuery = supabase
    .from('profiles')
    .select('user_id, email, display_name, created_at, suspended_at, banned_at, deleted_at')
    .order('created_at', { ascending: false })
    .limit(100)

  if (query) {
    profileQuery = profileQuery.or(`email.ilike.%${query}%,display_name.ilike.%${query}%`)
  }

  const [{ data: profiles }, { data: allRoles }, { data: balances }, { data: memberships }] = await Promise.all([
    profileQuery,
    supabase.from('user_roles').select('user_id, role'),
    supabase.from('credit_balances').select('user_id, available_balance'),
    supabase.from('memberships').select('user_id, tier, expires_at'),
  ])

  const rolesByUser = new Map<string, string[]>()
  for (const row of allRoles ?? []) {
    rolesByUser.set(row.user_id, [...(rolesByUser.get(row.user_id) ?? []), row.role])
  }
  const balanceByUser = new Map((balances ?? []).map((b) => [b.user_id, Number(b.available_balance)]))
  const membershipByUser = new Map(
    (memberships ?? [])
      .filter((m) => Date.parse(m.expires_at) > Date.now())
      .map((m) => [m.user_id, m]),
  )

  const rows = profiles ?? []

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h2 className="text-lg font-semibold tracking-tight">Users</h2>
        <form method="get" className="flex gap-2">
          <input
            name="q"
            defaultValue={query}
            placeholder="Search email or name…"
            className="rounded-lg border border-line-strong bg-surface-muted px-3 py-1.5 text-sm focus:border-brand focus:outline-none"
          />
          <button className="rounded-lg border border-line-strong px-3 py-1.5 text-sm text-ink-secondary hover:border-brand hover:text-ink">
            Search
          </button>
        </form>
      </div>

      {rows.length === 0 ? (
        <p className="mt-4 text-sm text-ink-muted">
          {query ? `No users match “${query}”.` : 'No users yet.'}
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-xl border border-line">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="border-b border-line bg-surface text-left text-xs text-ink-muted">
                <th className="px-4 py-2.5 font-medium">User</th>
                <th className="px-4 py-2.5 font-medium">Role</th>
                <th className="px-4 py-2.5 font-medium">Credits</th>
                <th className="px-4 py-2.5 font-medium">Member</th>
                <th className="px-4 py-2.5 font-medium">State</th>
                <th className="px-4 py-2.5 font-medium">Joined</th>
                <th className="px-4 py-2.5 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {rows.map((profile) => {
                const roles = rolesByUser.get(profile.user_id) ?? []
                const membership = membershipByUser.get(profile.user_id)
                return (
                  <tr key={profile.user_id} className="bg-background">
                    <td className="max-w-[260px] px-4 py-2.5">
                      <span className="block truncate text-ink">{profile.display_name ?? '—'}</span>
                      <span className="block truncate text-xs text-ink-muted">{profile.email}</span>
                    </td>
                    <td className="px-4 py-2.5 text-ink-secondary">{roleLabel(roles)}</td>
                    <td className="px-4 py-2.5 tabular-nums text-ink-secondary">
                      {balanceByUser.get(profile.user_id) ?? 0}
                    </td>
                    <td className="px-4 py-2.5">
                      {membership ? (
                        <span className="text-xs" title={`until ${new Date(membership.expires_at).toLocaleDateString()}`}>
                          <span className="brand-gradient-text font-semibold">
                            {membership.tier === 'annual' ? 'Annual' : 'Monthly'}
                          </span>
                        </span>
                      ) : (
                        <span className="text-xs text-ink-faint">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      {profile.deleted_at ? (
                        <span className="text-xs text-ink-faint">deleted</span>
                      ) : profile.banned_at ? (
                        <span className="text-xs" style={{ color: 'var(--danger)' }}>banned</span>
                      ) : profile.suspended_at ? (
                        <span className="text-xs" style={{ color: 'var(--warning)' }}>suspended</span>
                      ) : (
                        <span className="text-xs" style={{ color: 'var(--success)' }}>active</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-ink-muted">
                      {new Date(profile.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-2.5">
                      <UserActions
                        userId={profile.user_id}
                        roles={roles}
                        suspended={Boolean(profile.suspended_at)}
                        banned={Boolean(profile.banned_at)}
                        member={Boolean(membership)}
                        viewerIsAdmin={viewerIsAdmin}
                      />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
