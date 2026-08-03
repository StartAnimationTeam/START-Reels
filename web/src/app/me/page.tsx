import type { Metadata } from 'next'
import Link from 'next/link'

import { requireUser, rolesOf } from '@/lib/auth'
import { createServerSupabase } from '@/lib/supabase-server'
import { creditLabel, LEDGER_REASON_LABELS, LEDGER_STATUS_LABELS, roleLabel } from '@/lib/labels'

export const metadata: Metadata = { title: 'Your profile' }

export default async function ProfilePage() {
  // Authorization lives here, next to the data it protects — not in a proxy
  // path matcher that can drift from how Next actually routes the request.
  const userId = await requireUser()
  const supabase = await createServerSupabase()

  // Every one of these reads goes through RLS as the signed-in user. There is
  // no `.eq('user_id', userId)` on the profile or balance queries on purpose:
  // if a policy were ever wrong, an explicit filter would hide the bug. Let RLS
  // be the only thing scoping them, so a mistake shows up here rather than in
  // production.
  const [profileRes, balanceRes, ledgerRes, roles] = await Promise.all([
    supabase.from('profiles').select('email, display_name, bio, created_at').maybeSingle(),
    supabase.from('credit_balances').select('available_balance, pending_holds').maybeSingle(),
    supabase
      .from('credit_ledger')
      .select('id, amount, status, reason, created_at')
      .order('created_at', { ascending: false })
      .limit(10),
    rolesOf(userId),
  ])

  const profile = profileRes.data
  const available = Number(balanceRes.data?.available_balance ?? 0)
  const holds = Number(balanceRes.data?.pending_holds ?? 0)
  const ledger = ledgerRes.data ?? []

  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <header className="animate-rise">
        <h1 className="text-2xl font-semibold tracking-tight">
          {profile?.display_name || 'Your profile'}
        </h1>
        <p className="mt-1 text-sm text-ink-muted">
          {profile?.email ?? '—'} · {roleLabel(roles)}
        </p>
      </header>

      {!profile && (
        // Distinguishes "the webhook hasn't landed" from "something is broken".
        // Both look like an empty page otherwise, and only one is worth waiting
        // out.
        <p className="mt-8 rounded-lg border border-line bg-surface p-4 text-sm text-ink-secondary">
          Your profile is still being set up. This usually takes a second or
          two — refresh the page.
        </p>
      )}

      <section className="animate-fade mt-8 rounded-xl border border-line bg-surface p-6">
        <h2 className="text-sm font-medium text-ink-secondary">Credits</h2>
        <p className="mt-2 text-3xl font-semibold" style={{ color: 'var(--brand-bright)' }}>
          {creditLabel(available)}
        </p>
        {holds < 0 && (
          // Holds are negative rows already netted out of `available`. Showing
          // them explains a balance that would otherwise look wrong to someone
          // who just unlocked something.
          <p className="mt-1 text-xs text-ink-muted">
            {creditLabel(holds)} on hold for videos you have open
          </p>
        )}
        <p className="mt-3 text-xs text-ink-faint">
          Free videos cost nothing. Premium costs 1 credit, exclusive 2–5. An
          unlock lasts 48 hours.
        </p>
      </section>

      <section className="animate-fade mt-6 rounded-xl border border-line bg-surface p-6">
        <h2 className="text-sm font-medium text-ink-secondary">Recent credit activity</h2>

        {ledger.length === 0 ? (
          <p className="mt-3 text-sm text-ink-muted">Nothing yet.</p>
        ) : (
          <ul className="mt-4 divide-y divide-[var(--border)]">
            {ledger.map((row) => (
              <li key={row.id} className="flex items-baseline gap-3 py-2.5 text-sm">
                <span className="text-ink">{LEDGER_REASON_LABELS[row.reason] ?? row.reason}</span>
                {row.status !== 'committed' && (
                  <span className="rounded-full border border-line-strong px-2 py-0.5 text-[11px] text-ink-muted">
                    {LEDGER_STATUS_LABELS[row.status] ?? row.status}
                  </span>
                )}
                <span className="ml-auto shrink-0 text-xs text-ink-muted">
                  {new Date(row.created_at).toLocaleDateString()}
                </span>
                <span
                  className="w-16 shrink-0 text-right font-medium tabular-nums"
                  style={{ color: row.amount > 0 ? 'var(--success)' : 'var(--text-secondary)' }}
                >
                  {row.amount > 0 ? '+' : ''}
                  {row.amount}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <nav className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { href: '/me/credits', label: 'Credits & rewards' },
          { href: '/me/history', label: 'Watch history' },
          { href: '/me/favorites', label: 'My list' },
          { href: '/me/settings', label: 'Settings' },
          { href: '/creator', label: 'Creator studio' },
        ].map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="rounded-xl border border-line bg-surface p-4 text-sm text-ink-secondary transition-colors hover:border-line-strong hover:text-ink"
          >
            {item.label}
          </Link>
        ))}
      </nav>
    </div>
  )
}
