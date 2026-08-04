import Link from 'next/link'

import { episodeLabel } from '@/lib/labels'
import type { EpisodeRow } from '@/lib/catalog'

/**
 * The numbered episode chips of a series page. Lock state is DISPLAY ONLY —
 * the entitlement map comes from the server component's RLS read, and the
 * real gate is unlock_video behind /watch. A chip is:
 *
 *   ▶  currently-watched episode (highlight)
 *   n  free-window or already-unlocked episode
 *   🔒 locked (coin) episode — still a link; /watch owns the unlock flow
 */
export function EpisodeGrid({
  episodes,
  freeEpisodeCount,
  unlockedIds,
  currentId,
  lastWatched,
}: {
  episodes: EpisodeRow[]
  freeEpisodeCount: number
  unlockedIds: ReadonlySet<string>
  currentId?: string
  lastWatched?: number
}) {
  if (!episodes.length) {
    return <p className="text-sm text-ink-muted">Episodes are on their way — check back soon.</p>
  }

  return (
    <div className="grid grid-cols-5 gap-2 sm:grid-cols-8 md:grid-cols-10">
      {episodes.map((ep) => {
        const n = ep.episode_number ?? 0
        const open = n <= freeEpisodeCount || unlockedIds.has(ep.id)
        const current = ep.id === currentId
        const watched = lastWatched !== undefined && n <= lastWatched

        return (
          <Link
            key={ep.id}
            href={`/watch/${ep.id}`}
            aria-label={`${episodeLabel(n)}${open ? '' : ' (locked)'}`}
            className={`relative flex aspect-square items-center justify-center rounded-lg border text-sm font-medium tabular-nums transition-colors ${
              current
                ? 'border-transparent text-white shadow-[var(--shadow-brand)]'
                : watched
                  ? 'border-line bg-surface-muted text-ink-faint hover:border-line-strong'
                  : 'border-line bg-surface text-ink-secondary hover:border-line-strong hover:text-ink'
            }`}
            style={current ? { background: 'var(--brand-gradient)' } : undefined}
          >
            {current ? '▶' : n}
            {!open && !current && (
              <span aria-hidden className="absolute right-1 top-1 text-[9px] leading-none text-ink-faint">
                🔒
              </span>
            )}
          </Link>
        )
      })}
    </div>
  )
}
