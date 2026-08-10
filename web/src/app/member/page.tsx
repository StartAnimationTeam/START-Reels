import type { Metadata } from 'next'
import Link from 'next/link'

import { PassCards, PassConfirm } from './PassCards'
import { SeriesRail } from '@/components/SeriesRail'
import { currentUser } from '@/lib/auth'
import { MEMBER_TIER_LABELS, MEMBERSHIP_COMING_SOON } from '@/lib/labels'
import { createAnonSupabase, createServerSupabase } from '@/lib/supabase-server'
import type { CardSeries } from '@/lib/catalog'

export const metadata: Metadata = { title: 'Membership' }

/**
 * Membership machinery is live (0028) and PASSES are purchasable (0030):
 * one QRPh/GCash/Maya/card payment buys 7/30/365 days on the memberships
 * row. No auto-renew — QRPh cannot recur, and the cards say so. The
 * SUBSCRIPTION rail (0029) stays dormant until PayMongo approves the
 * org's recurring methods.
 *
 * States, all honest (trap #15):
 *   member    → status card (+ "add more time" cards — passes stack)
 *   signed-in → pass cards with real prices
 *   signed-out→ pass prices + sign-up CTA
 *   passes off→ the classic "coming soon" banner
 */

const BENEFITS = [
  { icon: '▶', title: 'Unlimited series', detail: 'Every episode, no coin unlocks' },
  { icon: '✦', title: 'Members-only dramas', detail: 'Exclusive premieres for members' },
  { icon: '⚡', title: 'Daily member points', detail: 'Bonus rewards on top of check-ins' },
  { icon: 'HD', title: '1080p quality', detail: 'Full HD on every device' },
]

export default async function MemberPage({
  searchParams,
}: {
  searchParams: Promise<{ paid?: string }>
}) {
  const { paid } = await searchParams
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

  const [{ data: vip }, { data: settings }] = await Promise.all([
    anon
      .from('series')
      .select('id, slug, title, cover_url, free_episode_count, episode_credit_cost, is_members_only, total_episodes')
      .eq('status', 'published')
      .is('deleted_at', null)
      .eq('is_members_only', true)
      .order('published_at', { ascending: false })
      .limit(12),
    anon
      .from('platform_settings')
      .select('key, value')
      .in('key', ['membership_passes_enabled', 'membership_pass_prices', 'membership_pass_methods']),
  ])
  const vipShelf = (vip ?? []) as CardSeries[]
  const setting = (k: string) => settings?.find((s) => s.key === k)?.value
  const passesEnabled = setting('membership_passes_enabled') === true
  const prices = (setting('membership_pass_prices') ?? {}) as Record<string, number>
  const methods = ((setting('membership_pass_methods') ?? ['qrph']) as string[]).map(String)

  return (
    <div className="mx-auto max-w-2xl px-4 pb-24 pt-10 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Membership</h1>

      {/* the return leg from PayMongo checkout — webhook truth, polled */}
      {paid === '1' && userId && <PassConfirm baselineExpiresAt={membership?.expires_at ?? null} />}

      {membership && (
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
      )}

      {passesEnabled ? (
        userId ? (
          <PassCards prices={prices} methods={methods} isMember={Boolean(membership)} />
        ) : (
          <section className="mt-6">
            <h2 className="text-sm font-medium text-ink-secondary">Get a membership pass</h2>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              {(['weekly', 'monthly', 'annual'] as const).map((tier) => {
                const amount = Number(prices[tier] ?? 0)
                if (amount < 100) return null
                return (
                  <div key={tier} className="rounded-2xl border border-line bg-surface p-5">
                    <h3 className="font-semibold">{MEMBER_TIER_LABELS[tier]}</h3>
                    <p className="mt-1 text-2xl font-semibold brand-gradient-text">
                      ₱{Math.round(amount / 100)}
                    </p>
                    <p className="mt-1 text-xs text-ink-muted">
                      {tier === 'weekly' ? '7 days' : tier === 'monthly' ? '30 days' : '365 days'} of
                      unlimited episodes
                    </p>
                  </div>
                )
              })}
            </div>
            <Link
              href="/sign-up"
              className="mt-4 inline-block w-full rounded-lg px-6 py-2.5 text-center text-sm font-medium text-white shadow-[var(--shadow-brand)]"
              style={{ background: 'var(--brand-gradient)' }}
            >
              Sign up free to get a pass
            </Link>
          </section>
        )
      ) : (
        !membership && (
          <p
            className="mt-4 rounded-xl border px-4 py-3 text-sm"
            style={{ borderColor: 'var(--warning)', color: 'var(--warning)' }}
          >
            {MEMBERSHIP_COMING_SOON}
          </p>
        )
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
