'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { useAdminApi } from '@/lib/admin'
import { errorLabel } from '@/lib/labels'

interface Values {
  maintenance_mode: boolean
  signup_grant_credits: number
  daily_reward_enabled: boolean
  daily_reward_amount: number
  entitlement_window_hours: number
  settle_after_seconds: number
  max_concurrent_streams: number
}

const NUMBERS: Array<{ key: keyof Values; label: string; hint: string; min: number; max: number }> = [
  { key: 'signup_grant_credits', label: 'Signup grant', hint: 'Credits a new account starts with', min: 0, max: 100 },
  { key: 'daily_reward_amount', label: 'Daily reward', hint: 'Credits per daily claim', min: 0, max: 20 },
  { key: 'entitlement_window_hours', label: 'Unlock window (hours)', hint: 'How long a paid unlock lasts', min: 1, max: 720 },
  { key: 'settle_after_seconds', label: 'Settle threshold (seconds)', hint: 'Validated watch time before a hold commits', min: 5, max: 600 },
  { key: 'max_concurrent_streams', label: 'Concurrent streams', hint: 'Live sessions per unlock', min: 1, max: 10 },
]

export function SettingsPanel({ initial }: { initial: Values }) {
  const api = useAdminApi()
  const router = useRouter()
  const [values, setValues] = useState<Values>(initial)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [savedKey, setSavedKey] = useState<string | null>(null)

  // Per-field save: each key is its own audited mutation, so the audit trail
  // reads "settings.updated daily_reward_amount 1 -> 2", not one opaque blob.
  const save = async (key: keyof Values, value: boolean | number) => {
    setBusy(key)
    setError(null)
    setSavedKey(null)
    try {
      await api.platform('update_setting', { key, value })
      setSavedKey(key)
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown_error')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-5">
      {/* ── maintenance: the big red switch gets its own visual weight ──── */}
      <div
        className="rounded-xl border p-4"
        style={
          values.maintenance_mode
            ? { borderColor: 'var(--warning)', background: 'rgb(255 190 92 / 0.06)' }
            : { borderColor: 'var(--border)', background: 'var(--surface)' }
        }
      >
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-ink">Maintenance mode</p>
            <p className="mt-0.5 text-xs text-ink-muted">
              Blocks unlocking and playback for everyone except staff. Browsing stays up so the
              banner can explain.
            </p>
          </div>
          <button
            disabled={busy === 'maintenance_mode'}
            onClick={() => {
              const next = !values.maintenance_mode
              setValues({ ...values, maintenance_mode: next })
              void save('maintenance_mode', next)
            }}
            className="rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
            style={{ background: values.maintenance_mode ? 'var(--warning)' : 'var(--brand-gradient)' }}
          >
            {values.maintenance_mode ? 'Turn OFF' : 'Turn on'}
          </button>
        </div>
      </div>

      <div
        className="rounded-xl border border-line bg-surface p-4"
      >
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-ink">Daily rewards</p>
            <p className="mt-0.5 text-xs text-ink-muted">The once-a-day free credit claim.</p>
          </div>
          <button
            disabled={busy === 'daily_reward_enabled'}
            onClick={() => {
              const next = !values.daily_reward_enabled
              setValues({ ...values, daily_reward_enabled: next })
              void save('daily_reward_enabled', next)
            }}
            className="rounded-lg border border-line-strong px-4 py-2 text-sm text-ink-secondary hover:border-brand hover:text-ink disabled:opacity-40"
          >
            {values.daily_reward_enabled ? 'Enabled — turn off' : 'Disabled — turn on'}
          </button>
        </div>
      </div>

      {NUMBERS.map((field) => (
        <div key={field.key} className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface p-4">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-ink">{field.label}</p>
            <p className="mt-0.5 text-xs text-ink-muted">{field.hint}</p>
          </div>
          <input
            type="number"
            min={field.min}
            max={field.max}
            value={Number(values[field.key])}
            onChange={(e) => setValues({ ...values, [field.key]: Number(e.target.value) })}
            className="w-24 rounded-lg border border-line-strong bg-surface-muted px-3 py-2 text-sm tabular-nums focus:border-brand focus:outline-none"
          />
          <button
            disabled={busy === field.key}
            onClick={() => void save(field.key, Number(values[field.key]))}
            className="rounded-md border border-line-strong px-3 py-1.5 text-xs text-ink-secondary enabled:hover:border-brand enabled:hover:text-ink disabled:opacity-40"
          >
            {savedKey === field.key ? 'Saved ✓' : 'Save'}
          </button>
        </div>
      ))}

      {error && <p className="text-sm" style={{ color: 'var(--danger)' }}>{errorLabel(error)}</p>}
    </div>
  )
}
