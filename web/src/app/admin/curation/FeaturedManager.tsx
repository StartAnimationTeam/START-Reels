'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

import { Dialog } from '@/components/ui/Dialog'
import { useAdminApi } from '@/lib/admin'
import { episodeLabel, errorLabel } from '@/lib/labels'

/**
 * The ordered Featured list. Position IS the product: #1 renders as the
 * home hero, everything after fills the "Exclusive Originals" shelf in this
 * order. Moves persist by writing BOTH affected ranks (set_featured, audited
 * per write) — which also self-heals the duplicate rank-1s left by the old
 * per-video Feature button era.
 *
 * Every row carries a BANNER slot (set_hero): the hero stage is wide, the
 * 9:16 poster crops badly on it, so a featured show without a banner gets a
 * visible nag until one is uploaded. Landscape ~16:9, JPEG/PNG/WebP, ≤1MB.
 */

interface FeaturedRow {
  id: string
  title: string
  cover_url: string | null
  hero_url: string | null
  status: string
  featured_rank: number | null
  total_episodes: number
}

export function FeaturedManager({
  featured,
  candidates,
}: {
  featured: FeaturedRow[]
  candidates: Array<{ id: string; title: string; hero_url: string | null }>
}) {
  const api = useAdminApi()
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pickId, setPickId] = useState('')
  const bannerInputRef = useRef<HTMLInputElement>(null)
  const bannerTargetRef = useRef<string | null>(null)

  const uploadBanner = async (file: File | undefined) => {
    const seriesId = bannerTargetRef.current
    if (!file || !seriesId) return
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
      setError('bad_request')
      return
    }
    if (file.size > 1_000_000) {
      setError('upload_too_large')
      return
    }
    await run(async () => {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(new Error('read_failed'))
        reader.readAsDataURL(file)
      })
      await api.series('set_hero', {
        seriesId,
        imageBase64: dataUrl.split(',')[1] ?? '',
        contentType: file.type,
      })
    })
  }

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

  const setRank = (seriesId: string, rank: number) =>
    api.series('set_featured', { seriesId, featured: true, rank })

  const move = (index: number, dir: -1 | 1) => {
    const other = index + dir
    if (other < 0 || other >= featured.length) return
    // Persist both positions as clean 1-based ranks.
    void run(async () => {
      await setRank(featured[index].id, other + 1)
      await setRank(featured[other].id, index + 1)
    })
  }

  // ── the banner-first Feature flow (owner rule: non-negotiable) ─────────
  // Feature opens a dialog that DEMANDS the wide banner before anything is
  // featured; set_featured also refuses bannerless series server-side, so
  // this dialog isn't politeness — it's the only way through.
  const [featureTarget, setFeatureTarget] = useState<{ id: string; title: string; hero_url: string | null } | null>(null)
  const [stagedBanner, setStagedBanner] = useState<{ file: File; dataUrl: string } | null>(null)
  const [dialogError, setDialogError] = useState<string | null>(null)
  const [dialogBusy, setDialogBusy] = useState(false)

  const openFeatureDialog = () => {
    const target = candidates.find((c) => c.id === pickId)
    if (!target) return
    setStagedBanner(null)
    setDialogError(null)
    setFeatureTarget(target)
  }

  const stageBanner = (file: File | undefined) => {
    setDialogError(null)
    if (!file) return
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
      setDialogError('bad_request')
      return
    }
    if (file.size > 1_000_000) {
      setDialogError('upload_too_large')
      return
    }
    const reader = new FileReader()
    reader.onload = () => setStagedBanner({ file, dataUrl: String(reader.result) })
    reader.onerror = () => setDialogError('upload_failed')
    reader.readAsDataURL(file)
  }

  const confirmFeature = async () => {
    if (!featureTarget) return
    if (!featureTarget.hero_url && !stagedBanner) return
    setDialogBusy(true)
    setDialogError(null)
    try {
      // Banner first — if this fails, nothing gets featured.
      if (stagedBanner) {
        await api.series('set_hero', {
          seriesId: featureTarget.id,
          imageBase64: stagedBanner.dataUrl.split(',')[1] ?? '',
          contentType: stagedBanner.file.type,
        })
      }
      await setRank(featureTarget.id, featured.length + 1)
      setFeatureTarget(null)
      setPickId('')
      router.refresh()
    } catch (err) {
      setDialogError(err instanceof Error ? err.message : 'unknown_error')
    } finally {
      setDialogBusy(false)
    }
  }

  const btn =
    'rounded-md border border-line-strong px-2.5 py-1 text-xs text-ink-secondary transition-colors enabled:hover:border-brand enabled:hover:text-ink disabled:opacity-40'

  return (
    <section>
      <h2 className="text-lg font-semibold tracking-tight">Featured</h2>
      <p className="mt-1 text-sm text-ink-muted">
        #1 is the home hero; the rest fill the “Exclusive Originals” shelf in this order.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <select
          value={pickId}
          onChange={(e) => setPickId(e.target.value)}
          disabled={busy || candidates.length === 0}
          className="w-full max-w-xs rounded-lg border border-line-strong bg-surface-muted px-3 py-2 text-sm focus:border-brand focus:outline-none"
        >
          <option value="">
            {candidates.length ? 'Add a series to Featured…' : 'Every published series is already featured'}
          </option>
          {candidates.map((c) => (
            <option key={c.id} value={c.id}>{c.title}</option>
          ))}
        </select>
        <button
          onClick={openFeatureDialog}
          disabled={busy || !pickId}
          className="rounded-lg px-4 py-2 text-sm font-medium text-white shadow-[var(--shadow-brand)] disabled:opacity-40"
          style={{ background: 'var(--brand-gradient)' }}
        >
          Feature…
        </button>
      </div>

      {error && <p className="mt-2 text-sm" style={{ color: 'var(--danger)' }}>{errorLabel(error)}</p>}

      {featured.length === 0 ? (
        <p className="mt-4 text-sm text-ink-muted">
          Nothing featured — the home hero falls back to nothing, so pick at least one show.
        </p>
      ) : (
        <ol className="mt-4 divide-y divide-[var(--border)] rounded-xl border border-line">
          {featured.map((s, index) => (
            <li key={s.id} className="flex items-center gap-3 px-4 py-2.5">
              <span
                className={`w-8 shrink-0 text-center text-lg font-bold tabular-nums ${
                  index === 0 ? 'brand-gradient-text' : 'text-ink-faint'
                }`}
              >
                {index + 1}
              </span>
              {/* the BANNER slot — what the hero stage actually renders */}
              <span className="block h-12 w-20 shrink-0 overflow-hidden rounded border border-line bg-surface-muted">
                {s.hero_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={s.hero_url} alt="" loading="lazy" className="h-full w-full object-cover" />
                ) : s.cover_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={s.cover_url} alt="" loading="lazy" className="h-full w-full object-cover opacity-50" />
                ) : null}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink">{s.title}</p>
                <p className="text-xs text-ink-muted">
                  {index === 0 ? 'Hero · ' : ''}
                  {episodeLabel(s.total_episodes)}
                  {s.status !== 'published' && (
                    <span style={{ color: 'var(--warning)' }}> · not published — viewers can’t see it</span>
                  )}
                  {!s.hero_url && (
                    <span style={{ color: 'var(--warning)' }}>
                      {' '}· no banner — the poster will crop on the hero
                    </span>
                  )}
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  disabled={busy}
                  onClick={() => {
                    bannerTargetRef.current = s.id
                    bannerInputRef.current?.click()
                  }}
                  className={btn}
                  title="Landscape ~16:9 · JPEG/PNG/WebP · up to 1 MB"
                >
                  {s.hero_url ? 'Banner…' : 'Add banner…'}
                </button>
                <button disabled={busy || index === 0} onClick={() => move(index, -1)} className={btn} aria-label="Move up">
                  ↑
                </button>
                <button
                  disabled={busy || index === featured.length - 1}
                  onClick={() => move(index, 1)}
                  className={btn}
                  aria-label="Move down"
                >
                  ↓
                </button>
                <button
                  disabled={busy}
                  onClick={() => void run(() => api.series('set_featured', { seriesId: s.id, featured: false }))}
                  className={btn}
                >
                  Unfeature
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}

      {/* one hidden input serves every row's banner button */}
      <input
        ref={bannerInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={(e) => {
          void uploadBanner(e.target.files?.[0])
          e.target.value = ''
        }}
      />

      {/* ── the banner-first Feature dialog ───────────────────────────── */}
      {featureTarget && (
        <Dialog open onClose={() => !dialogBusy && setFeatureTarget(null)} labelledBy="feature-title">
          <h3 id="feature-title" className="text-lg font-semibold tracking-tight">
            Feature “{featureTarget.title}”
          </h3>
          <p className="mt-1 text-xs text-ink-muted">
            The hero stage needs a wide banner — no banner, no feature.
          </p>

          {/* what the hero will actually render */}
          <div className="mt-4 aspect-[21/9] overflow-hidden rounded-xl border border-line bg-surface-muted">
            {stagedBanner ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={stagedBanner.dataUrl} alt="" className="h-full w-full object-cover" />
            ) : featureTarget.hero_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={featureTarget.hero_url} alt="" className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full items-center justify-center px-6 text-center text-xs text-ink-faint">
                No banner yet — pick one below to continue.
              </div>
            )}
          </div>

          <label className="mt-3 block">
            <span className="sr-only">Upload banner</span>
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              disabled={dialogBusy}
              onChange={(e) => {
                stageBanner(e.target.files?.[0])
                e.target.value = ''
              }}
              className="block w-full text-sm text-ink-secondary file:mr-3 file:rounded-lg file:border-0 file:bg-surface-brand file:px-4 file:py-2 file:text-sm file:text-ink"
            />
          </label>
          <p className="mt-1 text-xs text-ink-muted">
            Landscape ~16:9 · JPEG/PNG/WebP · up to 1 MB
            {featureTarget.hero_url && !stagedBanner ? ' — or keep the existing banner above.' : ''}
          </p>

          {dialogError && (
            <p className="mt-2 text-sm" style={{ color: 'var(--danger)' }}>{errorLabel(dialogError)}</p>
          )}

          <div className="mt-5 flex gap-3">
            <button
              onClick={() => setFeatureTarget(null)}
              disabled={dialogBusy}
              className="flex-1 rounded-lg border border-line-strong px-4 py-2.5 text-sm text-ink-secondary transition-colors hover:text-ink disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              onClick={() => void confirmFeature()}
              disabled={dialogBusy || (!featureTarget.hero_url && !stagedBanner)}
              className="flex-1 rounded-lg px-4 py-2.5 text-sm font-medium text-white shadow-[var(--shadow-brand)] transition-transform enabled:hover:scale-[1.01] disabled:opacity-40"
              style={{ background: 'var(--brand-gradient)' }}
            >
              {dialogBusy ? 'Featuring…' : stagedBanner ? 'Upload banner & feature' : 'Feature'}
            </button>
          </div>
        </Dialog>
      )}
    </section>
  )
}
