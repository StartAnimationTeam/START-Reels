import type { Metadata } from 'next'

import { SeriesRail } from '@/components/SeriesRail'
import { currentUser } from '@/lib/auth'
import { MEMBER_TIER_LABELS, MEMBERSHIP_COMING_SOON } from '@/lib/labels'
import { createAnonSupabase, createServerSupabase } from '@/lib/supabase-server'
import type { CardSeries } from '@/lib/catalog'

export const metadata: Metadata = { title: 'Membership' }

/**
 * Membership is REAL machinery since 0028 — members unlock every episode
 * free and members-only dramas play for them alone. What doesn't exist yet
 * is self-serve purchase (that's the payments phase), so:
 *
 *   active member  → status card: tier, benefits in force, renewal date
 *   everyone else  → the tier preview with an honest "buying opens soon"
 *                    banner (trap #15 — no dead Join button)
 */

const BENEFITS = [
  { icon: '▶', title: 'Unlimited series', detail: 'Every episode, no coin unlocks' },
  { icon: '✦', title: 'Members-only dramas', detail: 'Exclusive premieres for members' },
  { icon: '⚡', title: 'Daily member points', detail: 'Bonus rewards on top of check-ins' },
  { icon: 'HD', title: '1080p quality', detail: 'Full HD on every device' },
]

export default async function MemberPage() {
  const anon = createAnonSupabase()
  const userId = await currentUser()

  let membership: { tier: string; expires_at: string } | null = null
  if (userId) {
    const supabase = await createServerSupabase()
    const { data } = await supabase
      .from('memberships')
      .select('tier, expires_at')
      .maybeSingle()
    if (data && Date.parse(data.expires_at) > Date.now()) membership = data
  }

  const { data } = await anon
    .from('series')
    .select('id, slug, title, cover_url, free_episode_count, episode_credit_cost, is_members_only, total_episodes')
    .eq('status', 'published')
    .is('deleted_at', null)
    .eq('is_members_only', true)
    .order('published_at', { ascending: false })
    .limit(12)
  const vipShelf = (data ?? []) as CardSeries[]

  return (
    <div className="mx-auto max-w-2xl px-4 pb-24 pt-10 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Membership</h1>

      {membership ? (
        /* ── the member's own card ──────────────────────────────────────── */
        <div
          className="mt-4 rounded-2xl border p-5"
          style={{ borderColor: 'var(--brand)', background: 'var(--surface-brand)' }}
        >
          <p className="text-xs font-medium uppercase tracking-widest brand-gradient-text">
            Active member
          </p>
          <h2 className="mt-1 text-xl font-semibold">
            {MEMBER_TIER_LABELS[membership.tier] ?? 'Membership'}
          </h2>
          <p className="mt-1 text-sm text-ink-secondary">
            Every episode unlocks free, and members-only dramas are yours to play.
          </p>
          <p className="mt-3 text-xs text-ink-muted">
            Member until{' '}
            {new Date(membership.expires_at).toLocaleDateString(undefined, {
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            })}
          </p>
        </div>
      ) : (
        <>
          {/* The honest banner comes FIRST — everything below is a preview. */}
          <p
            className="mt-4 rounded-xl border px-4 py-3 text-sm"
            style={{ borderColor: 'var(--warning)', color: 'var(--warning)' }}
          >
            {MEMBERSHIP_COMING_SOON}
          </p>

          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            {(['monthly', 'annual'] as const).map((tier) => (
              <div key={tier} className="rounded-2xl border border-line bg-surface p-5">
                <h2 className="font-semibold">{MEMBER_TIER_LABELS[tier]}</h2>
                <p className="mt-1 text-2xl font-semibold brand-gradient-text">Coming soon</p>
                <p className="mt-1 text-xs text-ink-muted">
                  {tier === 'monthly' ? 'A month of unlimited bingeing' : 'The best value for regulars'}
                </p>
              </div>
            ))}
          </div>
        </>
      )}

      <section className="mt-8">
        <h2 className="text-sm font-medium text-ink-secondary">
          {membership ? 'Your benefits' : 'Why join?'}
        </h2>
        <ul className="mt-3 space-y-3">
          {BENEFITS.map((benefit) => (
            <li key={benefit.title} className="flex items-start gap-3 rounded-xl border border-line bg-surface p-4">
              <span
                aria-hidden
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-xs font-semibold text-white"
                style={{ background: 'var(--brand-gradient)' }}
              >
                {benefit.icon}
              </span>
              <div>
                <p className="text-sm font-medium text-ink">{benefit.title}</p>
                <p className="mt-0.5 text-xs text-ink-muted">{benefit.detail}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <div className="mt-8">
        <SeriesRail
          title="Members Only"
          series={vipShelf}
          emptyNote="Members-only shows appear here as they premiere."
        />
      </div>
    </div>
  )
}
