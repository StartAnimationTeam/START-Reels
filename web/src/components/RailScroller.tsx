'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * The Netflix affordance: a horizontal shelf with page-arrows at its edges.
 *
 * Arrows are desktop furniture — they render from `sm:` up and only when
 * there is actually somewhere to go in that direction (an arrow that does
 * nothing reads as broken). Phones keep the native swipe; the scroll
 * container itself is unchanged, so snap and momentum behave exactly as
 * before.
 */
export function RailScroller({ children, className }: { children: React.ReactNode; className: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [canLeft, setCanLeft] = useState(false)
  const [canRight, setCanRight] = useState(false)

  const update = useCallback(() => {
    const el = ref.current
    if (!el) return
    setCanLeft(el.scrollLeft > 8)
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 8)
  }, [])

  useEffect(() => {
    update()
    const el = ref.current
    if (!el) return
    el.addEventListener('scroll', update, { passive: true })
    const resize = new ResizeObserver(update)
    resize.observe(el)
    return () => {
      el.removeEventListener('scroll', update)
      resize.disconnect()
    }
  }, [update])

  const page = (dir: -1 | 1) => {
    const el = ref.current
    el?.scrollBy({ left: dir * el.clientWidth * 0.9, behavior: 'smooth' })
  }

  const arrow =
    'absolute top-1/2 z-10 hidden h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-white/15 bg-black/60 text-xl text-white backdrop-blur transition-opacity hover:bg-black/80 sm:flex'

  return (
    <div className="relative">
      <div ref={ref} className={className}>
        {children}
      </div>
      {canLeft && (
        <button aria-label="Scroll back" onClick={() => page(-1)} className={`${arrow} left-1`}>
          ‹
        </button>
      )}
      {canRight && (
        <button aria-label="Scroll forward" onClick={() => page(1)} className={`${arrow} right-1`}>
          ›
        </button>
      )}
    </div>
  )
}
