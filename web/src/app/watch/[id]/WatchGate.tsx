'use client'

import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'

import { ApiError, useApi, type PlaybackResult } from '@/lib/api'
import { creditLabel, errorLabel, tierCostLabel } from '@/lib/labels'
import { StreamPlayer } from '@/components/player/StreamPlayer'

/**
 * The unlock gate + player, as one state machine:
 *
 *   locked        → tier card with an Unlock button (or sign-in prompt)
 *   unlocking     → spinner on the button
 *   entitled      → fetching a signed URL (auto for already-entitled viewers)
 *   playing       → StreamPlayer with heartbeats
 *   error         → translated message; insufficient_credits shows the balance
 *                   path, expired tokens silently re-request
 *
 * The gate itself proves nothing — the server decides. This component just
 * renders whichever answer the video-unlock / video-playback endpoints give,
 * so a tampered client can at worst display the wrong UI to itself.
 */

type GateState =
  | { kind: 'locked' }
  | { kind: 'unlocking' }
  | { kind: 'starting' }
  | { kind: 'playing'; playback: PlaybackResult }
  | { kind: 'error'; code: string }

export function WatchGate({
  videoId,
  title,
  tier,
  creditCost,
  thumbnailUrl,
  signedIn,
  initiallyEntitled,
}: {
  videoId: string
  title: string
  tier: string
  creditCost: number
  thumbnailUrl: string | null
  signedIn: boolean
  initiallyEntitled: boolean
}) {
  const api = useApi()
  const [state, setState] = useState<GateState>(
    initiallyEntitled ? { kind: 'starting' } : { kind: 'locked' },
  )
  const startedRef = useRef(false)

  const startPlayback = useCallback(async () => {
    setState({ kind: 'starting' })
    try {
      const playback = await api.startPlayback(videoId, navigator.userAgent.slice(0, 40))
      setState({ kind: 'playing', playback })
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'unknown_error'
      if (code === 'needs_unlock') {
        // Entitlement expired between SSR and now — back to the gate, honestly.
        setState({ kind: 'locked' })
      } else {
        setState({ kind: 'error', code })
      }
    }
  }, [api, videoId])

  const unlock = useCallback(async () => {
    setState({ kind: 'unlocking' })
    try {
      await api.unlockVideo(videoId)
      await startPlayback()
    } catch (err) {
      setState({ kind: 'error', code: err instanceof ApiError ? err.code : 'unknown_error' })
    }
  }, [api, videoId, startPlayback])

  // Auto-start for viewers who already paid — they should never see the gate
  // again inside their window.
  useEffect(() => {
    if (initiallyEntitled && !startedRef.current) {
      startedRef.current = true
      void startPlayback()
    }
  }, [initiallyEntitled, startPlayback])

  // ── playing ─────────────────────────────────────────────────────────────
  if (state.kind === 'playing') {
    return (
      <StreamPlayer
        src={state.playback.url}
        sessionId={state.playback.sessionId}
        poster={thumbnailUrl}
        onExpired={() => void startPlayback()}   // fresh URL = fresh entitlement check
      />
    )
  }

  // ── all non-playing states share the poster frame ───────────────────────
  return (
    <div
      className="relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-xl border border-line bg-surface"
      style={
        thumbnailUrl
          ? {
              backgroundImage: `linear-gradient(rgb(11 7 16 / 0.72), rgb(11 7 16 / 0.72)), url(${thumbnailUrl})`,
              backgroundSize: 'cover',
              backgroundPosition: 'center',
            }
          : undefined
      }
    >
      {state.kind === 'starting' || state.kind === 'unlocking' ? (
        <div className="animate-fade text-sm text-ink-secondary">
          {state.kind === 'unlocking' ? 'Unlocking…' : 'Preparing your stream…'}
        </div>
      ) : state.kind === 'error' ? (
        <div className="animate-scale-in max-w-md px-6 text-center">
          <p className="text-ink">{errorLabel(state.code)}</p>
          {state.code === 'insufficient_credits' ? (
            <Link
              href="/me/credits"
              className="mt-4 inline-block rounded-lg px-4 py-2 text-sm font-medium text-white"
              style={{ background: 'var(--brand-gradient)' }}
            >
              See your credits
            </Link>
          ) : (
            <button
              onClick={() => (initiallyEntitled ? void startPlayback() : setState({ kind: 'locked' }))}
              className="mt-4 rounded-lg border border-line-strong px-4 py-2 text-sm text-ink-secondary hover:border-brand hover:text-ink"
            >
              Try again
            </button>
          )}
        </div>
      ) : (
        /* locked */
        <div className="animate-scale-in max-w-md px-6 text-center">
          <p className="text-sm uppercase tracking-widest text-ink-muted">
            {tierCostLabel(tier, creditCost)}
          </p>
          <h2 className="mt-2 text-xl font-semibold">{title}</h2>

          {!signedIn ? (
            <>
              <p className="mt-2 text-sm text-ink-secondary">Sign in to watch this video.</p>
              <Link
                href="/sign-in"
                className="mt-4 inline-block rounded-lg px-5 py-2.5 text-sm font-medium text-white shadow-[var(--shadow-brand)]"
                style={{ background: 'var(--brand-gradient)' }}
              >
                Sign in
              </Link>
            </>
          ) : (
            <>
              <p className="mt-2 text-sm text-ink-secondary">
                {creditCost === 0
                  ? 'Free to watch.'
                  : `Unlocking costs ${creditLabel(creditCost)} and lasts 48 hours — rewatch, seek and switch devices freely.`}
              </p>
              <button
                onClick={() => void unlock()}
                className="mt-4 rounded-lg px-5 py-2.5 text-sm font-medium text-white shadow-[var(--shadow-brand)] transition-transform hover:scale-[1.02]"
                style={{ background: 'var(--brand-gradient)' }}
              >
                {creditCost === 0 ? 'Watch now' : `Unlock for ${creditLabel(creditCost)}`}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
