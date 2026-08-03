'use client'

import Hls from 'hls.js'
import { useEffect, useRef, useState } from 'react'

import { useHeartbeat } from './useHeartbeat'

/**
 * HLS player. Feature-detected, two paths (CLAUDE.md trap #4):
 *
 *   Safari / iOS  → native HLS on <video src>. hls.js is NOT used even though
 *                   it technically loads, because Safari's MSE support is
 *                   partial and native is what Apple actually tests.
 *   Everyone else → hls.js over MSE.
 *
 * iOS additionally needs `playsInline` or entering playback force-fullscreens,
 * and mobile browsers will not autoplay with sound — so we don't autoplay.
 *
 * The signed URL has a TTL of duration + grace. If a session outlives it
 * (very long pause), playback stalls on the next segment fetch; the error
 * handler surfaces `expired` and the page re-requests a fresh URL — which
 * re-checks the entitlement, which is exactly the point.
 */
export function StreamPlayer({
  src,
  sessionId,
  poster,
  onExpired,
}: {
  src: string
  sessionId: string
  poster?: string | null
  onExpired?: () => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null)

  useHeartbeat(sessionId, videoEl)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    setVideoEl(video)

    // Safari exposes native HLS via canPlayType; prefer it there.
    const nativeHls = video.canPlayType('application/vnd.apple.mpegurl') !== ''

    if (nativeHls) {
      video.src = src
      return () => {
        video.removeAttribute('src')
        video.load()
      }
    }

    if (!Hls.isSupported()) {
      // Neither native HLS nor MSE — ancient browser. Nothing to attach.
      return
    }

    const hls = new Hls({
      // Modest buffer: this is a paywalled catalog, not a livestream. Less
      // buffered = less wasted delivery GB when someone bails (Bunny bills
      // per GB - CLAUDE.md trap #1).
      maxBufferLength: 30,
      maxMaxBufferLength: 60,
    })

    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (!data.fatal) return
      if (
        data.type === Hls.ErrorTypes.NETWORK_ERROR &&
        (data.response?.code === 403 || data.response?.code === 401)
      ) {
        // Token expired mid-session: ask the page for a fresh signed URL.
        onExpired?.()
        return
      }
      // Standard recovery ladder for everything else.
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad()
      else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError()
      else hls.destroy()
    })

    hls.loadSource(src)
    hls.attachMedia(video)

    return () => {
      hls.destroy()
    }
  }, [src, onExpired])

  return (
    <video
      ref={videoRef}
      controls
      playsInline
      poster={poster ?? undefined}
      className="aspect-video w-full rounded-xl bg-black"
      // Downloading is pointless against HLS segments but removing the menu
      // item keeps honest people honest and the UI consistent.
      controlsList="nodownload"
    />
  )
}
