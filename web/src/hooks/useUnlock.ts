'use client'

import { useCallback, useState } from 'react'

import { ApiError, useApi, type PlaybackResult } from '@/lib/api'

/**
 * The unlock-and-play state machine, extracted from the old WatchGate so the
 * watch page, the unlock dialog and the feed all run the SAME ladder:
 *
 *   locked → unlocking → starting → playing
 *                     ↘ error (translated at the render site)
 *
 * The machine proves nothing — the server decides. `needs_unlock` from
 * playback drops back to locked honestly (an entitlement can expire between
 * SSR and the click).
 */

export type GateState =
  | { kind: 'locked' }
  | { kind: 'unlocking' }
  | { kind: 'starting' }
  | { kind: 'playing'; playback: PlaybackResult }
  | { kind: 'error'; code: string }

export function useUnlock(videoId: string, initiallyEntitled: boolean) {
  const api = useApi()
  const [state, setState] = useState<GateState>(
    initiallyEntitled ? { kind: 'starting' } : { kind: 'locked' },
  )

  const startPlayback = useCallback(async () => {
    setState({ kind: 'starting' })
    try {
      const playback = await api.startPlayback(videoId, navigator.userAgent.slice(0, 40))
      setState({ kind: 'playing', playback })
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'unknown_error'
      if (code === 'needs_unlock') setState({ kind: 'locked' })
      else setState({ kind: 'error', code })
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

  const reset = useCallback(() => setState({ kind: 'locked' }), [])

  return { state, unlock, startPlayback, reset }
}
