import type { Metadata } from 'next'
import Link from 'next/link'

import { LedgerList } from '@/components/LedgerList'
import { requireUser, rolesOf } from '@/lib/auth'
import { createServerSupabase } from '@/lib/supabase-server'
import { creditLabel, durationLabel, roleLabel } from '@/lib/labels'

export const metadata: Metadata = { title: 'Profile' }

/** The profile hub — the bottom bar's fifth tab. */
export default async function ProfilePage() {
  // Authorization lives here, next to the data it protects — not in a proxy
  // path matcher that can drift from how Next actually routes the request.
  const userId = await requireUser()
  const supabase = await createServerSupabase()

  // Every read goes through RLS as the signed-in user, with no explicit
  // .eq('user_id') on purpose: if a policy were ever wrong, a filter would
  // hide the bug.
  const [profileRes, balanceRes, ledgerRes, roles, historyRes] = await Promise.all([
    supabase.from('profiles').select('email, display_name, bio, created_at').maybeSingle(),
    supabase.from('credit_balances').select('available_balance, pending_holds').maybeSingle(),
    supabase
      .from('credit_ledger')
      .select('id, amount, status, reason, created_at')
      .order('created_at', { ascending: false })
      .limit(10),
    rolesOf(userId),
    supabase.from('watch_history').select('total_seconds_watched, completed'),
  ])

  const watched = historyRes.data ?? []
  const totalWatchSeconds = watched.reduce((sum, w) => sum + Number(w.total_seconds_watched), 0)
  const episodesWatched = watched.length
  const episodesFinished = watched.filter((w) => w.completed).length

  const profile = profileRes.data
  const available = Number(balanceRes.data?.available_balance ?? 0)
  const holds = Number(balanceRes.data?.pending_holds ?? 0)
  const ledger = ledgerRes.data ?? []

  return (
    <div className="mx-auto max-w-3xl px-4 pb-24 pt-10 sm:px-6">
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
        <p className="mt-8 rounded-lg border border-line bg-surface p-4 text-sm text-ink-secondary">
          Your profile is still being set up. This usually takes a second or
          two — refresh the page.
        </p>
      )}

      {/* ── wallet card ─────────────────────────────────────────────────── */}
      <section className="animate-fade mt-8 flex items-center justify-between rounded-xl border border-line bg-surface p-6">
        <div>
          <h2 className="text-sm font-medium text-ink-secondary">My Wallet</h2>
          <p className="mt-2 text-3xl font-semibold" style={{ color: 'var(--brand-bright)' }}>
            {creditLabel(available)}
          </p>
          {holds < 0 && (
            <p className="mt-1 text-xs text-ink-muted">
              {creditLabel(holds)} on hold for episodes you have open
            </p>
          )}
        </div>
        <Link
          href="/profile/wallet"
          className="rounded-lg px-5 py-2.5 text-sm font-medium text-white shadow-[var(--shadow-brand)] transition-transform hover:scale-[1.02]"
          style={{ background: 'var(--brand-gradient)' }}
        >
          Earn coins
        </Link>
      </section>

      {episodesWatched > 0 && (
        <div className="mt-6 grid grid-cols-3 gap-3">
          {[
            { label: 'Episodes watched', value: String(episodesWatched) },
            { label: 'Finished', value: String(episodesFinished) },
            { label: 'Watch time', value: durationLabel(totalWatchSeconds) },
          ].map((tile) => (
            <div key={tile.label} className="rounded-xl border border-line bg-surface p-4">
              <p className="text-xs text-ink-muted">{tile.label}</p>
              <p className="mt-1 text-xl font-semibold tabular-nums">{tile.value}</p>
            </div>
          ))}
        </div>
      )}

      <section className="animate-fade mt-6 rounded-xl border border-line bg-surface p-6">
        <h2 className="text-sm font-medium text-ink-secondary">Recent coin activity</h2>
        <LedgerList rows={ledger} />
      </section>

      <nav className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { href: '/profile/wallet', label: 'My Wallet' },
          { href: '/rewards', label: 'Earn Rewards' },
          { href: '/profile/history', label: 'Watch history' },
          { href: '/my-list', label: 'My List' },
          { href: '/profile/settings', label: 'Settings' },
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
