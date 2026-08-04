'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'

import { useAdminApi, type UploadTicket } from '@/lib/admin'
import { uploadToBunny } from '@/lib/upload'
import { episodeLabel, errorLabel } from '@/lib/labels'

/**
 * The multi-file episode queue. Pick a whole season; files upload STRICTLY
 * one at a time:
 *
 *   1. ticket = createUpload({ title, seriesId })   ← server assigns EP max+1
 *   2. TUS bytes straight to Bunny (resumable)
 *   3. next file
 *
 * Sequencing is correctness, not politeness: episode auto-numbering reads
 * max+1 per ticket, so tickets must never be minted concurrently. Tier and
 * cost are the SERIES' business — nothing to choose here.
 *
 * On failure the queue HALTS. Retry re-runs the same ticket (the tus
 * fingerprint resumes a half-sent file); Skip abandons the row (its draft
 * keeps the number — a gap in numbering, cleanable from /admin/videos).
 * Encoding publishes finished episodes automatically via the webhook.
 */

interface QueueItem {
  key: string
  file: File
  title: string
  status: 'pending' | 'creating' | 'uploading' | 'done' | 'error' | 'skipped'
  pct: number
  episodeNumber?: number
  ticket?: UploadTicket
  errorCode?: string
  errorDetail?: string
}

export function EpisodeQueue({
  seriesId,
  seriesTitle,
  maxBytes,
  seriesRemoved,
}: {
  seriesId: string
  seriesTitle: string
  maxBytes: number
  seriesRemoved: boolean
}) {
  const api = useAdminApi()
  const router = useRouter()
  const [items, setItems] = useState<QueueItem[]>([])
  const [running, setRunning] = useState(false)
  const [rejectedNote, setRejectedNote] = useState<string | null>(null)
  // The loop reads latest state through a ref — setState alone would leave
  // it iterating a stale array.
  const itemsRef = useRef(items)
  itemsRef.current = items

  // Leaving mid-upload abandons a TUS stream; warn like every uploader does.
  useEffect(() => {
    if (!running) return
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [running])

  const patch = (key: string, changes: Partial<QueueItem>) =>
    setItems((list) => list.map((it) => (it.key === key ? { ...it, ...changes } : it)))

  const addFiles = (files: FileList | null) => {
    if (!files?.length) return
    const accepted: QueueItem[] = []
    const rejected: string[] = []
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('video/')) rejected.push(`${file.name} (not a video)`)
      else if (file.size > maxBytes) rejected.push(`${file.name} (over the size limit)`)
      else
        accepted.push({
          key: `${file.name}:${file.size}:${crypto.randomUUID().slice(0, 8)}`,
          file,
          // Empty = AUTO: the server names it "<series title> - EP<n>" the
          // moment the number is assigned. Typing here overrides.
          title: '',
          status: 'pending',
          pct: 0,
        })
    }
    // Selection order is upload order is episode order — sort by name so a
    // folder of ep01…ep50 numbers itself correctly regardless of pick order.
    accepted.sort((a, b) => a.file.name.localeCompare(b.file.name, undefined, { numeric: true }))
    setItems((list) => [...list, ...accepted])
    setRejectedNote(rejected.length ? `Not queued: ${rejected.join(', ')}` : null)
  }

  const uploadOne = async (key: string): Promise<boolean> => {
    const item = itemsRef.current.find((it) => it.key === key)
    if (!item) return true

    try {
      let ticket = item.ticket
      if (!ticket) {
        patch(key, { status: 'creating', errorCode: undefined, errorDetail: undefined })
        ticket = await api.createUpload({
          // Omitted title = the series names it "<title> - EP<n>".
          title: item.title.trim() || undefined,
          seriesId,
        })
        patch(key, {
          ticket,
          episodeNumber: ticket.episodeNumber,
          ...(item.title.trim() ? {} : { title: ticket.title ?? '' }),
        })
      }
      patch(key, { status: 'uploading', pct: 0 })
      await uploadToBunny(item.file, ticket, (pct) => patch(key, { pct }))
      patch(key, { status: 'done', pct: 100 })
      return true
    } catch (err) {
      const code = err instanceof Error && err.message && !err.message.includes(' ')
        ? err.message
        : 'upload_failed'
      patch(key, {
        status: 'error',
        errorCode: code,
        errorDetail: err instanceof Error && code === 'upload_failed' ? err.message : undefined,
      })
      return false
    }
  }

  const drain = async () => {
    if (running) return
    setRunning(true)
    // Strictly serial — see the header comment.
    for (;;) {
      const next = itemsRef.current.find((it) => it.status === 'pending' || it.status === 'error')
      if (!next) break
      const ok = await uploadOne(next.key)
      if (!ok) break // halt: the row shows Retry/Skip
    }
    setRunning(false)
    const done = itemsRef.current.filter((it) => it.status === 'done').length
    if (done > 0) router.refresh()
  }

  const retry = (key: string) => {
    patch(key, { status: 'pending' })
    void drain()
  }

  const skip = (key: string) => {
    patch(key, { status: 'skipped' })
    void drain()
  }

  const doneCount = items.filter((it) => it.status === 'done').length
  const activeCount = items.filter((it) => it.status === 'pending' || it.status === 'creating' || it.status === 'uploading').length
  const halted = !running && items.some((it) => it.status === 'error')

  const rowBtn =
    'rounded-md border border-line-strong px-2.5 py-1 text-xs text-ink-secondary transition-colors enabled:hover:border-brand enabled:hover:text-ink disabled:opacity-40'

  if (seriesRemoved) {
    return (
      <p className="rounded-xl border border-line bg-surface p-4 text-sm text-ink-muted">
        This series was removed — it can’t receive new episodes.
      </p>
    )
  }

  return (
    <section className="rounded-xl border border-line bg-surface p-5">
      <h3 className="text-sm font-medium text-ink-secondary">Upload episodes</h3>
      <p className="mt-1 text-xs text-ink-muted">
        Pick any number of video files — they upload one after another, numbered automatically, and
        publish themselves when encoding finishes. Pricing comes from the series.
      </p>

      <label className="mt-3 block">
        <span className="sr-only">Add video files</span>
        <input
          type="file"
          accept="video/*"
          multiple
          disabled={running}
          onChange={(e) => {
            addFiles(e.target.files)
            e.target.value = ''
          }}
          className="block w-full text-sm text-ink-secondary file:mr-3 file:rounded-lg file:border-0 file:bg-surface-brand file:px-4 file:py-2 file:text-sm file:text-ink"
        />
      </label>

      {rejectedNote && (
        <p className="mt-2 text-xs" style={{ color: 'var(--warning)' }}>{rejectedNote}</p>
      )}

      {items.length > 0 && (
        <ul className="mt-4 divide-y divide-[var(--border)]">
          {items.map((item) => (
            <li key={item.key} className="py-2.5">
              <div className="flex items-center gap-3">
                <span className="w-14 shrink-0 text-xs tabular-nums text-ink-muted">
                  {item.episodeNumber != null ? episodeLabel(item.episodeNumber) : '—'}
                </span>

                {item.status === 'pending' && !running ? (
                  <input
                    value={item.title}
                    onChange={(e) => patch(item.key, { title: e.target.value.slice(0, 200) })}
                    placeholder={`Auto: ${seriesTitle} - EP…`}
                    className="min-w-0 flex-1 rounded-lg border border-line-strong bg-surface-muted px-2.5 py-1.5 text-sm placeholder:text-ink-faint focus:border-brand focus:outline-none"
                  />
                ) : (
                  <span className="min-w-0 flex-1 truncate text-sm text-ink">
                    {item.title || `${seriesTitle} - EP…`}
                  </span>
                )}

                <span className="shrink-0 text-xs text-ink-muted">
                  {item.status === 'pending' && 'Queued'}
                  {item.status === 'creating' && 'Preparing…'}
                  {item.status === 'uploading' && `${item.pct}%`}
                  {item.status === 'done' && <span style={{ color: 'var(--success)' }}>Uploaded ✓</span>}
                  {item.status === 'skipped' && 'Skipped'}
                  {item.status === 'error' && (
                    <span className="inline-flex items-center gap-2">
                      <span style={{ color: 'var(--danger)' }}>{errorLabel(item.errorCode)}</span>
                      <button onClick={() => retry(item.key)} className={rowBtn}>Retry</button>
                      <button onClick={() => skip(item.key)} className={rowBtn}>Skip</button>
                    </span>
                  )}
                </span>
              </div>

              {item.status === 'uploading' && (
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-muted">
                  <div
                    className="h-full transition-[width]"
                    style={{ width: `${item.pct}%`, background: 'var(--brand-gradient)' }}
                  />
                </div>
              )}
              {item.status === 'error' && item.errorDetail && (
                <p className="mt-1 text-xs text-ink-faint">{item.errorDetail}</p>
              )}
            </li>
          ))}
        </ul>
      )}

      {items.length > 0 && (
        <div className="mt-4 flex items-center gap-3">
          <button
            onClick={() => void drain()}
            disabled={running || activeCount === 0}
            className="rounded-lg px-5 py-2.5 text-sm font-medium text-white shadow-[var(--shadow-brand)] transition-transform enabled:hover:scale-[1.02] disabled:opacity-40"
            style={{ background: 'var(--brand-gradient)' }}
          >
            {running
              ? 'Uploading…'
              : halted
                ? 'Queue paused'
                : doneCount === items.length
                  ? 'All uploaded ✓'
                  : `Upload ${activeCount} file${activeCount === 1 ? '' : 's'}`}
          </button>
          <span className="text-xs text-ink-muted">
            {doneCount > 0 && `${doneCount} uploaded — encoding will publish them automatically. `}
            Resumable: a dropped connection picks up where it left off.
          </span>
        </div>
      )}
    </section>
  )
}
