'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { useAdminApi } from '@/lib/admin'
import { errorLabel } from '@/lib/labels'

/**
 * Per-user actions. Admin-only controls render only for admins — but that is
 * UX, not security: admin-users re-verifies the caller's role from user_roles
 * on every request, so a tampered client changes pixels, nothing else.
 *
 * A permission boundary must SAY SO (CLAUDE.md trap #15): moderators see the
 * admin-only controls as labeled-disabled, not missing — a control that
 * silently isn't there reads as a broken page.
 */
export function UserActions({
  userId,
  roles,
  suspended,
  banned,
  viewerIsAdmin,
}: {
  userId: string
  roles: string[]
  suspended: boolean
  banned: boolean
  viewerIsAdmin: boolean
}) {
  const api = useAdminApi()
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [grantOpen, setGrantOpen] = useState(false)
  const [amount, setAmount] = useState(10)

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
      setGrantOpen(false)
    }
  }

  const button =
    'rounded-md border border-line-strong px-2.5 py-1 text-xs text-ink-secondary transition-colors enabled:hover:border-brand enabled:hover:text-ink disabled:opacity-40'
  const adminOnly = !viewerIsAdmin
  const adminTitle = adminOnly ? 'Administrator only' : undefined

  const isCreator = roles.includes('creator')
  const isModerator = roles.includes('moderator')

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {/* moderation: staff */}
      {!banned && (suspended ? (
        <button disabled={busy} className={button} onClick={() => void run(() => api.user('unsuspend', userId))}>
          Unsuspend
        </button>
      ) : (
        <button
          disabled={busy}
          className={button}
          onClick={() => void run(() => api.user('suspend', userId, { reason: 'Suspended by staff' }))}
        >
          Suspend
        </button>
      ))}

      {/* admin only from here down */}
      {banned ? (
        <button disabled={busy || adminOnly} title={adminTitle} className={button}
          onClick={() => void run(() => api.user('unban', userId))}>
          Unban
        </button>
      ) : (
        <button disabled={busy || adminOnly} title={adminTitle} className={button}
          onClick={() => void run(() => api.user('ban', userId, { reason: 'Banned by administrator' }))}>
          Ban
        </button>
      )}

      <button disabled={busy || adminOnly} title={adminTitle} className={button}
        onClick={() => void run(() => api.user('set_role', userId, { role: 'creator', grant: !isCreator }))}>
        {isCreator ? '− Creator' : '+ Creator'}
      </button>
      <button disabled={busy || adminOnly} title={adminTitle} className={button}
        onClick={() => void run(() => api.user('set_role', userId, { role: 'moderator', grant: !isModerator }))}>
        {isModerator ? '− Moderator' : '+ Moderator'}
      </button>

      {!grantOpen ? (
        <button disabled={busy || adminOnly} title={adminTitle} className={button} onClick={() => setGrantOpen(true)}>
          Credits…
        </button>
      ) : (
        <span className="flex items-center gap-1">
          <input
            type="number"
            min={1}
            max={1000}
            value={amount}
            onChange={(e) => setAmount(Number(e.target.value))}
            className="w-16 rounded-md border border-line-strong bg-surface-muted px-2 py-1 text-xs focus:border-brand focus:outline-none"
          />
          <button disabled={busy} className={button}
            onClick={() => void run(() => api.user('grant_credits', userId, { amount }))}>
            Grant
          </button>
          <button disabled={busy} className={button}
            onClick={() => void run(() => api.user('deduct_credits', userId, { amount }))}>
            Deduct
          </button>
        </span>
      )}

      {error && <span className="text-xs" style={{ color: 'var(--danger)' }}>{errorLabel(error)}</span>}
    </div>
  )
}
