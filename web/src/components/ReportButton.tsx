'use client'

import { useUser } from '@clerk/nextjs'
import { useState } from 'react'

import { useSupabase } from '@/lib/supabase-browser'

/**
 * "Report" on the watch page — a direct RLS insert (the fourth and last
 * client-writable surface; filing a report moves no value). One open report
 * per user per video is a DB constraint; the duplicate message comes from
 * hitting it, not from client state.
 */

const REASONS: Array<{ value: string; label: string }> = [
  { value: 'inappropriate', label: 'Inappropriate content' },
  { value: 'copyright', label: 'Copyright concern' },
  { value: 'spam', label: 'Spam or misleading' },
  { value: 'wrong_metadata', label: 'Wrong title or description' },
  { value: 'other', label: 'Something else' },
]

export function ReportButton({ videoId }: { videoId: string }) {
  const { user } = useUser()
  const supabase = useSupabase()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('inappropriate')
  const [detail, setDetail] = useState('')
  const [state, setState] = useState<'idle' | 'busy' | 'sent' | 'duplicate' | 'error'>('idle')

  if (!user || !supabase) return null

  if (state === 'sent') {
    return <p className="text-xs text-ink-muted">Thanks — the team will take a look.</p>
  }
  if (state === 'duplicate') {
    return <p className="text-xs text-ink-muted">You’ve already reported this video.</p>
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="text-xs text-ink-faint underline transition-colors hover:text-ink-muted"
      >
        Report this video
      </button>
    )
  }

  const submit = async () => {
    setState('busy')
    const { error } = await supabase.from('video_reports').insert({
      reporter_id: user.id,
      video_id: videoId,
      reason: reason as never,
      detail: detail.trim().slice(0, 1000) || null,
    })
    if (!error) setState('sent')
    else setState(error.code === '23505' ? 'duplicate' : 'error')
  }

  return (
    <div className="mt-2 max-w-md rounded-lg border border-line bg-surface p-3">
      <div className="flex flex-wrap gap-2">
        <select
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="rounded-md border border-line-strong bg-surface-muted px-2 py-1.5 text-xs focus:border-brand focus:outline-none"
          disabled={state === 'busy'}
        >
          {REASONS.map((r) => (
            <option key={r.value} value={r.value}>{r.label}</option>
          ))}
        </select>
        <input
          value={detail}
          onChange={(e) => setDetail(e.target.value)}
          placeholder="Anything the team should know (optional)"
          maxLength={1000}
          className="min-w-0 flex-1 rounded-md border border-line-strong bg-surface-muted px-2 py-1.5 text-xs focus:border-brand focus:outline-none"
          disabled={state === 'busy'}
        />
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={() => void submit()}
          disabled={state === 'busy'}
          className="rounded-md px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
          style={{ background: 'var(--danger)' }}
        >
          Send report
        </button>
        <button
          onClick={() => setOpen(false)}
          className="text-xs text-ink-muted hover:text-ink"
          disabled={state === 'busy'}
        >
          Cancel
        </button>
        {state === 'error' && (
          <span className="text-xs" style={{ color: 'var(--danger)' }}>Couldn’t send — try again.</span>
        )}
      </div>
    </div>
  )
}
