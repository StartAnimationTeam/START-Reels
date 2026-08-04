import Link from 'next/link'

/**
 * The home page's tab row — LINKS over ?tab=, not client state. The URL is
 * the state (the search page convention): tabs are linkable, the back button
 * works, and every tab renders on the server through RLS like everything
 * else.
 */

export const HOME_TABS = [
  { key: 'popular', label: 'Popular' },
  { key: 'new', label: 'New' },
  { key: 'rankings', label: 'Rankings' },
  { key: 'categories', label: 'Categories' },
] as const

export type HomeTabKey = (typeof HOME_TABS)[number]['key']

export function homeTab(raw: string | undefined): HomeTabKey {
  return (HOME_TABS.find((t) => t.key === raw)?.key ?? 'popular') as HomeTabKey
}

export function HomeTabs({ active }: { active: HomeTabKey }) {
  return (
    <div className="no-scrollbar -mx-4 flex gap-6 overflow-x-auto border-b border-line px-4 sm:-mx-6 sm:px-6">
      {HOME_TABS.map((tab) => (
        <Link
          key={tab.key}
          href={tab.key === 'popular' ? '/' : `/?tab=${tab.key}`}
          className={`whitespace-nowrap border-b-2 pb-2 pt-1 text-base font-semibold transition-colors ${
            active === tab.key
              ? 'border-[var(--brand)] text-ink'
              : 'border-transparent text-ink-muted hover:text-ink-secondary'
          }`}
        >
          {tab.label}
        </Link>
      ))}
    </div>
  )
}
