'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { useAdminApi } from '@/lib/admin'
import { durationLabel, episodeLabel, errorLabel, VIDEO_STATUS_LABELS, viewsLabel } from '@/lib/labels'

/**
 * The episode roster with teeth. Every action rides the existing
 * admin-videos function (audited, role-checked server-side):
 *
 *   preview  → /watch/[id] in a new tab (staff RLS shows unpublished too)
 *   rename   → update_meta { title }
 *   move     → update_meta { episodeNumber } (409 when the slot is taken;
 *              free-window pricing follows the number automatically)
 *   publish  → publish  (409 video_not_ready until encoding finishes)
 *   reject   → reject   (pulls a wrongly-published episode, keeps the row)
 *   delete   → remove   (ADMIN-only: revokes + refunds every unlock, then
 *              soft-deletes — which frees the episode number, so a botched
 *              upload can be replaced through the queue without renumbering)
 */

export interface EpisodeRowData {
  id: string
  title: string
  episode_number: number | null
  status: string
  duration_seconds: number | null
  view_count: number
}

export function EpisodeTable({
  episodes,
  viewerIsAdmin,
}: {
  episodes: EpisodeRowData[]
  viewerIsAdmin: boolean
}) {
  const api = useAdminApi()
  const router = useRouter()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<{ id: string; code: string } | null>(null)
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(null)
  const [moving, setMoving] = useState<{ id: string; number: string } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const run = async (id: string, fn: () => Promise<unknown>) => {
    setBusyId(id)
    setError(null)
    try {
      await fn()
      setEditing(null)
      setMoving(null)
      setConfirmDelete(null)
      router.refresh()
    } catch (err) {
      setError({ id, code: err instanceof Error ? err.message : 'unknown_error' })
    } finally {
      setBusyId(null)
    }
  }

  const btn =
    'rounded-md border border-line-strong px-2.5 py-1 text-xs text-ink-secondary transition-colors enabled:hover:border-brand enabled:hover:text-ink disabled:opacity-40'

  if (episodes.length === 0) {
    return (
      <p className="mt-2 text-sm text-ink-muted">
        None yet — queue the files below and encoding will publish them automatically.
      </p>
    )
  }

  return (
    <div className="mt-3 overflow-x-auto rounded-xl border border-line">
      <table className="w-full min-w-[640px] text-sm">
        <thead className="border-b border-line bg-surface text-left text-xs text-ink-muted">
          <tr>
            <th className="px-4 py-2.5 font-medium">EP</th>
            <th className="px-4 py-2.5 font-medium">Title</th>
            <th className="px-4 py-2.5 font-medium">Status</th>
            <th className="px-4 py-2.5 font-medium">Length</th>
            <th className="px-4 py-2.5 font-medium">Views</th>
            <th className="px-4 py-2.5 font-medium">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--border)]">
          {episodes.map((ep) => {
            const busy = busyId === ep.id
            const isEditing = editing?.id === ep.id
            return (
              <tr key={ep.id}>
                <td className="px-4 py-2.5 tabular-nums text-ink-secondary">
                  {ep.episode_number != null ? episodeLabel(ep.episode_number) : '—'}
                </td>

                <td className="max-w-[280px] px-4 py-2.5 text-ink">
                  {isEditing ? (
                    <input
                      autoFocus
                      value={editing.title}
                      onChange={(e) => setEditing({ id: ep.id, title: e.target.value.slice(0, 200) })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && editing.title.trim())
                          void run(ep.id, () => api.video('update_meta', ep.id, { title: editing.title.trim() }))
                        if (e.key === 'Escape') setEditing(null)
                      }}
                      className="w-full rounded-lg border border-line-strong bg-surface-muted px-2.5 py-1 text-sm focus:border-brand focus:outline-none"
                    />
                  ) : (
                    <span className="truncate" title={ep.title}>{ep.title}</span>
                  )}
                  {error?.id === ep.id && (
                    <span className="block text-xs" style={{ color: 'var(--danger)' }}>
                      {errorLabel(error.code)}
                    </span>
                  )}
                </td>

                <td className="px-4 py-2.5">
                  <span
                    className="rounded-full border border-line-strong px-2 py-0.5 text-xs"
                    style={
                      ep.status === 'published'
                        ? { color: 'var(--success)' }
                        : ep.status === 'rejected' || ep.status === 'removed'
                          ? { color: 'var(--danger)' }
                          : undefined
                    }
                  >
                    {VIDEO_STATUS_LABELS[ep.status] ?? ep.status}
                  </span>
                </td>

                <td className="px-4 py-2.5 tabular-nums text-ink-secondary">
                  {durationLabel(ep.duration_seconds)}
                </td>

                {/* per-episode views = the drop-off curve, right in the roster */}
                <td className="px-4 py-2.5 tabular-nums text-ink-secondary">
                  {ep.view_count > 0 ? viewsLabel(ep.view_count) : '—'}
                </td>

                <td className="px-4 py-2.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {isEditing ? (
                      <>
                        <button
                          disabled={busy || !editing.title.trim()}
                          onClick={() =>
                            void run(ep.id, () => api.video('update_meta', ep.id, { title: editing.title.trim() }))
                          }
                          className="rounded-md px-2.5 py-1 text-xs font-medium text-white disabled:opacity-40"
                          style={{ background: 'var(--brand-gradient)' }}
                        >
                          Save
                        </button>
                        <button disabled={busy} onClick={() => setEditing(null)} className={btn}>
                          Cancel
                        </button>
                      </>
                    ) : moving?.id === ep.id ? (
                      <>
                        <input
                          autoFocus
                          type="number"
                          min={1}
                          value={moving.number}
                          onChange={(e) => setMoving({ id: ep.id, number: e.target.value })}
                          onKeyDown={(e) => {
                            const n = Number(moving.number)
                            if (e.key === 'Enter' && Number.isInteger(n) && n >= 1)
                              void run(ep.id, () => api.video('update_meta', ep.id, { episodeNumber: n }))
                            if (e.key === 'Escape') setMoving(null)
                          }}
                          className="w-16 rounded-lg border border-line-strong bg-surface-muted px-2 py-1 text-xs tabular-nums focus:border-brand focus:outline-none"
                          aria-label="New episode number"
                        />
                        <button
                          disabled={busy || !(Number.isInteger(Number(moving.number)) && Number(moving.number) >= 1)}
                          onClick={() =>
                            void run(ep.id, () =>
                              api.video('update_meta', ep.id, { episodeNumber: Number(moving.number) }),
                            )
                          }
                          className="rounded-md px-2.5 py-1 text-xs font-medium text-white disabled:opacity-40"
                          style={{ background: 'var(--brand-gradient)' }}
                        >
                          Move
                        </button>
                        <button disabled={busy} onClick={() => setMoving(null)} className={btn}>
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <Link
                          href={`/watch/${ep.id}`}
                          target="_blank"
                          className="rounded-md border border-line-strong px-2.5 py-1 text-xs text-ink-secondary transition-colors hover:border-brand hover:text-ink"
                        >
                          Preview ↗
                        </Link>
                        <button
                          disabled={busy}
                          onClick={() => setEditing({ id: ep.id, title: ep.title })}
                          className={btn}
                        >
                          Rename
                        </button>
                        <button
                          disabled={busy}
                          onClick={() => setMoving({ id: ep.id, number: String(ep.episode_number ?? 1) })}
                          className={btn}
                          title="Change the episode number — the free window follows the number"
                        >
                          Move
                        </button>

                        {ep.status !== 'published' && (
                          <button
                            disabled={busy}
                            onClick={() => void run(ep.id, () => api.video('publish', ep.id))}
                            className={btn}
                            title="Refused until encoding finishes"
                          >
                            Publish
                          </button>
                        )}
                        {ep.status === 'published' && (
                          <button
                            disabled={busy}
                            onClick={() =>
                              void run(ep.id, () => api.video('reject', ep.id, { reason: 'unpublished_by_staff' }))
                            }
                            className={btn}
                          >
                            Unpublish
                          </button>
                        )}

                        {viewerIsAdmin &&
                          (confirmDelete === ep.id ? (
                            <>
                              <button
                                disabled={busy}
                                onClick={() =>
                                  void run(ep.id, () => api.video('remove', ep.id, { reason: 'episode_removed_by_admin' }))
                                }
                                className="rounded-md px-2.5 py-1 text-xs font-medium text-white disabled:opacity-40"
                                style={{ background: 'var(--danger)' }}
                              >
                                Confirm — refunds unlocks
                              </button>
                              <button disabled={busy} onClick={() => setConfirmDelete(null)} className={btn}>
                                Keep
                              </button>
                            </>
                          ) : (
                            <button disabled={busy} onClick={() => setConfirmDelete(ep.id)} className={btn}>
                              Delete…
                            </button>
                          ))}
                      </>
                    )}
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
