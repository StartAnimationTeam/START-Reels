'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'

/**
 * Debounced search box that navigates — the URL carries the state, the
 * server renders the results. 350ms of quiet before navigating keeps
 * keystrokes from stacking server renders. Active filters (?cat, ?tag,
 * ?access) survive typing: only q changes.
 */
export function SearchBox({ initialQuery }: { initialQuery: string }) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [value, setValue] = useState(initialQuery)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const navigate = (q: string) => {
    const next = new URLSearchParams(searchParams.toString())
    if (q) next.set('q', q)
    else next.delete('q')
    const qs = next.toString()
    router.replace(qs ? `/search?${qs}` : '/search')
  }

  return (
    <input
      type="search"
      value={value}
      autoFocus
      placeholder="Search shows — titles and synopses…"
      aria-label="Search series"
      onChange={(e) => {
        const next = e.target.value
        setValue(next)
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => navigate(next.trim()), 350)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          if (timer.current) clearTimeout(timer.current)
          navigate(value.trim())
        }
      }}
      className="w-full rounded-lg border border-line-strong bg-surface-muted px-4 py-2.5 text-sm text-ink placeholder:text-ink-faint focus:border-brand focus:outline-none"
    />
  )
}
