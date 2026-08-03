'use client'

import { useEffect, useRef } from 'react'

import { sendEndBeacon, useApi } from '@/lib/api'

/**
 * Reports watch progress every 15s, plus a final beacon on pagehide.
 *
 * The numbers this sends are CLAIMS — the server clamps them against
 * wall-clock time and requires forward playhead movement, so there is no
 * incentive to be clever here. Just report honestly:
 *
 *   seconds  = playing time accumulated since the last successful beat
 *   position = current playhead
 *
 * Accumulation pauses when the video pauses (timeupdate stops firing), which
 * matches the server's rule that a frozen position credits nothing.
 */
export function useHeartbeat(
  sessionId: string | null,
  video: HTMLVideoElement | null,
) {
  const api = useApi()
  const accumulated = useRef(0)
  const lastTime = useRef<number | null>(null)
  const position = useRef(0)

  useEffect(() => {
    if (!sessionId || !video) return

    accumulated.current = 0
    lastTime.current = null
    position.current = Math.floor(video.currentTime)

    const onTimeUpdate = () => {
      const now = video.currentTime
      // Count only small forward steps as watched time. A seek produces a big
      // jump — position moves, accumulated does not, mirroring the server.
      if (lastTime.current !== null) {
        const delta = now - lastTime.current
        if (delta > 0 && delta < 2) accumulated.current += delta
      }
      lastTime.current = now
      position.current = Math.floor(now)
    }

    const flush = async (ended = false) => {
      const seconds = Math.floor(accumulated.current)
      if (seconds === 0 && !ended) return
      accumulated.current -= seconds
      try {
        await api.heartbeat(sessionId, seconds, position.current, ended)
      } catch {
        // A missed beat is fine — the next one carries the remainder, and the
        // server clamps against wall-clock anyway. Never interrupt playback
        // over telemetry.
      }
    }

    const interval = setInterval(() => void flush(), 15_000)

    const onPageHide = () => {
      // fetch() dies with the page; sendBeacon survives it. The beacon closes
      // the session without crediting (no auth header) — the credited tail was
      // already sent by the interval, and losing ≤15s is the acceptable cost.
      sendEndBeacon(sessionId, position.current)
    }
    const onEnded = () => void flush(true)

    video.addEventListener('timeupdate', onTimeUpdate)
    video.addEventListener('ended', onEnded)
    window.addEventListener('pagehide', onPageHide)

    return () => {
      clearInterval(interval)
      video.removeEventListener('timeupdate', onTimeUpdate)
      video.removeEventListener('ended', onEnded)
      window.removeEventListener('pagehide', onPageHide)
      void flush(true)
    }
  }, [sessionId, video, api])
}
