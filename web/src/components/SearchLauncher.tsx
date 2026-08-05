'use client'

import { useState } from 'react'

import { SearchOverlay } from './SearchOverlay'

/**
 * The two ways into the search overlay — the nav's ⌕ icon and the home
 * screen's pill that looks like a field. Both are buttons now, not links:
 * search happens over the current page, never on a separate route.
 */
export function SearchLauncher({ variant }: { variant: 'icon' | 'pill' }) {
  const [open, setOpen] = useState(false)

  return (
    <>
      {variant === 'icon' ? (
        <button
          onClick={() => setOpen(true)}
          aria-label="Search"
          className="flex h-9 w-9 items-center justify-center rounded-full text-ink-secondary transition-colors hover:text-ink"
        >
          ⌕
        </button>
      ) : (
        <button
          onClick={() => setOpen(true)}
          className="mb-4 flex w-full items-center gap-2 rounded-lg border border-line-strong bg-surface-muted px-4 py-2.5 text-sm text-ink-faint transition-colors hover:border-brand hover:text-ink-muted"
        >
          <span aria-hidden>⌕</span>
          Search dramas — “Secret Baby”, “Revenge”…
        </button>
      )}

      <SearchOverlay open={open} onClose={() => setOpen(false)} />
    </>
  )
}
