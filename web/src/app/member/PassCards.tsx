'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'

import { ApiError, useApi } from '@/lib/api'
import { errorLabel, MEMBER_TIER_LABELS, pesoLabel } from '@/lib/labels'
import { useSupabase } from '@/lib/supabase-browser'

/**
 * Membership pass purchase — the client half of the QRPh-first rail.
 *
 * Tap a pass → membership-checkout mints a PayMongo hosted session → full
 * redirect to checkout.paymongo.com. The GRANT arrives via webhook (a QR
 * payer may scan from a second phone and never come back), so the return
 * leg (?paid=1) POLLS the membership row until the webhook lands rather
 * than optimistically declaring victory.
 */

const TIERS = [
  { tier: 'weekly' as const, days: 7, blurb: '7 days of unlimited episodes' },
  { tier: 'monthly' as const, days: 30, blurb: '30 days of unlimited episodes' },
  { tier: 'annual' as const, days: 365, blurb: '365 days — the best value' },
]

/** sessionStorage key: the expiry BEFORE checkout — the honest baseline. */
const BASELINE_KEY = 'pm_pass_baseline'

export function PassCards({
  prices,
  methods,
  isMember,
  currentExpiresAt,
}: {
  prices: Record<string, number>
  methods: string[]
  isMember: boolean
  currentExpiresAt: string | null
}) {
  const api = useApi()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const buy = async (tier: 'weekly' | 'monthly' | 'annual') => {
    setBusy(tier)
    setError(null)
    try {
      // Snapshot the pre-payment expiry NOW: the webhook can land before
      // the redirect returns, so a baseline captured on the return page
      // would already include the grant and the confirm poller could
      // never see the change.
      sessionStorage.setItem(BASELINE_KEY, currentExpiresAt ?? '0')
      const { checkoutUrl } = await api.buyMembershipPass(tier)
      window.location.href = checkoutUrl // hosted checkout owns the rest
    } catch (err) {
      setError(err instanceof ApiError ? err.code : 'payment_failed')
      setBusy(null)
    }
  }

  const methodNote = methods
    .map((m) => ({ qrph: 'QR Ph', gcash: 'GCash', paymaya: 'Maya', card: 'Card' })[m] ?? m)
    .join(' · ')

  return (
    <section className="mt-6">
      <h2 className="text-sm font-medium text-ink-secondary">
        {isMember ? 'Add more time' : 'Get a membership pass'}
      </h2>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        {TIERS.map(({ tier, blurb }) => {
          const amount = Number(prices[tier] ?? 0)
          if (amount < 100) return null
          return (
            <button
              key={tier}
              disabled={busy !== null}
              onClick={() => void buy(tier)}
              className="rounded-2xl border border-line bg-surface p-5 text-left transition-colors enabled:hover:border-brand disabled:opacity-60"
            >
              <h3 className="font-semibold">{MEMBER_TIER_LABELS[tier]}</h3>
              <p className="mt-1 text-2xl font-semibold brand-gradient-text">{pesoLabel(amount)}</p>
              <p className="mt-1 text-xs text-ink-muted">{blurb}</p>
              <span
                className="mt-4 block rounded-lg px-4 py-2 text-center text-sm font-medium text-white shadow-[var(--shadow-brand)]"
                style={{ background: 'var(--brand-gradient)' }}
              >
                {busy === tier ? 'Opening checkout…' : 'Get this pass'}
              </span>
            </button>
          )
        })}
      </div>
      <p className="mt-3 text-xs text-ink-muted">
        One-time payment — no auto-renew, no card required. Pay with {methodNote}.
      </p>
      {error && (
        <p className="mt-2 text-sm" style={{ color: 'var(--danger)' }}>
          {errorLabel(error)}
        </p>
      )}
    </section>
  )
}

/**
 * The return leg: PayMongo redirected back with ?paid=1. The webhook may
 * land seconds later — or may have ALREADY landed before the redirect —
 * so the baseline is the sessionStorage snapshot taken when checkout
 * STARTED, not anything rendered after payment. Poll the (RLS-scoped,
 * own-row) membership until expires_at moves past that snapshot, then
 * refresh. Honest timeout if it drags.
 */
export function PassConfirm({ baselineExpiresAt }: { baselineExpiresAt: string | null }) {
  const supabase = useSupabase()
  const router = useRouter()
  const [state, setState] = useState<'waiting' | 'done' | 'slow'>('waiting')
  const tries = useRef(0)

  useEffect(() => {
    if (!supabase) return
    // Pre-checkout snapshot first; the server-rendered value only as a
    // fallback (e.g. the user opened ?paid=1 in a fresh tab).
    const stored = sessionStorage.getItem(BASELINE_KEY)
    const baseline = stored !== null
      ? (stored === '0' ? 0 : Date.parse(stored))
      : baselineExpiresAt ? Date.parse(baselineExpiresAt) : 0

    let timer: ReturnType<typeof setInterval> | null = null
    const check = async () => {
      tries.current += 1
      const { data } = await supabase.from('memberships').select('expires_at').maybeSingle()
      const current = data ? Date.parse(data.expires_at) : 0
      if (current > baseline && current > Date.now()) {
        if (timer) clearInterval(timer)
        sessionStorage.removeItem(BASELINE_KEY)
        setState('done')
        router.refresh()
        return
      }
      if (tries.current >= 20 && timer) {
        clearInterval(timer)
        setState('slow')
      }
    }
    void check() // the webhook often wins the race — resolve immediately
    timer = setInterval(check, 3000)
    return () => {
      if (timer) clearInterval(timer)
    }
  }, [supabase, baselineExpiresAt, router])

  if (state === 'done') return null
  return (
    <p
      className="mt-4 rounded-xl border px-4 py-3 text-sm"
      style={
        state === 'waiting'
          ? { borderColor: 'var(--brand)', color: 'var(--ink)' }
          : { borderColor: 'var(--warning)', color: 'var(--warning)' }
      }
    >
      {state === 'waiting'
        ? 'Payment received — activating your pass… this usually takes a few seconds.'
        : 'Your payment is confirmed but activation is taking longer than usual. Refresh this page in a minute — your pass will be here.'}
    </p>
  )
}
