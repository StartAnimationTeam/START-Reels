'use client'

import Link from 'next/link'
import { useUser } from '@clerk/nextjs'
import { useEffect, useState } from 'react'

import { onCoinsChanged } from '@/lib/coins'
import { creditLabel } from '@/lib/labels'
import { useSupabase } from '@/lib/supabase-browser'

/**
 * The signed-in user's spendable coin balance — LIVE.
 *
 * A client component since the pivot polish: unlocks and claims happen
 * without a page load, so a server-rendered badge sat stale until the next
 * navigation. Now every value-moving action announces its delta on the
 * coins bus; the badge applies it instantly (optimistic) and then re-reads
 * the truth through RLS, so a mis-guess self-corrects within a beat.
 *
 * Reads `available_balance`, NOT `committed_balance` (CLAUDE.md trap #18):
 * available already nets off outstanding holds, so a user with an episode
 * open never sees coins they cannot actually spend.
 *
 * Renders nothing until a real number arrives — a confident "0 coins"
 * during an outage is worse than no badge, because the user goes looking
 * for coins they actually have.
 */
export function CreditBadge() {
  const { user } = useUser()
  const supabase = useSupabase()
  const [balance, setBalance] = useState<number | null>(null)

  useEffect(() => {
    if (!user || !supabase) return
    let alive = true

    const load = async () => {
      const { data, error } = await supabase
        .from('credit_balances')
        .select('available_balance')
        .eq('credit_type', 'watch')
        .maybeSingle()
      // data === null without error is a brand-new user (no ledger rows yet):
      // a genuine zero. An error renders nothing rather than a wrong number.
      if (alive && !error) setBalance(Number(data?.available_balance ?? 0))
    }

    void load()
    const off = onCoinsChanged((delta) => {
      // Instant feedback first, database truth a beat later.
      setBalance((b) => (b === null ? b : Math.max(0, b + delta)))
      void load()
    })
    return () => {
      alive = false
      off()
    }
  }, [user, supabase])

  if (!user || balance === null) return null

  return (
    <Link
      href="/profile/wallet"
      title="Your spendable coins"
      className="flex items-center gap-1.5 rounded-full border border-line-strong bg-surface-muted px-3 py-1 text-xs font-medium text-ink-secondary transition-colors hover:border-brand hover:text-ink"
    >
      <span
        aria-hidden
        className="h-1.5 w-1.5 rounded-full"
        style={{ background: 'var(--brand)' }}
      />
      <span className="tabular-nums">{creditLabel(balance)}</span>
    </Link>
  )
}
