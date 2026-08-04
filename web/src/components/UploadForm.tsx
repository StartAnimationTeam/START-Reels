'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { useAdminApi } from '@/lib/admin'
import { uploadToBunny } from '@/lib/upload'
import { errorLabel } from '@/lib/labels'
import type { AccessTier } from '@/lib/database.types'

/**
 * TUS upload straight to Bunny. The bytes NEVER touch Vercel or Supabase —
 * serverless bodies cap at ~4.5MB, so a route-handler upload isn't slow, it
 * is impossible (CLAUDE.md trap #5). video-upload mints the row + the TUS
 * authorization; this component moves the bytes and shows honest progress.
 *
 * Bunny's TUS endpoint authenticates per-request with the signature headers
 * and metadata carries the video GUID (filetype/title per their spec).
 */

type Phase =
  | { kind: 'form' }
  | { kind: 'uploading'; pct: number }
  | { kind: 'processing' }
  | { kind: 'error'; code: string; detail?: string }

const TIERS: Array<{ tier: AccessTier; label: string; costs: number[] }> = [
  { tier: 'free', label: 'Free', costs: [0] },
  { tier: 'premium', label: 'Premium — 1 credit', costs: [1] },
  { tier: 'exclusive', label: 'Exclusive — 2 to 5 credits', costs: [2, 3, 4, 5] },
]

export function UploadForm({
  redirectTo = '/admin/videos',
  reviewNotice = false,
}: {
  /** Where to land after the bytes are with Bunny. */
  redirectTo?: string
  /** Creator context: their upload goes to review, and the UI says so. */
  reviewNotice?: boolean
}) {
  const api = useAdminApi()
  const router = useRouter()

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [tier, setTier] = useState<AccessTier>('free')
  const [cost, setCost] = useState(0)
  const [file, setFile] = useState<File | null>(null)
  const [phase, setPhase] = useState<Phase>({ kind: 'form' })

  const start = async () => {
    if (!file || !title.trim()) return
    setPhase({ kind: 'uploading', pct: 0 })

    let ticket
    try {
      ticket = await api.createUpload({
        title: title.trim(),
        description: description.trim() || undefined,
        accessTier: tier,
        creditCost: cost,
      })
    } catch (err) {
      setPhase({ kind: 'error', code: err instanceof Error ? err.message : 'upload_create_failed' })
      return
    }

    if (file.size > ticket.upload.maxBytes) {
      setPhase({ kind: 'error', code: 'upload_too_large' })
      return
    }

    try {
      await uploadToBunny(file, ticket, (pct) => setPhase({ kind: 'uploading', pct }))
    } catch (err) {
      setPhase({ kind: 'error', code: 'upload_failed', detail: err instanceof Error ? err.message : undefined })
      return
    }

    // Bytes are with Bunny. From here the pipeline is autonomous:
    // transcode → webhook → published (staff) or pending_review (creator).
    setPhase({ kind: 'processing' })
    setTimeout(() => router.push(redirectTo), 1800)
  }

  if (phase.kind === 'processing') {
    return (
      <div className="rounded-xl border border-line bg-surface p-6 text-sm">
        <p className="font-medium text-ink">Upload complete — transcoding started.</p>
        <p className="mt-1 text-ink-muted">
          {reviewNotice
            ? 'When encoding finishes it goes to the moderation queue — you’ll see its status on your dashboard.'
            : 'The video will publish itself when encoding finishes. Redirecting to the videos table…'}
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="text-sm font-medium text-ink-secondary" htmlFor="up-title">Title</label>
        <input
          id="up-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={200}
          className="mt-1 w-full rounded-lg border border-line-strong bg-surface-muted px-3 py-2 text-sm focus:border-brand focus:outline-none"
          disabled={phase.kind === 'uploading'}
        />
      </div>

      <div>
        <label className="text-sm font-medium text-ink-secondary" htmlFor="up-desc">Description</label>
        <textarea
          id="up-desc"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          maxLength={5000}
          className="mt-1 w-full rounded-lg border border-line-strong bg-surface-muted px-3 py-2 text-sm focus:border-brand focus:outline-none"
          disabled={phase.kind === 'uploading'}
        />
      </div>

      <div className="flex flex-wrap gap-4">
        <div>
          <label className="text-sm font-medium text-ink-secondary" htmlFor="up-tier">Access</label>
          <select
            id="up-tier"
            value={tier}
            onChange={(e) => {
              const next = e.target.value as AccessTier
              setTier(next)
              setCost(TIERS.find((t) => t.tier === next)!.costs[0])
            }}
            className="mt-1 block rounded-lg border border-line-strong bg-surface-muted px-3 py-2 text-sm focus:border-brand focus:outline-none"
            disabled={phase.kind === 'uploading'}
          >
            {TIERS.map((t) => (
              <option key={t.tier} value={t.tier}>{t.label}</option>
            ))}
          </select>
        </div>

        {tier === 'exclusive' && (
          <div>
            <label className="text-sm font-medium text-ink-secondary" htmlFor="up-cost">Credits</label>
            <select
              id="up-cost"
              value={cost}
              onChange={(e) => setCost(Number(e.target.value))}
              className="mt-1 block rounded-lg border border-line-strong bg-surface-muted px-3 py-2 text-sm focus:border-brand focus:outline-none"
              disabled={phase.kind === 'uploading'}
            >
              {[2, 3, 4, 5].map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div>
        <label className="text-sm font-medium text-ink-secondary" htmlFor="up-file">Video file</label>
        <input
          id="up-file"
          type="file"
          accept="video/*"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="mt-1 block w-full text-sm text-ink-secondary file:mr-3 file:rounded-lg file:border-0 file:bg-surface-brand file:px-4 file:py-2 file:text-sm file:text-ink"
          disabled={phase.kind === 'uploading'}
        />
      </div>

      {phase.kind === 'uploading' && (
        <div>
          <div className="h-2 overflow-hidden rounded-full bg-surface-muted">
            <div
              className="h-full transition-[width]"
              style={{ width: `${phase.pct}%`, background: 'var(--brand-gradient)' }}
            />
          </div>
          <p className="mt-1 text-xs tabular-nums text-ink-muted">{phase.pct}% — resumable; a dropped connection picks up here</p>
        </div>
      )}

      {phase.kind === 'error' && (
        <p className="text-sm" style={{ color: 'var(--danger)' }}>
          {errorLabel(phase.code)}
          {phase.detail ? <span className="block text-xs text-ink-muted">{phase.detail}</span> : null}
        </p>
      )}

      <button
        onClick={() => void start()}
        disabled={!file || !title.trim() || phase.kind === 'uploading'}
        className="rounded-lg px-5 py-2.5 text-sm font-medium text-white shadow-[var(--shadow-brand)] transition-transform enabled:hover:scale-[1.02] disabled:opacity-40"
        style={{ background: 'var(--brand-gradient)' }}
      >
        {phase.kind === 'uploading' ? 'Uploading…' : 'Upload'}
      </button>
    </div>
  )
}
