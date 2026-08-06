'use client'

import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'

import { StreamPlayer } from '@/components/player/StreamPlayer'
import { ShareSheet, type ShareTarget } from '@/components/ShareSheet'
import { ApiError, useApi, type PlaybackResult } from '@/lib/api'
import { episodeLabel, errorLabel, viewsLabel } from '@/lib/labels'
import { useSupabase } from '@/lib/supabase-browser'

/**
 * The For You feed — full-height snap slides, each a series' EP.1.
 *
 * Cost discipline, because Bunny bills per GB and playback mints are
 * rate-limited (traps #1, and the 60/min limit):
 *   - only the ACTIVE slide mounts a <video> (neighbours show posters —
 *     buffering three streams to show one is paying 3× for the same view)
 *   - mints go through a cache keyed by videoId, honoured until the signed
 *     URL's own expiry — swiping back never re-mints
 *   - exactly ONE mint is prefetched (the next open slide)
 *   - autoplay starts MUTED (mobile browsers refuse sound), one tap unmutes
 *     for the whole session
 *
 * Free EP.1s auto-unlock — idempotent, ledger-silent (0019). Paid or
 * signed-out slides show the poster with an honest CTA instead.
 */

export interface FeedSlide {
  seriesId: string
  seriesSlug: string
  seriesTitle: string
  synopsis: string | null
  facets: string[]
  totalEpisodes: number
  videoId: string | null // EP.1; null when the series has no published episode
  thumbnailUrl: string | null
  coverUrl: string | null
  open: boolean // EP.1 inside the free window or already entitled
  likeCount: number
  liked: boolean
  followed: boolean
}

type SlideState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; playback: PlaybackResult }
  | { kind: 'error'; code: string }

export function FeedPlayer({
  slides,
  signedIn,
  userId,
}: {
  slides: FeedSlide[]
  signedIn: boolean
  userId: string | null
}) {
  const api = useApi()
  const supabase = useSupabase()
  const containerRef = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(0)
  const [muted, setMuted] = useState(true)
  const [states, setStates] = useState<Record<string, SlideState>>({})

  // ── the action rail: like / save / share (same contract as the watch
  // surface — optimistic flips on the two client-writable tables, the DB
  // wins on error) ─────────────────────────────────────────────────────
  const [likes, setLikes] = useState<Record<string, { liked: boolean; count: number }>>(() =>
    Object.fromEntries(
      slides.filter((s) => s.videoId).map((s) => [s.videoId!, { liked: s.liked, count: s.likeCount }]),
    ),
  )
  const [savedSeries, setSavedSeries] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(slides.map((s) => [s.seriesId, s.followed])),
  )
  const [shareTarget, setShareTarget] = useState<ShareTarget | null>(null)

  const toggleLike = useCallback(
    async (slide: FeedSlide) => {
      if (!supabase || !userId || !slide.videoId) return
      const cur = likes[slide.videoId] ?? { liked: false, count: 0 }
      const flipped = { liked: !cur.liked, count: Math.max(0, cur.count + (cur.liked ? -1 : 1)) }
      setLikes((l) => ({ ...l, [slide.videoId!]: flipped }))
      const res = flipped.liked
        ? await supabase.from('episode_likes').insert({ user_id: userId, video_id: slide.videoId })
        : await supabase.from('episode_likes').delete().eq('video_id', slide.videoId)
      if (res.error) setLikes((l) => ({ ...l, [slide.videoId!]: cur }))
    },
    [supabase, userId, likes],
  )

  const toggleSave = useCallback(
    async (slide: FeedSlide) => {
      if (!supabase || !userId) return
      const cur = savedSeries[slide.seriesId] ?? false
      setSavedSeries((s) => ({ ...s, [slide.seriesId]: !cur }))
      const res = !cur
        ? await supabase.from('series_follows').insert({ user_id: userId, series_id: slide.seriesId })
        : await supabase.from('series_follows').delete().eq('series_id', slide.seriesId)
      if (res.error) setSavedSeries((s) => ({ ...s, [slide.seriesId]: cur }))
    },
    [supabase, userId, savedSeries],
  )

  // Opens the in-house sheet: socials first, caption included. The native
  // OS sheet survives inside it as "More…".
  const share = useCallback((slide: FeedSlide) => {
    setShareTarget({
      title: slide.seriesTitle,
      url: slide.videoId
        ? `${window.location.origin}/watch/${slide.videoId}`
        : `${window.location.origin}/series/${slide.seriesSlug}`,
      episodeNumber: slide.videoId ? 1 : undefined,
      synopsis: slide.synopsis,
    })
  }, [])

  // Mint cache: videoId → playback until its own TTL. The ref is the truth;
  // `states` mirrors it for rendering.
  const cacheRef = useRef(new Map<string, { playback: PlaybackResult; fetchedAt: number }>())
  const inFlightRef = useRef(new Set<string>())

  const ensureMint = useCallback(
    async (slide: FeedSlide) => {
      const videoId = slide.videoId
      if (!videoId || !signedIn || !slide.open) return
      const cached = cacheRef.current.get(videoId)
      // `expires` is epoch seconds for the signed URL itself.
      if (cached && cached.playback.expires * 1000 > Date.now() + 10_000) {
        setStates((s) => (s[videoId]?.kind === 'ready' ? s : { ...s, [videoId]: { kind: 'ready', playback: cached.playback } }))
        return
      }
      if (inFlightRef.current.has(videoId)) return
      inFlightRef.current.add(videoId)
      setStates((s) => ({ ...s, [videoId]: { kind: 'loading' } }))
      try {
        await api.unlockVideo(videoId) // free-window: idempotent, no ledger row
        const playback = await api.startPlayback(videoId, 'feed')
        cacheRef.current.set(videoId, { playback, fetchedAt: Date.now() })
        setStates((s) => ({ ...s, [videoId]: { kind: 'ready', playback } }))
      } catch (err) {
        const code = err instanceof ApiError ? err.code : 'unknown_error'
        setStates((s) => ({ ...s, [videoId]: { kind: 'error', code } }))
      } finally {
        inFlightRef.current.delete(videoId)
      }
    },
    [api, signedIn],
  )

  // Which slide is on screen: IntersectionObserver over the snap children.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const index = Number((entry.target as HTMLElement).dataset.index)
            if (!Number.isNaN(index)) setActive(index)
          }
        }
      },
      { root: container, threshold: 0.6 },
    )
    for (const child of container.children) observer.observe(child)
    return () => observer.disconnect()
  }, [slides.length])

  // Mint the active slide, prefetch exactly the next OPEN one.
  useEffect(() => {
    const current = slides[active]
    if (current) void ensureMint(current)
    const nextOpen = slides.slice(active + 1).find((s) => s.open && s.videoId)
    if (nextOpen) void ensureMint(nextOpen)
  }, [active, slides, ensureMint])

  if (!slides.length) {
    return (
      <div className="flex h-[calc(100dvh-7rem-var(--safe-bottom))] items-center justify-center px-6 text-center">
        <p className="text-sm text-ink-muted">
          The feed fills up as shows premiere — check back soon.
        </p>
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      className="no-scrollbar h-[calc(100dvh-7rem-var(--safe-bottom))] snap-y snap-mandatory overflow-y-auto bg-black"
    >
      {slides.map((slide, index) => {
        const state: SlideState = (slide.videoId && states[slide.videoId]) || { kind: 'idle' }
        const isActive = index === active
        const poster = slide.thumbnailUrl ?? slide.coverUrl

        return (
          <section
            key={slide.seriesId}
            data-index={index}
            className="relative h-full w-full snap-start"
          >
            {/* stage: only the active slide mounts a player */}
            {isActive && state.kind === 'ready' ? (
              <StreamPlayer
                src={state.playback.url}
                sessionId={state.playback.sessionId}
                poster={poster}
                vertical
                autoPlay
                muted={muted}
                loop
                hideControls
                className="h-full w-full object-cover"
              />
            ) : (
              <div
                className="h-full w-full"
                style={
                  poster
                    ? { backgroundImage: `url(${poster})`, backgroundSize: 'cover', backgroundPosition: 'center' }
                    : { background: 'var(--surface-muted)' }
                }
              />
            )}

            {/* readable gradient + slide chrome */}
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/85 via-black/10 to-black/40" />

            <div className="absolute inset-x-0 bottom-0 p-4 pb-6">
              <Link
                href={`/series/${slide.seriesSlug}`}
                className="inline-flex items-center gap-1.5 text-lg font-semibold text-white"
              >
                <span className="line-clamp-1">{slide.seriesTitle}</span>
                <span aria-hidden>›</span>
              </Link>

              {slide.facets.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {slide.facets.slice(0, 3).map((facet) => (
                    <span key={facet} className="rounded border border-white/25 bg-black/30 px-1.5 py-0.5 text-[11px] text-white/85">
                      {facet}
                    </span>
                  ))}
                </div>
              )}

              <p className="mt-2 line-clamp-2 text-sm text-white/80">
                <span className="font-medium text-white">{episodeLabel(1)}</span>
                {slide.synopsis ? ` | ${slide.synopsis}` : ''}
              </p>

              {/* the one honest state line per situation */}
              {!signedIn ? (
                <p className="mt-2 text-xs text-white/60">Sign in to play — or dive into the full series.</p>
              ) : !slide.open ? (
                <p className="mt-2 text-xs text-white/60">This premiere unlocks with coins on the series page.</p>
              ) : state.kind === 'error' ? (
                <p className="mt-2 text-xs" style={{ color: 'var(--danger)' }}>{errorLabel(state.code)}</p>
              ) : state.kind !== 'ready' && isActive ? (
                <p className="mt-2 text-xs text-white/60">Loading…</p>
              ) : null}

              <Link
                href={`/series/${slide.seriesSlug}`}
                className="mt-3 block w-full rounded-lg px-6 py-3 text-center text-sm font-semibold text-white shadow-[var(--shadow-brand)]"
                style={{ background: 'var(--brand-gradient)' }}
              >
                Watch Full Series
              </Link>
            </div>

            {/* mute toggle — one tap unmutes the whole session */}
            {isActive && state.kind === 'ready' && (
              <button
                onClick={() => setMuted((m) => !m)}
                aria-label={muted ? 'Unmute' : 'Mute'}
                className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur"
              >
                {muted ? '🔇' : '🔊'}
              </button>
            )}

            {/* ── the action rail: like / save / share ─────────────────── */}
            <div className="absolute bottom-44 right-3 z-10 flex flex-col items-center gap-4">
              {signedIn && slide.videoId ? (
                <button
                  onClick={() => void toggleLike(slide)}
                  aria-pressed={likes[slide.videoId]?.liked ?? false}
                  aria-label={likes[slide.videoId]?.liked ? 'Unlike' : 'Like'}
                  className="flex flex-col items-center gap-0.5"
                >
                  <span
                    className="flex h-11 w-11 items-center justify-center rounded-full bg-black/45 text-xl backdrop-blur transition-transform active:scale-90"
                    style={{ color: likes[slide.videoId]?.liked ? 'var(--brand)' : '#fff' }}
                  >
                    {likes[slide.videoId]?.liked ? '♥' : '♡'}
                  </span>
                  <span className="text-[11px] tabular-nums text-white/85">
                    {viewsLabel(likes[slide.videoId]?.count ?? 0)}
                  </span>
                </button>
              ) : (
                <Link href="/sign-in" aria-label="Sign in to like" className="flex flex-col items-center gap-0.5">
                  <span className="flex h-11 w-11 items-center justify-center rounded-full bg-black/45 text-xl text-white backdrop-blur">♡</span>
                  <span className="text-[11px] tabular-nums text-white/85">{viewsLabel(slide.likeCount)}</span>
                </Link>
              )}

              {signedIn ? (
                <button
                  onClick={() => void toggleSave(slide)}
                  aria-pressed={savedSeries[slide.seriesId] ?? false}
                  aria-label={savedSeries[slide.seriesId] ? 'Remove from My List' : 'Save to My List'}
                  className="flex flex-col items-center gap-0.5"
                >
                  <span
                    className="flex h-11 w-11 items-center justify-center rounded-full bg-black/45 text-xl backdrop-blur transition-transform active:scale-90"
                    style={{ color: savedSeries[slide.seriesId] ? 'var(--brand)' : '#fff' }}
                  >
                    {savedSeries[slide.seriesId] ? '✓' : '+'}
                  </span>
                  <span className="text-[11px] text-white/85">
                    {savedSeries[slide.seriesId] ? 'Saved' : 'Save'}
                  </span>
                </button>
              ) : (
                <Link href="/sign-in" aria-label="Sign in to save" className="flex flex-col items-center gap-0.5">
                  <span className="flex h-11 w-11 items-center justify-center rounded-full bg-black/45 text-xl text-white backdrop-blur">+</span>
                  <span className="text-[11px] text-white/85">Save</span>
                </Link>
              )}

              <button onClick={() => share(slide)} aria-label="Share" className="flex flex-col items-center gap-0.5">
                <span className="flex h-11 w-11 items-center justify-center rounded-full bg-black/45 text-xl text-white backdrop-blur transition-transform active:scale-90">
                  ↗
                </span>
                <span className="text-[11px] text-white/85">Share</span>
              </button>
            </div>

          </section>
        )
      })}

      <ShareSheet target={shareTarget} onClose={() => setShareTarget(null)} />
    </div>
  )
}
