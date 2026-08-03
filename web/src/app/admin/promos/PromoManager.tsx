'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { useAdminApi } from '@/lib/admin'
import { errorLabel } from '@/lib/labels'

interface CampaignRow {
  id: string
  code: string
  name: string
  amount: number
  per_user_limit: number
  max_redemptions: number | null
  is_active: boolean
  ends_at: string | null
  used: number
}

export function PromoManager({ campaigns }: { campaigns: CampaignRow[] }) {
  const api = useAdminApi()
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [amount, setAmount] = useState(10)
  const [maxRedemptions, setMaxRedemptions] = useState<string>('')

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown_error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* ── create ─────────────────────────────────────────────────────── */}
      <div className="rounded-xl border border-line bg-surface p-4">
        <h3 className="text-sm font-medium text-ink-secondary">New campaign</h3>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs text-ink-muted" htmlFor="promo-code">Code</label>
            <input
              id="promo-code"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, ''))}
              placeholder="LAUNCH-25"
              maxLength={32}
              className="mt-1 w-40 rounded-lg border border-line-strong bg-surface-muted px-3 py-2 text-sm uppercase focus:border-brand focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-xs text-ink-muted" htmlFor="promo-name">Name</label>
            <input
              id="promo-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Launch bonus"
              maxLength={120}
              className="mt-1 w-48 rounded-lg border border-line-strong bg-surface-muted px-3 py-2 text-sm focus:border-brand focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-xs text-ink-muted" htmlFor="promo-amount">Credits</label>
            <input
              id="promo-amount"
              type="number" min={1} max={1000}
              value={amount}
              onChange={(e) => setAmount(Number(e.target.value))}
              className="mt-1 w-24 rounded-lg border border-line-strong bg-surface-muted px-3 py-2 text-sm focus:border-brand focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-xs text-ink-muted" htmlFor="promo-max">Max uses <span className="text-ink-faint">(blank = unlimited)</span></label>
            <input
              id="promo-max"
              type="number" min={1}
              value={maxRedemptions}
              onChange={(e) => setMaxRedemptions(e.target.value)}
              className="mt-1 w-28 rounded-lg border border-line-strong bg-surface-muted px-3 py-2 text-sm focus:border-brand focus:outline-none"
            />
          </div>
          <button
            disabled={busy || code.length < 3 || !name.trim() || amount < 1}
            onClick={() =>
              void run(() =>
                api.platform('create_promo', {
                  code,
                  name: name.trim(),
                  amount,
                  maxRedemptions: maxRedemptions ? Number(maxRedemptions) : null,
                }),
              ).then(() => {
                setCode(''); setName(''); setAmount(10); setMaxRedemptions('')
              })
            }
            className="rounded-lg px-4 py-2 text-sm font-medium text-white shadow-[var(--shadow-brand)] disabled:opacity-40"
            style={{ background: 'var(--brand-gradient)' }}
          >
            Create
          </button>
        </div>
        {error && <p className="mt-2 text-xs" style={{ color: 'var(--danger)' }}>{errorLabel(error)}</p>}
      </div>

      {/* ── list ───────────────────────────────────────────────────────── */}
      {campaigns.length === 0 ? (
        <p className="text-sm text-ink-muted">No campaigns yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-line bg-surface text-left text-xs text-ink-muted">
                <th className="px-4 py-2.5 font-medium">Code</th>
                <th className="px-4 py-2.5 font-medium">Name</th>
                <th className="px-4 py-2.5 font-medium">Credits</th>
                <th className="px-4 py-2.5 font-medium">Used</th>
                <th className="px-4 py-2.5 font-medium">State</th>
                <th className="px-4 py-2.5 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {campaigns.map((campaign) => (
                <tr key={campaign.id} className="bg-background">
                  <td className="px-4 py-2.5 font-mono text-xs text-ink">{campaign.code}</td>
                  <td className="px-4 py-2.5 text-ink-secondary">{campaign.name}</td>
                  <td className="px-4 py-2.5 tabular-nums text-ink-secondary">{campaign.amount}</td>
                  <td className="px-4 py-2.5 tabular-nums text-ink-secondary">
                    {campaign.used}{campaign.max_redemptions ? ` / ${campaign.max_redemptions}` : ''}
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className="rounded-full border px-2 py-0.5 text-xs"
                      style={
                        campaign.is_active
                          ? { color: 'var(--success)', borderColor: 'var(--success)' }
                          : { color: 'var(--text-faint)', borderColor: 'var(--border-strong)' }
                      }
                    >
                      {campaign.is_active ? 'active' : 'off'}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <button
                      disabled={busy}
                      onClick={() =>
                        void run(() =>
                          api.platform('set_promo_active', {
                            campaignId: campaign.id,
                            active: !campaign.is_active,
                          }),
                        )
                      }
                      className="rounded-md border border-line-strong px-2.5 py-1 text-xs text-ink-secondary enabled:hover:border-brand enabled:hover:text-ink disabled:opacity-40"
                    >
                      {campaign.is_active ? 'Deactivate' : 'Activate'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
