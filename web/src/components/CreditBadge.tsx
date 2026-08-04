import Link from 'next/link'
import { auth } from '@clerk/nextjs/server'

import { createServerSupabase } from '@/lib/supabase-server'
import { creditLabel } from '@/lib/labels'

/**
 * The signed-in user's spendable credit balance.
 *
 * Reads `available_balance`, NOT `committed_balance` (CLAUDE.md trap #18):
 * available already nets off outstanding holds, so a user who has two videos
 * open never sees credits they cannot actually spend.
 *
 * This is also the Phase 0 end-to-end proof. If it renders a real number, then
 * Clerk issued a JWT, Supabase accepted it as a third-party issuer, and the
 * `credit_ledger_select_own` RLS policy matched on `auth.jwt()->>'sub'`. The
 * whole auth chain is working.
 */
export async function CreditBadge() {
  const { userId } = await auth()
  if (!userId) return null

  let balance: number | null = null

  try {
    const supabase = await createServerSupabase()
    const { data, error } = await supabase
      .from('credit_balances')
      .select('available_balance')
      .eq('credit_type', 'watch')
      .maybeSingle()

    // `error` here means the query failed. `data === null` means RLS returned
    // nothing — which for a brand-new user is correct and normal (no ledger
    // rows yet, so no balance row). Those two cases are NOT the same and must
    // not be collapsed: an empty read is also what a BROKEN Clerk↔Supabase
    // integration looks like. scripts/test-rls.mjs is what distinguishes them.
    if (!error) balance = Number(data?.available_balance ?? 0)
  } catch {
    // Supabase unconfigured or unreachable. Render nothing rather than a zero —
    // a confident "0 credits" during an outage is worse than no badge at all,
    // because the user will go looking for credits they actually have.
    return null
  }

  if (balance === null) return null

  return (
    <Link
      href="/profile/wallet"
      title="Your spendable credits"
      className="flex items-center gap-1.5 rounded-full border border-line-strong bg-surface-muted px-3 py-1 text-xs font-medium text-ink-secondary transition-colors hover:border-brand hover:text-ink"
    >
      <span
        aria-hidden
        className="h-1.5 w-1.5 rounded-full"
        style={{ background: 'var(--brand)' }}
      />
      {creditLabel(balance)}
    </Link>
  )
}
