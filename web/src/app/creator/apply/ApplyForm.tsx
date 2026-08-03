'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { useSupabase } from '@/lib/supabase-browser'

/**
 * Direct RLS insert — creator_applications is client-writable for exactly
 * (user_id, bio, portfolio_url) with WITH CHECK pinning user_id to the
 * caller and status to its 'pending' default. The partial unique index
 * (one open application per user) is the duplicate guard; no value moves.
 */
export function ApplyForm({ userId }: { userId: string }) {
  const supabase = useSupabase()
  const router = useRouter()
  const [bio, setBio] = useState('')
  const [portfolio, setPortfolio] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!supabase) return null

  const submit = async () => {
    if (!bio.trim()) {
      setError('Tell the team at least a little about yourself.')
      return
    }
    setBusy(true)
    setError(null)

    const { error: insertErr } = await supabase.from('creator_applications').insert({
      user_id: userId,
      bio: bio.trim().slice(0, 2000),
      portfolio_url: portfolio.trim().slice(0, 500) || null,
    })

    if (insertErr) {
      // 23505 = the partial unique index: an open application already exists.
      setError(
        insertErr.code === '23505'
          ? 'You already have an application under review.'
          : 'Couldn’t submit. Try again in a moment.',
      )
      setBusy(false)
      return
    }
    router.push('/creator')
    router.refresh()
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="text-sm font-medium text-ink-secondary" htmlFor="app-bio">
          About you and what you’d publish
        </label>
        <textarea
          id="app-bio"
          value={bio}
          onChange={(e) => setBio(e.target.value)}
          rows={5}
          maxLength={2000}
          className="mt-1 w-full rounded-lg border border-line-strong bg-surface-muted px-3 py-2 text-sm focus:border-brand focus:outline-none"
          disabled={busy}
        />
      </div>
      <div>
        <label className="text-sm font-medium text-ink-secondary" htmlFor="app-url">
          Portfolio or showreel link <span className="text-ink-faint">(optional)</span>
        </label>
        <input
          id="app-url"
          type="url"
          value={portfolio}
          onChange={(e) => setPortfolio(e.target.value)}
          placeholder="https://…"
          className="mt-1 w-full rounded-lg border border-line-strong bg-surface-muted px-3 py-2 text-sm focus:border-brand focus:outline-none"
          disabled={busy}
        />
      </div>

      {error && <p className="text-sm" style={{ color: 'var(--danger)' }}>{error}</p>}

      <button
        onClick={() => void submit()}
        disabled={busy || !bio.trim()}
        className="rounded-lg px-5 py-2.5 text-sm font-medium text-white shadow-[var(--shadow-brand)] transition-transform enabled:hover:scale-[1.02] disabled:opacity-40"
        style={{ background: 'var(--brand-gradient)' }}
      >
        Submit application
      </button>
    </div>
  )
}
