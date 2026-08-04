import { LEDGER_REASON_LABELS, LEDGER_STATUS_LABELS } from '@/lib/labels'

export interface LedgerRow {
  id: string
  amount: number
  status: string
  reason: string
  created_at: string
}

/**
 * The coin-activity list — one rendering of the ledger for every surface
 * (profile hub, wallet), so reason labels, hold badges and the +/- colouring
 * can never drift apart.
 */
export function LedgerList({ rows }: { rows: LedgerRow[] }) {
  if (rows.length === 0) {
    return <p className="mt-3 text-sm text-ink-muted">Nothing yet.</p>
  }

  return (
    <ul className="mt-4 divide-y divide-[var(--border)]">
      {rows.map((row) => (
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
  )
}
