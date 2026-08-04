import Link from 'next/link'

import { requireStaff } from '@/lib/auth'

/**
 * Admin shell. requireStaff() runs HERE, in the layout every admin page
 * renders through — authorization next to the surface it protects. Anonymous
 * → sign-in; signed-in-but-not-staff → /forbidden, which says so out loud.
 *
 * Individual actions still re-check on the server (the Edge Functions verify
 * roles themselves) — this gate is UX, that gate is security.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireStaff()

  const links = [
    { href: '/admin', label: 'Overview' },
    { href: '/admin/series', label: 'Series' },
    { href: '/admin/videos', label: 'Videos' },
    { href: '/admin/users', label: 'Users' },
    { href: '/admin/creators', label: 'Creators' },
    { href: '/admin/analytics', label: 'Analytics' },
    { href: '/admin/reports', label: 'Reports' },
    { href: '/admin/promos', label: 'Promos' },
    { href: '/admin/settings', label: 'Settings' },
    { href: '/admin/audit', label: 'Audit' },
  ]

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <div className="flex items-center gap-2">
        <h1 className="text-xl font-semibold tracking-tight">Admin</h1>
        <span
          className="rounded-full px-2 py-0.5 text-[11px] font-medium text-white"
          style={{ background: 'var(--brand-gradient)' }}
        >
          staff
        </span>
      </div>

      <nav className="mt-4 flex gap-1 border-b border-line">
        {links.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className="rounded-t-lg px-4 py-2 text-sm text-ink-secondary transition-colors hover:bg-surface-muted hover:text-ink"
          >
            {link.label}
          </Link>
        ))}
      </nav>

      <div className="mt-6">{children}</div>
    </div>
  )
}
