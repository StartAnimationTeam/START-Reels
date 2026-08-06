'use client'

import { useEffect, useState } from 'react'

import { episodeLabel } from '@/lib/labels'

/**
 * The share sheet: socials first, with a ready-made caption.
 *
 * Platform truths this design respects:
 *   - Facebook and X accept a pre-filled post via their web share intents.
 *   - TikTok and Instagram DO NOT let a website pre-fill a post — no intent
 *     URL exists. The honest pattern (trap #15 in spirit): copy the caption
 *     to the clipboard, open the app's site, tell the user to paste.
 *   - The device's native share sheet (navigator.share) stays available as
 *     "More" where the browser offers it.
 */

export interface ShareTarget {
  title: string
  url: string
  episodeNumber?: number
  synopsis?: string | null
}

function buildCaption(target: ShareTarget): string {
  const ep = target.episodeNumber ? ` ${episodeLabel(target.episodeNumber)}` : ''
  const hook = target.synopsis ? `\n${target.synopsis.slice(0, 120)}${target.synopsis.length > 120 ? '…' : ''}` : ''
  return `🎬 ${target.title}${ep} — I'm hooked on this series on START Reels!${hook}\nWatch it here 👉 ${target.url}\n#STARTReels #shortdrama`
}

export function ShareSheet({ target, onClose }: { target: ShareTarget | null; onClose: () => void }) {
  const [caption, setCaption] = useState('')
  const [note, setNote] = useState<string | null>(null)

  // Fresh caption every time the sheet opens for a new episode.
  useEffect(() => {
    if (target) {
      setCaption(buildCaption(target))
      setNote(null)
    }
  }, [target])

  if (!target) return null

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      return false
    }
  }

  const openTab = (url: string) => window.open(url, '_blank', 'noopener,noreferrer')

  const toPasteApp = async (app: 'TikTok' | 'Instagram', url: string) => {
    const ok = await copy(caption)
    setNote(ok ? `Caption copied — paste it in your ${app} post ✓` : 'Couldn’t copy — long-press the caption to copy it.')
    openTab(url)
  }

  const socials: Array<{ name: string; badge: string; badgeStyle: React.CSSProperties; action: () => void }> = [
    {
      name: 'TikTok',
      badge: '♪',
      badgeStyle: { background: '#000', color: '#fff', border: '1px solid rgb(255 255 255 / 0.25)' },
      action: () => void toPasteApp('TikTok', 'https://www.tiktok.com/'),
    },
    {
      name: 'Instagram',
      badge: '◎',
      badgeStyle: { background: 'linear-gradient(45deg, #f09433, #e6683c, #dc2743, #cc2366, #bc1888)', color: '#fff' },
      action: () => void toPasteApp('Instagram', 'https://www.instagram.com/'),
    },
    {
      name: 'Facebook',
      badge: 'f',
      badgeStyle: { background: '#1877F2', color: '#fff' },
      action: () =>
        openTab(
          `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(target.url)}&quote=${encodeURIComponent(caption)}`,
        ),
    },
    {
      name: 'X',
      badge: '𝕏',
      badgeStyle: { background: '#000', color: '#fff', border: '1px solid rgb(255 255 255 / 0.25)' },
      action: () => openTab(`https://x.com/intent/post?text=${encodeURIComponent(caption)}`),
    },
  ]

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Share">
      {/* backdrop */}
      <button aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/60" />

      {/* sheet */}
      <div
        className="absolute inset-x-0 bottom-0 mx-auto max-w-md rounded-t-2xl border border-b-0 border-line bg-surface p-5"
        style={{ paddingBottom: 'max(1.25rem, env(safe-area-inset-bottom))' }}
      >
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-line-strong" aria-hidden />
        <h2 className="text-sm font-semibold text-ink">Share this drama</h2>

        {/* socials first */}
        <div className="mt-4 grid grid-cols-4 gap-3">
          {socials.map((s) => (
            <button key={s.name} onClick={s.action} className="flex flex-col items-center gap-1.5">
              <span
                className="flex h-12 w-12 items-center justify-center rounded-full text-xl transition-transform active:scale-90"
                style={s.badgeStyle}
              >
                {s.badge}
              </span>
              <span className="text-[11px] text-ink-secondary">{s.name}</span>
            </button>
          ))}
        </div>

        {/* the cover letter — editable before it travels */}
        <label className="mt-5 block text-[11px] font-medium uppercase tracking-wider text-ink-muted">
          Your caption
        </label>
        <textarea
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          rows={4}
          className="mt-1.5 w-full resize-none rounded-lg border border-line-strong bg-surface-muted p-3 text-sm text-ink focus:border-brand focus:outline-none"
        />

        <div className="mt-3 flex gap-2">
          <button
            onClick={async () => setNote((await copy(caption)) ? 'Caption copied ✓' : 'Couldn’t copy — select it by hand.')}
            className="flex-1 rounded-lg border border-line-strong px-3 py-2.5 text-sm text-ink-secondary transition-colors hover:border-brand hover:text-ink"
          >
            Copy caption
          </button>
          <button
            onClick={async () => setNote((await copy(target.url)) ? 'Link copied ✓' : 'Couldn’t copy — select it by hand.')}
            className="flex-1 rounded-lg border border-line-strong px-3 py-2.5 text-sm text-ink-secondary transition-colors hover:border-brand hover:text-ink"
          >
            Copy link
          </button>
          {typeof navigator !== 'undefined' && 'share' in navigator && (
            <button
              onClick={() => void navigator.share({ title: target.title, text: caption, url: target.url }).catch(() => {})}
              className="flex-1 rounded-lg px-3 py-2.5 text-sm font-medium text-white shadow-[var(--shadow-brand)]"
              style={{ background: 'var(--brand-gradient)' }}
            >
              More…
            </button>
          )}
        </div>

        {note && <p className="mt-3 text-center text-xs text-ink-secondary">{note}</p>}
      </div>
    </div>
  )
}
