'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { useSupabase } from '@/lib/supabase-browser'
import { creditLabel, errorLabel } from '@/lib/labels'

/**
 * Daily claim + promo redemption. Both call PostgREST RPCs directly — the
 * functions take no user id (identity is the JWT), so there is no Edge
 * Function in the way. Every rule lives server-side; this component reports
 * outcomes.
 */
export function WalletActions({
  claimedToday,
  rewardEnabled,
  rewardAmount,
}: {
  claimedToday: boolean
  rewardEnabled: boolean
  rewardAmount: number
}) {
  const supabase = useSupabase()
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [code, setCode] = useState('')

  if (!supabase) return null

  const claim = async () => {
    setBusy(true)
    setMessage(null)
    const { data, error } = await supabase.rpc('claim_daily_reward')
    if (error) {
      setMessage({ ok: false, text: errorLabel(error.message) })
    } else {
      setMessage({ ok: true, text: `Claimed ${creditLabel(Number(data?.claimed ?? rewardAmount))} — see you tomorrow.` })
      router.refresh()
    }
    setBusy(false)
  }

  const redeem = async () => {
    if (!code.trim()) return
    setBusy(true)
    setMessage(null)
    const { data, error } = await supabase.rpc('redeem_promo', { p_code: code.trim() })
    if (error) {
      setMessage({ ok: false, text: errorLabel(error.message) })
    } else {
      setMessage({ ok: true, text: `“${data?.name}” added ${creditLabel(Number(data?.granted ?? 0))}.` })
      setCode('')
      router.refresh()
    }
    setBusy(false)
  }

  return (
    <div className="mt-5 space-y-4">
      {rewardEnabled && (
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={() => void claim()}
            disabled={busy || claimedToday}
            className="rounded-lg px-4 py-2 text-sm font-medium text-white shadow-[var(--shadow-brand)] transition-transform enabled:hover:scale-[1.02] disabled:opacity-40"
            style={{ background: 'var(--brand-gradient)' }}
          >
            {claimedToday ? 'Claimed today ✓' : `Claim today’s ${creditLabel(rewardAmount)}`}
          </button>
          {!claimedToday && (
            <span className="text-xs text-ink-muted">Free credits, once a day.</span>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="Promo code"
          maxLength={32}
          className="rounded-lg border border-line-strong bg-surface-muted px-3 py-2 text-sm uppercase tracking-wide placeholder:normal-case placeholder:tracking-normal focus:border-brand focus:outline-none"
          disabled={busy}
          onKeyDown={(e) => e.key === 'Enter' && void redeem()}
        />
        <button
          onClick={() => void redeem()}
          disabled={busy || !code.trim()}
          className="rounded-lg border border-line-strong px-4 py-2 text-sm text-ink-secondary transition-colors enabled:hover:border-brand enabled:hover:text-ink disabled:opacity-40"
        >
          Redeem
        </button>
      </div>

      {message && (
        <p className="text-sm" style={{ color: message.ok ? 'var(--success)' : 'var(--danger)' }}>
          {message.text}
        </p>
      )}
    </div>
  )
}
