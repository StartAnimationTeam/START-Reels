'use client'

import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'

import { StreamPlayer } from '@/components/player/StreamPlayer'
import { Watermark, watermarkLabel } from '@/components/player/Watermark'
import { ApiError, useApi, type PlaybackResult } from '@/lib/api'
import { announceCoinsDelta } from '@/lib/coins'
import { creditLabel, episodeLabel, episodeProgressLabel, errorLabel, viewsLabel } from '@/lib/labels'
import { useSupabase } from '@/lib/supabase-browser'

/**
 * The DramaBox watch surface: ONE vertical swiper over the whole series.
 * Swipe up → next episode, swipe down → previous, and when an episode ends
 * the swiper scrolls itself to the next slide. A locked slide doesn't play —
 * it IS the paywall: poster, price against balance, one Unlock button.
 *
 * Cost discipline (traps #1 + the 60/min mint limit): only the ACTIVE slide
 * mounts a <video>; mints cache per episode until the signed URL's own
 * expiry so swiping back never re-mints; exactly one open slide ahead is
 * prefetched. Swiping INTO a locked episode never charges — only the
 * explicit Unlock tap does, and it announces the delta so the nav badge
 * drops in realtime.
 *
 * The URL keeps up via history.replaceState — shareable, back-button-sane,
 * and no server round-trip mid-swipe.
 */

export interface EpisodeSlide {
  id: string
  episodeNumber: number
  thumbnailUrl: string | null
  open: boolean // free-window or already entitled — display only, server re-checks
  likeCount: number
  liked: boolean
}

type SlideState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; playback: PlaybackResult }
  | { kind: 'error'; code: string }

export function WatchExperience({
  slides,
  startIndex,
  seriesTitle,
  seriesSlug,
  totalEpisodes,
  lockedEpisodeCost,
  signedIn,
  userId,
  seriesId,
  initiallyFollowed,
  resumeAt,
  initialBalance,
}: {
  slides: EpisodeSlide[]
  startIndex: number
  seriesTitle: string
  seriesSlug: string
  totalEpisodes: number
  lockedEpisodeCost: number
  signedIn: boolean
  userId: string | null
  seriesId: string
  initiallyFollowed: boolean
  resumeAt: number
  initialBalance: number
}) {
  const api = useApi()
  const supabase = useSupabase()
  const containerRef = useRef<HTMLDivElement>(null)
  const entryId = slides[startIndex]?.id

  const [active, setActive] = useState(startIndex)
  const [balance, setBalance] = useState(initialBalance)
  // Episodes unlocked DURING this visit — merged with the server's flags.
  const [justUnlocked, setJustUnlocked] = useState<ReadonlySet<string>>(new Set())
  const [states, setStates] = useState<Record<string, SlideState>>({})
  const [unlockBusy, setUnlockBusy] = useState(false)

  const isOpen = useCallback(
    (slide: EpisodeSlide) => slide.open || justUnlocked.has(slide.id),
    [justUnlocked],
  )

  // Mint cache: episode → playback until its TTL (the ref is the truth).
  const cacheRef = useRef(new Map<string, { playback: PlaybackResult }>())
  const inFlightRef = useRef(new Set<string>())

  const ensureMint = useCallback(
    async (slide: EpisodeSlide) => {
      if (!signedIn || !isOpen(slide)) return
      const cached = cacheRef.current.get(slide.id)
      if (cached && cached.playback.expires * 1000 > Date.now() + 10_000) {
        setStates((s) =>
          s[slide.id]?.kind === 'ready' ? s : { ...s, [slide.id]: { kind: 'ready', playback: cached.playback } },
        )
        return
      }
      if (inFlightRef.current.has(slide.id)) return
      inFlightRef.current.add(slide.id)
      setStates((s) => ({ ...s, [slide.id]: { kind: 'loading' } }))
      try {
        // Idempotent for entitled/free episodes: charges 0, returns the row.
        await api.unlockVideo(slide.id)
        const playback = await api.startPlayback(slide.id, navigator.userAgent.slice(0, 40))
        cacheRef.current.set(slide.id, { playback })
        setStates((s) => ({ ...s, [slide.id]: { kind: 'ready', playback } }))
      } catch (err) {
        const code = err instanceof ApiError ? err.code : 'unknown_error'
        setStates((s) => ({ ...s, [slide.id]: { kind: 'error', code } }))
      } finally {
        inFlightRef.current.delete(slide.id)
      }
    },
    [api, signedIn, isOpen],
  )

  // The explicit paid unlock — the ONLY path that spends coins here.
  const unlockCurrent = useCallback(
    async (slide: EpisodeSlide) => {
      setUnlockBusy(true)
      setStates((s) => ({ ...s, [slide.id]: { kind: 'idle' } }))
      try {
        const result = await api.unlockVideo(slide.id)
        if (result.charged > 0) {
          announceCoinsDelta(-result.charged)
          setBalance((b) => Math.max(0, b - result.charged))
        }
        setJustUnlocked((set) => new Set(set).add(slide.id))
        const playback = await api.startPlayback(slide.id, navigator.userAgent.slice(0, 40))
        cacheRef.current.set(slide.id, { playback })
        setStates((s) => ({ ...s, [slide.id]: { kind: 'ready', playback } }))
      } catch (err) {
        setStates((s) => ({
          ...s,
          [slide.id]: { kind: 'error', code: err instanceof ApiError ? err.code : 'unknown_error' },
        }))
      } finally {
        setUnlockBusy(false)
      }
    },
    [api],
  )

  // Land on the entry episode before the first paint settles.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const target = container.children[startIndex] as HTMLElement | undefined
    target?.scrollIntoView({ block: 'start', behavior: 'instant' as ScrollBehavior })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- entry position only
  }, [])

  // Which slide is on screen.
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

  // Active slide: mint it, prefetch ONE open slide ahead, keep the URL true.
  useEffect(() => {
    const current = slides[active]
    if (!current) return
    void ensureMint(current)
    const nextOpen = slides.slice(active + 1).find((s) => isOpen(s))
    if (nextOpen) void ensureMint(nextOpen)
    window.history.replaceState(null, '', `/watch/${current.id}`)
  }, [active, slides, ensureMint, isOpen])

  const advance = useCallback(() => {
    const container = containerRef.current
    const next = container?.children[active + 1] as HTMLElement | undefined
    next?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }, [active])

  // ── idle chrome: the UI gets out of the drama's way ──────────────────
  // 3s of stillness WHILE PLAYING fades every overlay; any touch or mouse
  // move brings it all back. Paywall/error/loading slides never hide their
  // chrome — invisible buttons are unusable buttons.
  const [chromeVisible, setChromeVisible] = useState(true)
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const playingRef = useRef(false)

  const poke = useCallback(() => {
    setChromeVisible(true)
    if (idleTimer.current) clearTimeout(idleTimer.current)
    idleTimer.current = setTimeout(() => {
      if (playingRef.current) setChromeVisible(false)
    }, 3000)
  }, [])

  const activeSlideForChrome = slides[active]
  const activePlaying = Boolean(
    activeSlideForChrome &&
      isOpen(activeSlideForChrome) &&
      states[activeSlideForChrome.id]?.kind === 'ready',
  )
  useEffect(() => {
    playingRef.current = activePlaying
    if (!activePlaying) setChromeVisible(true)
    else poke() // playback just started — arm the timer
  }, [activePlaying, poke])

  useEffect(() => {
    poke() // every slide change resets the clock
    return () => {
      if (idleTimer.current) clearTimeout(idleTimer.current)
    }
  }, [active, poke])

  const chromeFade = `transition-opacity duration-300 ${chromeVisible ? 'opacity-100' : 'opacity-0'}`
  const interactive = chromeVisible ? 'pointer-events-auto' : 'pointer-events-none'

  // ── the action rail: like / save / share ────────────────────────────
  // Likes and saves ride the two client-writable RLS tables
  // (episode_likes, series_follows) — optimistic flips, rolled back if the
  // DB says no.
  const [likes, setLikes] = useState<Record<string, { liked: boolean; count: number }>>(() =>
    Object.fromEntries(slides.map((s) => [s.id, { liked: s.liked, count: s.likeCount }])),
  )
  const [saved, setSaved] = useState(initiallyFollowed)
  const [shareNote, setShareNote] = useState(false)

  const toggleLike = useCallback(
    async (slide: EpisodeSlide) => {
      if (!supabase || !userId) return
      const cur = likes[slide.id] ?? { liked: false, count: 0 }
      const flipped = { liked: !cur.liked, count: Math.max(0, cur.count + (cur.liked ? -1 : 1)) }
      setLikes((l) => ({ ...l, [slide.id]: flipped }))
      const res = flipped.liked
        ? await supabase.from('episode_likes').insert({ user_id: userId, video_id: slide.id })
        : await supabase.from('episode_likes').delete().eq('video_id', slide.id)
      if (res.error) setLikes((l) => ({ ...l, [slide.id]: cur })) // the DB is the truth
    },
    [supabase, userId, likes],
  )

  const toggleSave = useCallback(async () => {
    if (!supabase || !userId) return
    const flipped = !saved
    setSaved(flipped)
    const res = flipped
      ? await supabase.from('series_follows').insert({ user_id: userId, series_id: seriesId })
      : await supabase.from('series_follows').delete().eq('series_id', seriesId)
    if (res.error) setSaved(!flipped)
  }, [supabase, userId, saved, seriesId])

  const share = useCallback(
    async (slide: EpisodeSlide) => {
      const url = `${window.location.origin}/watch/${slide.id}`
      try {
        if (navigator.share) {
          await navigator.share({ title: seriesTitle, url })
        } else {
          await navigator.clipboard.writeText(url)
          setShareNote(true)
          setTimeout(() => setShareNote(false), 1800)
        }
      } catch {
        /* user dismissed the share sheet — not an error */
      }
    },
    [seriesTitle],
  )

  return (
    // Full-bleed: both chrome bars hide on /watch, so the swiper owns the
    // whole viewport — the DramaBox stage. max-w-md keeps desktop honest
    // (a 9:16 video across a 27" monitor is a wall of blur).
    <div
      ref={containerRef}
      onPointerDown={poke}
      onPointerMove={poke}
      className="no-scrollbar mx-auto h-dvh max-w-md snap-y snap-mandatory overflow-y-auto bg-black"
    >
      {slides.map((slide, index) => {
        const state: SlideState = states[slide.id] ?? { kind: 'idle' }
        const isActive = index === active
        const open = isOpen(slide)
        const short = balance < lockedEpisodeCost

        return (
          <section key={slide.id} data-index={index} className="relative h-full w-full snap-start snap-always">
            {/* stage */}
            {isActive && open && state.kind === 'ready' ? (
              <>
                <StreamPlayer
                  src={state.playback.url}
                  sessionId={state.playback.sessionId}
                  poster={slide.thumbnailUrl}
                  vertical
                  autoPlay
                  startAt={slide.id === entryId ? resumeAt : 0}
                  onEnded={advance}
                  onExpired={() => {
                    cacheRef.current.delete(slide.id)
                    void ensureMint(slide) // fresh URL = fresh entitlement check
                  }}
                />
                <Watermark label={watermarkLabel(userId)} />
              </>
            ) : (
              <div
                className="flex h-full items-center justify-center"
                style={
                  slide.thumbnailUrl
                    ? {
                        backgroundImage: `linear-gradient(rgb(0 0 0 / 0.55), rgb(0 0 0 / 0.75)), url(${slide.thumbnailUrl})`,
                        backgroundSize: 'cover',
                        backgroundPosition: 'center',
                      }
                    : undefined
                }
              >
                {!isActive ? null : !signedIn ? (
                  <div className="animate-scale-in max-w-xs px-6 text-center">
                    <p className="text-xs uppercase tracking-widest text-ink-muted">
                      {episodeLabel(slide.episodeNumber)}
                    </p>
                    <h2 className="mt-2 text-lg font-semibold">{seriesTitle}</h2>
                    <p className="mt-2 text-sm text-ink-secondary">Sign in to start watching.</p>
                    <Link
                      href="/sign-in"
                      className="mt-4 inline-block rounded-lg px-5 py-2.5 text-sm font-medium text-white shadow-[var(--shadow-brand)]"
                      style={{ background: 'var(--brand-gradient)' }}
                    >
                      Sign in
                    </Link>
                  </div>
                ) : !open ? (
                  /* the in-slide paywall */
                  <div className="animate-scale-in w-full max-w-xs px-6 text-center">
                    <p className="text-xs uppercase tracking-widest text-white/70">
                      {episodeLabel(slide.episodeNumber)}
                    </p>
                    <h2 className="mt-2 text-lg font-semibold text-white">{seriesTitle}</h2>

                    <div className="mt-4 flex items-center justify-between rounded-xl border border-white/15 bg-black/45 p-4 backdrop-blur">
                      <div className="text-left">
                        <p className="text-[11px] text-white/60">Price</p>
                        <p className="text-lg font-semibold tabular-nums text-white">
                          {creditLabel(lockedEpisodeCost)}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-[11px] text-white/60">Your balance</p>
                        <p
                          className="text-lg font-semibold tabular-nums"
                          style={{ color: short ? 'var(--danger)' : 'var(--success)' }}
                        >
                          {creditLabel(balance)}
                        </p>
                      </div>
                    </div>

                    {state.kind === 'error' && (
                      <p className="mt-2 text-sm" style={{ color: 'var(--danger)' }}>
                        {errorLabel(state.code)}
                      </p>
                    )}

                    {short ? (
                      <Link
                        href="/profile/wallet"
                        className="mt-4 inline-block w-full rounded-lg px-5 py-2.5 text-sm font-medium text-white shadow-[var(--shadow-brand)]"
                        style={{ background: 'var(--brand-gradient)' }}
                      >
                        Get coins
                      </Link>
                    ) : (
                      <button
                        onClick={() => void unlockCurrent(slide)}
                        disabled={unlockBusy}
                        className="mt-4 w-full rounded-lg px-5 py-2.5 text-sm font-medium text-white shadow-[var(--shadow-brand)] transition-transform enabled:hover:scale-[1.02] disabled:opacity-60"
                        style={{ background: 'var(--brand-gradient)' }}
                      >
                        {unlockBusy ? 'Unlocking…' : `Unlock for ${creditLabel(lockedEpisodeCost)}`}
                      </button>
                    )}
                  </div>
                ) : state.kind === 'error' ? (
                  <div className="animate-scale-in max-w-xs px-6 text-center">
                    <p className="text-ink">{errorLabel(state.code)}</p>
                    <button
                      onClick={() => void ensureMint(slide)}
                      className="mt-4 rounded-lg border border-line-strong px-4 py-2 text-sm text-ink-secondary hover:text-ink"
                    >
                      Try again
                    </button>
                  </div>
                ) : (
                  <p className="animate-fade text-sm text-ink-secondary">Preparing your stream…</p>
                )}
              </div>
            )}

            {/* series identity overlay — with the back affordance the hidden
                top nav no longer provides (safe-area padded for the notch) */}
            <div
              className={`pointer-events-none absolute inset-x-0 top-0 bg-gradient-to-b from-black/70 to-transparent p-4 ${chromeFade}`}
              style={{ paddingTop: 'max(1rem, env(safe-area-inset-top))' }}
            >
              <div className="flex items-start justify-between gap-3">
                <Link
                  href={`/series/${seriesSlug}`}
                  aria-label="Back to the series"
                  className={`${interactive} -ml-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-black/40 text-lg text-white backdrop-blur`}
                >
                  ←
                </Link>
                <div className="min-w-0 flex-1">
                  <Link
                    href={`/series/${seriesSlug}`}
                    className={`${interactive} inline-flex max-w-full items-center gap-2 text-sm font-medium text-white`}
                  >
                    <span className="truncate">{seriesTitle}</span>
                    <span aria-hidden>›</span>
                  </Link>
                  <p className="mt-0.5 text-xs text-white/70">
                    {episodeProgressLabel(slide.episodeNumber, totalEpisodes)}
                  </p>
                </div>
                <Link
                  href={`/series/${seriesSlug}`}
                  className={`${interactive} shrink-0 rounded-full border border-white/25 bg-black/30 px-2.5 py-1 text-[11px] text-white/85`}
                >
                  All episodes
                </Link>
              </div>
            </div>

            {/* ── the action rail: like / save / share ─────────────────── */}
            <div className={`absolute bottom-24 right-3 z-10 flex flex-col items-center gap-4 ${chromeFade} ${chromeVisible ? '' : 'pointer-events-none'}`}>
              {signedIn ? (
                <button
                  onClick={() => void toggleLike(slide)}
                  aria-pressed={likes[slide.id]?.liked ?? false}
                  aria-label={likes[slide.id]?.liked ? 'Unlike this episode' : 'Like this episode'}
                  className="flex flex-col items-center gap-0.5"
                >
                  <span
                    className="flex h-11 w-11 items-center justify-center rounded-full bg-black/45 text-xl backdrop-blur transition-transform active:scale-90"
                    style={{ color: likes[slide.id]?.liked ? 'var(--brand)' : '#fff' }}
                  >
                    {likes[slide.id]?.liked ? '♥' : '♡'}
                  </span>
                  <span className="text-[11px] tabular-nums text-white/85">
                    {viewsLabel(likes[slide.id]?.count ?? 0)}
                  </span>
                </button>
              ) : (
                <Link href="/sign-in" aria-label="Sign in to like" className="flex flex-col items-center gap-0.5">
                  <span className="flex h-11 w-11 items-center justify-center rounded-full bg-black/45 text-xl text-white backdrop-blur">
                    ♡
                  </span>
                  <span className="text-[11px] tabular-nums text-white/85">{viewsLabel(slide.likeCount)}</span>
                </Link>
              )}

              {signedIn ? (
                <button
                  onClick={() => void toggleSave()}
                  aria-pressed={saved}
                  aria-label={saved ? 'Remove series from My List' : 'Save series to My List'}
                  className="flex flex-col items-center gap-0.5"
                >
                  <span
                    className="flex h-11 w-11 items-center justify-center rounded-full bg-black/45 text-xl backdrop-blur transition-transform active:scale-90"
                    style={{ color: saved ? 'var(--brand)' : '#fff' }}
                  >
                    {saved ? '✓' : '+'}
                  </span>
                  <span className="text-[11px] text-white/85">{saved ? 'Saved' : 'Save'}</span>
                </button>
              ) : (
                <Link href="/sign-in" aria-label="Sign in to save" className="flex flex-col items-center gap-0.5">
                  <span className="flex h-11 w-11 items-center justify-center rounded-full bg-black/45 text-xl text-white backdrop-blur">+</span>
                  <span className="text-[11px] text-white/85">Save</span>
                </Link>
              )}

              <button
                onClick={() => void share(slide)}
                aria-label="Share this episode"
                className="flex flex-col items-center gap-0.5"
              >
                <span className="flex h-11 w-11 items-center justify-center rounded-full bg-black/45 text-xl text-white backdrop-blur transition-transform active:scale-90">
                  ↗
                </span>
                <span className="text-[11px] text-white/85">Share</span>
              </button>
            </div>

            {shareNote && isActive && (
              <p className="pointer-events-none absolute inset-x-0 bottom-14 text-center text-xs text-white/90">
                Link copied ✓
              </p>
            )}

            {/* swipe affordance — only where a next slide exists */}
            {isActive && index < slides.length - 1 && (
              <p className={`pointer-events-none absolute inset-x-0 bottom-2 text-center text-[11px] text-white/50 ${chromeFade}`}>
                ↑ swipe up for {episodeLabel(slides[index + 1].episodeNumber)}
              </p>
            )}
          </section>
        )
      })}
    </div>
  )
}
