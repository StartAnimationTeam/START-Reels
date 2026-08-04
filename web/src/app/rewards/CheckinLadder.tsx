'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { announceCoinsDelta } from '@/lib/coins'
import { useSupabase } from '@/lib/supabase-browser'
import { creditLabel, errorLabel } from '@/lib/labels'

/**
 * The 7-tile check-in ladder + claim button. All rules live in
 * claim_daily_reward (0020) — streak continuation, gap reset, day-8 cycling,
 * platform-timezone days; this renders the tiles and reports the outcome.
 */
export function CheckinLadder({
  ladder,
  cyclePos,
  claimedToday,
  streakNow,
  enabled,
}: {
  ladder: number[]
  /** 0-based position in the current 7-day cycle. */
  cyclePos: number
  claimedToday: boolean
  streakNow: number
  enabled: boolean
}) {
  const supabase = useSupabase()
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  if (!supabase) return null

  const claim = async () => {
    setBusy(true)
    setMessage(null)
    const { data, error } = await supabase.rpc('claim_daily_reward')
    if (error) {
      setMessage({ ok: false, text: errorLabel(error.message) })
    } else {
      setMessage({
        ok: true,
        text: `Day ${data?.streak_day}: ${creditLabel(Number(data?.claimed ?? 0))} claimed — tomorrow pays ${creditLabel(Number(data?.next_amount ?? 0))}.`,
      })
      announceCoinsDelta(Number(data?.claimed ?? 0))
      router.refresh()
    }
    setBusy(false)
  }

  return (
    <div className="rounded-2xl border border-line bg-surface p-5">
      <p className="text-sm text-ink-secondary">
        {claimedToday
          ? `You’ve checked in for ${streakNow} ${streakNow === 1 ? 'day' : 'days'}!`
          : streakNow > 1
            ? `Check in to keep your ${streakNow - 1}-day streak going`
            : 'Check in daily — rewards climb all week'}
      </p>

      <div className="mt-4 grid grid-cols-7 gap-1.5">
        {ladder.map((amount, i) => {
          const done = i < cyclePos || (i === cyclePos && claimedToday)
          const today = i === cyclePos
          return (
            <div
              key={i}
              aria-current={today ? 'date' : undefined}
              className={`flex flex-col items-center gap-1 rounded-lg border px-1 py-2.5 text-center ${
                today && !claimedToday
                  ? 'border-transparent shadow-[var(--shadow-brand)]'
                  : 'border-line bg-surface-muted'
              }`}
              style={today && !claimedToday ? { background: 'var(--brand-gradient)' } : undefined}
            >
              <span className={`text-xs font-semibold tabular-nums ${today && !claimedToday ? 'text-white' : 'text-ink'}`}>
                +{amount}
              </span>
              <span aria-hidden className="text-sm leading-none">{done ? '✓' : '🪙'}</span>
              <span className={`text-[10px] ${today && !claimedToday ? 'text-white/85' : 'text-ink-muted'}`}>
                {today ? 'Today' : `Day ${i + 1}`}
              </span>
            </div>
          )
        })}
      </div>

      {enabled ? (
        <button
          onClick={() => void claim()}
          disabled={busy || claimedToday}
          className="mt-5 w-full rounded-lg px-4 py-3 text-sm font-semibold text-white shadow-[var(--shadow-brand)] transition-transform enabled:hover:scale-[1.01] disabled:opacity-40"
          style={{ background: 'var(--brand-gradient)' }}
        >
          {claimedToday
            ? 'Checked in today ✓'
            : busy
              ? 'Claiming…'
              : `Check in for ${creditLabel(ladder[cyclePos] ?? 1)}`}
        </button>
      ) : (
        // The boundary says so (trap #15) rather than a button that no-ops.
        <p className="mt-5 text-sm text-ink-muted">Daily rewards are paused right now.</p>
      )}

      {message && (
        <p className="mt-3 text-sm" style={{ color: message.ok ? 'var(--success)' : 'var(--danger)' }}>
          {message.text}
        </p>
      )}
    </div>
  )
}
