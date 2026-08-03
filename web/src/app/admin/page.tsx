import type { Metadata } from 'next'
import Link from 'next/link'

import { createServerSupabase } from '@/lib/supabase-server'

export const metadata: Metadata = { title: 'Admin' }

/**
 * Overview counts. Head-count queries — the count happens in SQL and zero
 * rows travel. Never "select rows and count in JS" (CLAUDE.md trap #12: that
 * worked in the sibling project for weeks, then died on statement timeout).
 */
export default async function AdminOverviewPage() {
  const supabase = await createServerSupabase()

  const [users, published, pendingReview, processing, unlocks] = await Promise.all([
    supabase.from('profiles').select('*', { count: 'exact', head: true }),
    supabase.from('videos').select('*', { count: 'exact', head: true }).eq('status', 'published'),
    supabase.from('videos').select('*', { count: 'exact', head: true }).eq('status', 'pending_review'),
    supabase.from('videos').select('*', { count: 'exact', head: true }).in('status', ['uploading', 'processing']),
    supabase.from('video_entitlements').select('*', { count: 'exact', head: true }),
  ])

  const tiles = [
    { label: 'Users', value: users.count ?? 0, href: '/admin/users' },
    { label: 'Published videos', value: published.count ?? 0, href: '/admin/videos' },
    {
      label: 'Awaiting review',
      value: pendingReview.count ?? 0,
      href: '/admin/videos',
      highlight: (pendingReview.count ?? 0) > 0,
    },
    { label: 'Uploading / processing', value: processing.count ?? 0, href: '/admin/videos' },
    { label: 'Total unlocks', value: unlocks.count ?? 0, href: '/admin/videos' },
  ]

  return (
    <div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {tiles.map((tile) => (
          <Link
            key={tile.label}
            href={tile.href}
            className="rounded-xl border border-line bg-surface p-4 transition-colors hover:border-line-strong"
          >
            <p className="text-xs text-ink-muted">{tile.label}</p>
            <p
              className="mt-1 text-2xl font-semibold tabular-nums"
              style={tile.highlight ? { color: 'var(--warning)' } : undefined}
            >
              {tile.value}
            </p>
          </Link>
        ))}
      </div>

      <p className="mt-8 text-sm text-ink-muted">
        Watch-hours, trending and credit-consumption charts arrive with Phase 7
        (analytics rollups). Reports queue, promo campaigns and platform
        settings arrive in the next admin pass.
      </p>
    </div>
  )
}
