import type { Metadata } from 'next'
import Link from 'next/link'

import { CheckinLadder } from './CheckinLadder'
import { currentUser } from '@/lib/auth'
import { creditLabel } from '@/lib/labels'
import { createServerSupabase } from '@/lib/supabase-server'

export const metadata: Metadata = { title: 'Earn Rewards' }

/**
 * The rewards center: check-in ladder + balance. The streak MATH lives in
 * claim_daily_reward (0020); this page only decides which tile to highlight,
 * using the same platform-timezone day the function uses (trap #17 — never
 * the browser clock, and the server refuses a wrong claim regardless).
 */
export default async function RewardsPage() {
  const userId = await currentUser()

  if (!userId) {
    return (
      <div className="mx-auto max-w-2xl px-4 pb-24 pt-16 text-center sm:px-6">
        <h1 className="text-2xl font-semibold tracking-tight">Earn Rewards</h1>
        <p className="mt-3 text-sm text-ink-muted">
          Sign in to check in daily and earn free coins — rewards climb all week.
        </p>
        <Link
          href="/sign-up"
          className="mt-6 inline-block rounded-lg px-6 py-2.5 text-sm font-medium text-white shadow-[var(--shadow-brand)]"
          style={{ background: 'var(--brand-gradient)' }}
        >
          Sign up free
        </Link>
      </div>
    )
  }

  const supabase = await createServerSupabase()
  const [settingsRes, claimsRes, balanceRes] = await Promise.all([
    supabase
      .from('platform_settings')
      .select('key, value')
      .in('key', ['daily_reward_ladder', 'daily_reward_enabled', 'daily_reward_amount', 'platform_timezone']),
    supabase
      .from('daily_reward_claims')
      .select('claim_date, streak_day, amount')
      .order('claim_date', { ascending: false })
      .limit(2),
    supabase.from('credit_balances').select('available_balance').maybeSingle(),
  ])

  const setting = (k: string) => settingsRes.data?.find((s) => s.key === k)?.value
  const rawLadder = setting('daily_reward_ladder')
  const fallback = Number(setting('daily_reward_amount') ?? 1)
  const ladder =
    Array.isArray(rawLadder) && rawLadder.length === 7
      ? rawLadder.map((n) => Number(n))
      : Array.from({ length: 7 }, () => fallback)
  const enabled = String(setting('daily_reward_enabled') ?? 'true') === 'true'
  const tz = String(setting('platform_timezone') ?? 'UTC').replace(/^"|"$/g, '')

  // The platform's calendar, not the browser's.
  const dayInTz = (offset: number) => {
    const d = new Date(Date.now() + offset * 86_400_000)
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d) // YYYY-MM-DD
  }
  const today = dayInTz(0)
  const yesterday = dayInTz(-1)

  const claims = claimsRes.data ?? []
  const todayClaim = claims.find((c) => c.claim_date === today)
  const yesterdayClaim = claims.find((c) => c.claim_date === yesterday)

  // Mirrors 0020: today's row wins; else yesterday's streak continues; else
  // a fresh day 1. Display only — the function recomputes on claim.
  const streakNow = todayClaim
    ? Number(todayClaim.streak_day)
    : yesterdayClaim
      ? Number(yesterdayClaim.streak_day) + 1
      : 1
  const cyclePos = (streakNow - 1) % 7

  const balance = Number(balanceRes.data?.available_balance ?? 0)

  return (
    <div className="mx-auto max-w-2xl px-4 pb-24 pt-10 sm:px-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Earn Rewards</h1>
        <Link href="/profile/wallet" className="text-sm text-ink-muted hover:text-ink">
          Balance: <span className="font-semibold tabular-nums text-ink">{creditLabel(balance)}</span>
        </Link>
      </div>

      <div className="mt-6">
        <CheckinLadder
          ladder={ladder}
          cyclePos={cyclePos}
          claimedToday={Boolean(todayClaim)}
          streakNow={streakNow}
          enabled={enabled}
        />
      </div>

      <section className="mt-6 rounded-2xl border border-line bg-surface p-5">
        <h2 className="text-sm font-medium text-ink-secondary">More ways to earn</h2>
        <ul className="mt-3 space-y-3 text-sm">
          <li className="flex items-center justify-between gap-3">
            <span className="text-ink">Redeem a promo code</span>
            <Link
              href="/profile/wallet"
              className="rounded-lg border border-line-strong px-3.5 py-1.5 text-xs text-ink-secondary transition-colors hover:border-brand hover:text-ink"
            >
              Redeem
            </Link>
          </li>
          <li className="flex items-center justify-between gap-3">
            {/* Boundary states itself (trap #15): tasks that need systems we
                haven't shipped say "soon", they don't render dead buttons. */}
            <span className="text-ink-muted">Watch ads, link accounts, invite friends</span>
            <span className="rounded-full border border-line px-2.5 py-0.5 text-[11px] text-ink-faint">
              Coming soon
            </span>
          </li>
        </ul>
      </section>
    </div>
  )
}
