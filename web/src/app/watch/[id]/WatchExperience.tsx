'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'

import { StreamPlayer } from '@/components/player/StreamPlayer'
import { UnlockDialog } from '@/components/UnlockDialog'
import { ApiError, useApi } from '@/lib/api'
import { announceCoinsDelta } from '@/lib/coins'
import { useUnlock } from '@/hooks/useUnlock'
import { creditLabel, episodeLabel, episodeProgressLabel, errorLabel } from '@/lib/labels'

/**
 * The vertical episode player — the DramaBox watch surface.
 *
 * One 9:16 stage filling the viewport under the top bar, the episode's
 * unlock ladder from useUnlock, prev/next hops along the series, and
 * auto-advance: `ended` pushes to the next episode when it's open, or opens
 * the UnlockDialog when it costs coins. The server hands in everything it
 * proved through RLS — entitlements, resume position, balance — and the
 * Edge Functions re-prove whatever matters.
 */

export interface EpisodeNav {
  id: string
  episodeNumber: number
  open: boolean // free-window or already entitled — display only, server re-checks
}

export function WatchExperience({
  videoId,
  episodeNumber,
  seriesTitle,
  seriesSlug,
  totalEpisodes,
  episodeCost, // series-resolved cost of THIS episode (0 inside free window)
  lockedEpisodeCost,
  thumbnailUrl,
  signedIn,
  initiallyEntitled,
  resumeAt,
  balance,
  prev,
  next,
}: {
  videoId: string
  episodeNumber: number
  seriesTitle: string
  seriesSlug: string
  totalEpisodes: number
  episodeCost: number
  lockedEpisodeCost: number
  thumbnailUrl: string | null
  signedIn: boolean
  initiallyEntitled: boolean
  resumeAt: number
  balance: number
  prev: EpisodeNav | null
  next: EpisodeNav | null
}) {
  const router = useRouter()
  const api = useApi()
  // Free episodes auto-unlock on arrival: unlock_video is idempotent and
  // writes no ledger row for the free window, so "just play it" is honest.
  const autoStart = initiallyEntitled || (signedIn && episodeCost === 0)
  const { state, unlock, startPlayback } = useUnlock(videoId, initiallyEntitled)
  const startedRef = useRef(false)

  const [dialogFor, setDialogFor] = useState<EpisodeNav | null>(null)
  const [dialogBusy, setDialogBusy] = useState(false)
  const [dialogError, setDialogError] = useState<string | null>(null)

  useEffect(() => {
    if (autoStart && !startedRef.current) {
      startedRef.current = true
      void (initiallyEntitled ? startPlayback() : unlock())
    }
  }, [autoStart, initiallyEntitled, startPlayback, unlock])

  const goTo = useCallback(
    (ep: EpisodeNav) => {
      if (ep.open || !signedIn) {
        router.push(`/watch/${ep.id}`)
      } else {
        setDialogError(null)
        setDialogFor(ep)
      }
    },
    [router, signedIn],
  )

  const confirmUnlock = useCallback(async () => {
    if (!dialogFor) return
    setDialogBusy(true)
    setDialogError(null)
    try {
      const result = await api.unlockVideo(dialogFor.id)
      if (result.charged > 0) announceCoinsDelta(-result.charged)
      setDialogFor(null)
      router.push(`/watch/${dialogFor.id}`)
    } catch (err) {
      setDialogError(err instanceof ApiError ? err.code : 'unknown_error')
    } finally {
      setDialogBusy(false)
    }
  }, [api, dialogFor, router])

  const onEnded = useCallback(() => {
    if (next) goTo(next)
  }, [next, goTo])

  return (
    <div className="relative mx-auto flex h-[calc(100dvh-3.5rem)] max-w-md flex-col bg-black">
      {/* ── the stage ─────────────────────────────────────────────────── */}
      <div className="relative min-h-0 flex-1">
        {state.kind === 'playing' ? (
          <StreamPlayer
            src={state.playback.url}
            sessionId={state.playback.sessionId}
            poster={thumbnailUrl}
            vertical
            autoPlay
            startAt={resumeAt}
            onEnded={onEnded}
            onExpired={() => void startPlayback()} // fresh URL = fresh entitlement check
          />
        ) : (
          <div
            className="flex h-full items-center justify-center"
            style={
              thumbnailUrl
                ? {
                    backgroundImage: `linear-gradient(rgb(0 0 0 / 0.65), rgb(0 0 0 / 0.75)), url(${thumbnailUrl})`,
                    backgroundSize: 'cover',
                    backgroundPosition: 'center',
                  }
                : undefined
            }
          >
            {state.kind === 'unlocking' || state.kind === 'starting' ? (
              <p className="animate-fade text-sm text-ink-secondary">
                {state.kind === 'unlocking' ? 'Unlocking…' : 'Preparing your stream…'}
              </p>
            ) : state.kind === 'error' ? (
              <div className="animate-scale-in max-w-xs px-6 text-center">
                <p className="text-ink">{errorLabel(state.code)}</p>
                {state.code === 'insufficient_credits' ? (
                  <Link
                    href="/profile/wallet"
                    className="mt-4 inline-block rounded-lg px-4 py-2 text-sm font-medium text-white"
                    style={{ background: 'var(--brand-gradient)' }}
                  >
                    Get coins
                  </Link>
                ) : (
                  <button
                    onClick={() => void startPlayback()}
                    className="mt-4 rounded-lg border border-line-strong px-4 py-2 text-sm text-ink-secondary hover:text-ink"
                  >
                    Try again
                  </button>
                )}
              </div>
            ) : (
              /* locked */
              <div className="animate-scale-in max-w-xs px-6 text-center">
                <p className="text-xs uppercase tracking-widest text-ink-muted">
                  {episodeLabel(episodeNumber)}
                </p>
                <h2 className="mt-2 text-lg font-semibold">{seriesTitle}</h2>
                {!signedIn ? (
                  <>
                    <p className="mt-2 text-sm text-ink-secondary">Sign in to start watching.</p>
                    <Link
                      href="/sign-in"
                      className="mt-4 inline-block rounded-lg px-5 py-2.5 text-sm font-medium text-white shadow-[var(--shadow-brand)]"
                      style={{ background: 'var(--brand-gradient)' }}
                    >
                      Sign in
                    </Link>
                  </>
                ) : (
                  <button
                    onClick={() => void unlock()}
                    className="mt-4 rounded-lg px-5 py-2.5 text-sm font-medium text-white shadow-[var(--shadow-brand)] transition-transform hover:scale-[1.02]"
                    style={{ background: 'var(--brand-gradient)' }}
                  >
                    {episodeCost === 0 ? 'Watch now' : `Unlock for ${creditLabel(episodeCost)}`}
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {/* series identity overlay, always visible over the stage */}
        <div className="pointer-events-none absolute inset-x-0 top-0 bg-gradient-to-b from-black/70 to-transparent p-4">
          <Link
            href={`/series/${seriesSlug}`}
            className="pointer-events-auto inline-flex max-w-full items-center gap-2 text-sm font-medium text-white"
          >
            <span className="truncate">{seriesTitle}</span>
            <span aria-hidden>›</span>
          </Link>
          <p className="mt-0.5 text-xs text-white/70">
            {episodeProgressLabel(episodeNumber, totalEpisodes)}
          </p>
        </div>
      </div>

      {/* ── episode hops ──────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-3 border-t border-line bg-background px-4 py-3">
        <button
          onClick={() => prev && goTo(prev)}
          disabled={!prev}
          className="rounded-lg border border-line-strong px-4 py-2 text-sm text-ink-secondary transition-colors enabled:hover:text-ink disabled:opacity-40"
        >
          ‹ {prev ? episodeLabel(prev.episodeNumber) : 'Prev'}
        </button>

        <Link href={`/series/${seriesSlug}`} className="text-xs text-ink-muted hover:text-ink">
          All episodes
        </Link>

        <button
          onClick={() => next && goTo(next)}
          disabled={!next}
          className="rounded-lg border border-line-strong px-4 py-2 text-sm text-ink-secondary transition-colors enabled:hover:text-ink disabled:opacity-40"
        >
          {next ? episodeLabel(next.episodeNumber) : 'Next'} ›
        </button>
      </div>

      {dialogFor && (
        <UnlockDialog
          open={Boolean(dialogFor)}
          onClose={() => setDialogFor(null)}
          onConfirm={() => void confirmUnlock()}
          episodeNumber={dialogFor.episodeNumber}
          seriesTitle={seriesTitle}
          cost={lockedEpisodeCost}
          balance={balance}
          busy={dialogBusy}
          errorCode={dialogError}
        />
      )}
    </div>
  )
}
