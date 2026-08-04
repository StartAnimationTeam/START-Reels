'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { NAV_LABELS } from '@/lib/labels'

/**
 * The mobile-first bottom tab bar — the app's primary navigation since the
 * pivot. Hidden on surfaces that are either full-bleed (watch, feed handles
 * its own chrome) or desk-shaped (admin, creator, auth).
 *
 * Client component only because active-tab state needs usePathname; it
 * renders no data.
 */

const TABS: Array<{ href: string; label: string; icon: string; match: (p: string) => boolean }> = [
  { href: '/', label: NAV_LABELS.home, icon: '⌂', match: (p) => p === '/' },
  { href: '/feed', label: NAV_LABELS.feed, icon: '▶', match: (p) => p.startsWith('/feed') },
  { href: '/member', label: NAV_LABELS.member, icon: '✦', match: (p) => p.startsWith('/member') },
  { href: '/my-list', label: NAV_LABELS.myList, icon: '☰', match: (p) => p.startsWith('/my-list') },
  { href: '/profile', label: NAV_LABELS.profile, icon: '◉', match: (p) => p.startsWith('/profile') || p.startsWith('/me') },
]

const HIDDEN_PREFIXES = ['/admin', '/creator', '/watch', '/sign-in', '/sign-up']

export function BottomNav() {
  const pathname = usePathname() ?? '/'
  if (HIDDEN_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return null

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-50 border-t border-line bg-background/90 backdrop-blur-md"
      style={{ paddingBottom: 'var(--safe-bottom)' }}
    >
      <div className="mx-auto flex h-14 max-w-lg items-stretch justify-around">
        {TABS.map((tab) => {
          const active = tab.match(pathname)
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? 'page' : undefined}
              className={`flex flex-1 flex-col items-center justify-center gap-0.5 text-[11px] transition-colors ${
                active ? 'text-ink' : 'text-ink-muted hover:text-ink-secondary'
              }`}
            >
              <span aria-hidden className={`text-base leading-none ${active ? 'brand-gradient-text' : ''}`}>
                {tab.icon}
              </span>
              {tab.label}
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
