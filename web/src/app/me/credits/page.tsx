import type { Metadata } from 'next'

import { WalletActions } from './WalletActions'
import { requireUser } from '@/lib/auth'
import { createServerSupabase } from '@/lib/supabase-server'
import { creditLabel, LEDGER_REASON_LABELS, LEDGER_STATUS_LABELS } from '@/lib/labels'

export const metadata: Metadata = { title: 'Credits' }

/**
 * The wallet: balance, the two claim actions, and the full ledger.
 *
 * Balance is available_balance — committed plus outstanding holds — never
 * committed_balance (trap #18: a user with open holds must not see credits
 * they can't spend). The ledger shows holds explicitly for the same reason.
 */
export default async function CreditsPage() {
  await requireUser()
  const supabase = await createServerSupabase()

  const today = new Date().toISOString().slice(0, 10)
  const [balanceRes, ledgerRes, claimRes, settingsRes] = await Promise.all([
    supabase.from('credit_balances').select('available_balance, pending_holds').maybeSingle(),
    supabase
      .from('credit_ledger')
      .select('id, amount, status, reason, created_at')
      .order('created_at', { ascending: false })
      .limit(50),
    supabase.from('daily_reward_claims').select('claim_date').eq('claim_date', today).maybeSingle(),
    supabase.from('platform_settings').select('key, value').in('key', ['daily_reward_amount', 'daily_reward_enabled']),
  ])

  const available = Number(balanceRes.data?.available_balance ?? 0)
  const holds = Number(balanceRes.data?.pending_holds ?? 0)
  const ledger = ledgerRes.data ?? []
  const setting = (k: string, d: string) =>
    String(settingsRes.data?.find((s) => s.key === k)?.value ?? d)
  const rewardEnabled = setting('daily_reward_enabled', 'true') === 'true'
  const rewardAmount = Number(setting('daily_reward_amount', '1'))

  // The claim row uses the PLATFORM's day; this UTC-day read is only a hint
  // for the button state. A stale hint is harmless — the server refuses a
  // double claim regardless, and the error message says why.
  const claimedToday = Boolean(claimRes.data)

  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Credits</h1>

      <section className="mt-6 rounded-xl border border-line bg-surface p-6">
        <p className="text-3xl font-semibold" style={{ color: 'var(--brand-bright)' }}>
          {creditLabel(available)}
        </p>
        {holds < 0 && (
          <p className="mt-1 text-xs text-ink-muted">{creditLabel(holds)} on hold for videos you have open</p>
        )}

        <WalletActions
          claimedToday={claimedToday}
          rewardEnabled={rewardEnabled}
          rewardAmount={rewardAmount}
        />
      </section>

      <section className="mt-6 rounded-xl border border-line bg-surface p-6">
        <h2 className="text-sm font-medium text-ink-secondary">History</h2>
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
    </div>
  )
}
