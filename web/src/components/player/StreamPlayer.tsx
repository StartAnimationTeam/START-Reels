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
  onEnded,
  vertical = false,
  autoPlay = false,
  muted = false,
  loop = false,
  hideControls = false,
  startAt,
  className,
}: {
  src: string
  sessionId: string
  poster?: string | null
  onExpired?: () => void
  /** Fires when the episode finishes — the watch page auto-advances on it. */
  onEnded?: () => void
  /** 9:16 full-height framing for episodes; default keeps the 16:9 card. */
  vertical?: boolean
  /** Feed slides autoplay MUTED (mobile browsers refuse sound otherwise). */
  autoPlay?: boolean
  muted?: boolean
  loop?: boolean
  hideControls?: boolean
  /** Resume position in seconds, applied once metadata is known. */
  startAt?: number
  className?: string
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null)

  useHeartbeat(sessionId, videoEl)

  // Callers pass onExpired inline, so its identity changes every parent
  // render (chrome fades, like counts, prefetch states…). Playback must
  // survive all of that — only a genuinely new src may rebuild the player —
  // so the effect below reads the callback through a ref instead of
  // depending on it.
  const onExpiredRef = useRef(onExpired)
  useEffect(() => {
    onExpiredRef.current = onExpired
  })

  useEffect(() => {
    const video = videoRef.current
    if (!video || !startAt || startAt <= 0) return
    // Seek once duration is known; setting currentTime before metadata is a
    // silent no-op in some engines.
    const seek = () => {
      if (video.duration && startAt < video.duration - 2) video.currentTime = startAt
    }
    if (video.readyState >= 1) seek()
    else video.addEventListener('loadedmetadata', seek, { once: true })
    return () => video.removeEventListener('loadedmetadata', seek)
  }, [startAt, src])

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
        onExpiredRef.current?.()
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
  }, [src])

  return (
    <video
      ref={videoRef}
      controls={!hideControls}
      playsInline
      autoPlay={autoPlay}
      muted={muted}
      loop={loop}
      onEnded={onEnded}
      // Deterrence tier, honestly held (trap #16): right-click "Save video
      // as…" and PiP popouts are closed doors for honest people; the real
      // gates are the entitlement check and the CDN's referer + token rules.
      onContextMenu={(e) => e.preventDefault()}
      disablePictureInPicture
      poster={poster ?? undefined}
      className={
        className ??
        (vertical
          ? 'h-full w-full bg-black object-contain'
          : 'aspect-video w-full rounded-xl bg-black')
      }
      // Downloading is pointless against HLS segments but removing the menu
      // item keeps honest people honest and the UI consistent.
      controlsList="nodownload"
    />
  )
}
