'use client'

import Link from 'next/link'

import { Dialog } from '@/components/ui/Dialog'
import { creditLabel, episodeLabel, errorLabel } from '@/lib/labels'

/**
 * The coin-unlock confirmation. Deliberately dumb: the caller owns the API
 * call and hands in progress/error state; this renders the price against the
 * viewer's balance (available_balance — committed plus holds, trap #18) and
 * one honest primary action.
 */
export function UnlockDialog({
  open,
  onClose,
  onConfirm,
  episodeNumber,
  seriesTitle,
  cost,
  balance,
  busy,
  errorCode,
}: {
  open: boolean
  onClose: () => void
  onConfirm: () => void
  episodeNumber: number
  seriesTitle: string
  cost: number
  balance: number
  busy: boolean
  errorCode: string | null
}) {
  const short = balance < cost

  return (
    <Dialog open={open} onClose={onClose} labelledBy="unlock-title">
      <h2 id="unlock-title" className="text-lg font-semibold tracking-tight">
        Unlock {episodeLabel(episodeNumber)}
      </h2>
      <p className="mt-1 truncate text-sm text-ink-muted">{seriesTitle}</p>

      <div className="mt-5 flex items-center justify-between rounded-xl border border-line bg-surface p-4">
        <div>
          <p className="text-xs text-ink-muted">Price</p>
          <p className="mt-0.5 text-xl font-semibold tabular-nums">{creditLabel(cost)}</p>
        </div>
        <div className="text-right">
          <p className="text-xs text-ink-muted">Your balance</p>
          <p
            className="mt-0.5 text-xl font-semibold tabular-nums"
            style={{ color: short ? 'var(--danger)' : 'var(--success)' }}
          >
            {creditLabel(balance)}
          </p>
        </div>
      </div>

      {errorCode && <p className="mt-3 text-sm" style={{ color: 'var(--danger)' }}>{errorLabel(errorCode)}</p>}

      <p className="mt-3 text-xs text-ink-faint">
        Once unlocked it’s yours — rewatch, seek and switch devices freely.
      </p>

      <div className="mt-5 flex gap-3">
        <button
          onClick={onClose}
          className="flex-1 rounded-lg border border-line-strong px-4 py-2.5 text-sm text-ink-secondary transition-colors hover:text-ink"
        >
          Not now
        </button>
        {short ? (
          <Link
            href="/profile/wallet"
            className="flex-1 rounded-lg px-4 py-2.5 text-center text-sm font-medium text-white shadow-[var(--shadow-brand)]"
            style={{ background: 'var(--brand-gradient)' }}
          >
            Get coins
          </Link>
        ) : (
          <button
            onClick={onConfirm}
            disabled={busy}
            className="flex-1 rounded-lg px-4 py-2.5 text-sm font-medium text-white shadow-[var(--shadow-brand)] transition-transform enabled:hover:scale-[1.01] disabled:opacity-60"
            style={{ background: 'var(--brand-gradient)' }}
          >
            {busy ? 'Unlocking…' : `Unlock for ${creditLabel(cost)}`}
          </button>
        )}
      </div>
    </Dialog>
  )
}
