import type { Metadata } from 'next'

import { createServerSupabase } from '@/lib/supabase-server'
import { creditLabel, durationLabel, episodeLabel } from '@/lib/labels'

export const metadata: Metadata = { title: 'Analytics · Admin' }

/**
 * The analytics dashboard, rendered as inline SVG in a server component —
 * series-grain since the pivot: a short-drama platform is measured in
 * shows, coins and binge depth, not in isolated video views.
 *
 * Built to the dataviz method:
 *   - different scales → small multiples, never dual axes
 *   - palette re-validated for the pivot brand on the dark chart surface:
 *     #ff2d6f (brand pink) and #2497aa (teal) both clear 3:1 against
 *     #131317 and separate cleanly under CVD (pink/teal differ in the blue
 *     channel, not just red-green)
 *   - one hue per chart; bar lists are one hue because magnitude is length
 *   - marks: 2px lines, quiet area fills, 4px-rounded bars, recessive grid
 *   - hover: native <title> per mark; table view under time charts
 *
 * Sources: nightly rollups (validated, clamped watch sessions — never the
 * client's claims), the hourly series trending MV, and live RLS reads for
 * follows/check-ins (staff policies, 0024). Bunny is the audit, not the
 * source.
 */

const PINK = '#ff2d6f'
const TEAL = '#2497aa'
const SURFACE = '#131317'

interface DayRow {
  day: string
  dau: number
  mau: number
  watch_seconds: number
  credits_consumed: number
  credits_granted: number
  unlocks: number
  new_registrations: number
  storage_bytes: number | null
  bunny_watch_seconds: number | null
}

function AreaChart({
  points,
  color,
  format,
}: {
  points: Array<{ label: string; value: number }>
  color: string
  format: (v: number) => string
}) {
  const width = 640
  const height = 160
  const pad = { top: 12, right: 8, bottom: 22, left: 8 }
  const innerW = width - pad.left - pad.right
  const innerH = height - pad.top - pad.bottom

  const max = Math.max(1, ...points.map((p) => p.value))
  const stepX = points.length > 1 ? innerW / (points.length - 1) : 0
  const x = (i: number) => pad.left + i * stepX
  const y = (v: number) => pad.top + innerH - (v / max) * innerH

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ')
  const area = `${line} L${x(points.length - 1).toFixed(1)},${(pad.top + innerH).toFixed(1)} L${pad.left},${(pad.top + innerH).toFixed(1)} Z`

  const gridYs = [0.25, 0.5, 0.75].map((f) => pad.top + innerH * f)

  return (
    <svg viewBox={`0 0 ${width} ${height}`} role="img" className="w-full">
      {gridYs.map((gy) => (
        <line key={gy} x1={pad.left} x2={width - pad.right} y1={gy} y2={gy} stroke="var(--border)" strokeWidth="1" />
      ))}
      <line x1={pad.left} x2={width - pad.right} y1={pad.top + innerH} y2={pad.top + innerH} stroke="var(--border-strong)" strokeWidth="1" />

      {points.length > 1 && (
        <>
          <path d={area} fill={color} opacity="0.14" />
          <path d={line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        </>
      )}

      {points.map((p, i) => (
        <g key={p.label}>
          <circle cx={x(i)} cy={y(p.value)} r="10" fill="transparent">
            <title>{`${p.label}: ${format(p.value)}`}</title>
          </circle>
          {p.value === max && (
            <text x={x(i)} y={y(p.value) - 8} textAnchor="middle" fontSize="11" fill="var(--text-secondary)">
              {format(p.value)}
            </text>
          )}
          <circle cx={x(i)} cy={y(p.value)} r={p.value === max ? 3.5 : 0} fill={color} stroke={SURFACE} strokeWidth="2" />
        </g>
      ))}

      {points.length > 0 && (
        <>
          <text x={pad.left} y={height - 6} fontSize="10" fill="var(--text-faint)">{points[0].label}</text>
          <text x={width - pad.right} y={height - 6} textAnchor="end" fontSize="10" fill="var(--text-faint)">
            {points[points.length - 1].label}
          </text>
        </>
      )}
    </svg>
  )
}

function BarList({
  rows,
  format,
  color = PINK,
}: {
  rows: Array<{ label: string; value: number; hint?: string }>
  format: (v: number) => string
  color?: string
}) {
  const max = Math.max(1, ...rows.map((r) => r.value))
  return (
    <div className="space-y-2">
      {rows.map((row) => (
        <div key={row.label} className="flex items-center gap-3" title={row.hint}>
          <span className="w-48 truncate text-sm text-ink" title={row.label}>{row.label}</span>
          <div className="h-4 flex-1 overflow-hidden rounded-[4px] bg-surface-muted">
            <div
              className="h-full rounded-r-[4px]"
              style={{ width: `${Math.max(2, (row.value / max) * 100)}%`, background: color }}
            />
          </div>
          <span className="w-24 shrink-0 text-right text-sm tabular-nums text-ink-secondary">{format(row.value)}</span>
        </div>
      ))}
    </div>
  )
}

function StatTile({ label, value, sub, warn }: { label: string; value: string; sub?: string; warn?: boolean }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <p className="text-xs text-ink-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-ink">{value}</p>
      {sub && (
        <p className="mt-0.5 text-xs" style={{ color: warn ? 'var(--warning)' : 'var(--text-faint)' }}>{sub}</p>
      )}
    </div>
  )
}

function DataTable({ rows }: { rows: DayRow[] }) {
  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-xs text-ink-faint hover:text-ink-muted">table view</summary>
      <div className="mt-2 overflow-x-auto rounded-lg border border-line">
        <table className="w-full min-w-[640px] text-xs">
          <thead>
            <tr className="border-b border-line bg-surface text-left text-ink-muted">
              <th className="px-3 py-1.5 font-medium">Day</th>
              <th className="px-3 py-1.5 text-right font-medium">DAU</th>
              <th className="px-3 py-1.5 text-right font-medium">Watch time</th>
              <th className="px-3 py-1.5 text-right font-medium">Unlocks</th>
              <th className="px-3 py-1.5 text-right font-medium">Coins spent</th>
              <th className="px-3 py-1.5 text-right font-medium">Coins granted</th>
              <th className="px-3 py-1.5 text-right font-medium">Signups</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)]">
            {rows.map((row) => (
              <tr key={row.day}>
                <td className="px-3 py-1.5 text-ink-secondary">{row.day}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-ink-secondary">{row.dau}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-ink-secondary">{durationLabel(row.watch_seconds)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-ink-secondary">{row.unlocks}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-ink-secondary">{row.credits_consumed}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-ink-secondary">{row.credits_granted}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-ink-secondary">{row.new_registrations}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  )
}

export default async function AdminAnalyticsPage() {
  const supabase = await createServerSupabase()

  const sinceDate = new Date(Date.now() - 30 * 86400_000)
  const since = sinceDate.toISOString().slice(0, 10)
  const sinceIso = sinceDate.toISOString()

  const [
    { data: daily },
    { data: vds },
    { data: trending },
    followsTotal,
    followsRecent,
    { data: claims },
    { data: adRewards },
  ] = await Promise.all([
    supabase
      .from('platform_daily_stats')
      .select('day, dau, mau, watch_seconds, credits_consumed, credits_granted, unlocks, new_registrations, storage_bytes, bunny_watch_seconds')
      .gte('day', since)
      .order('day', { ascending: true }),
    // Episode-day facts joined to their series — aggregated below in JS
    // (PostgREST can't GROUP BY a joined column; the row count is bounded
    // by 30 days × episodes).
    supabase
      .from('video_daily_stats')
      .select('day, views, watch_seconds, credits_earned, completions, videos (title, series_id, episode_number)')
      .gte('day', since),
    supabase.from('mv_trending_series').select('title, trend_score').order('trend_score', { ascending: false }).limit(5),
    supabase.from('series_follows').select('*', { count: 'exact', head: true }),
    supabase.from('series_follows').select('*', { count: 'exact', head: true }).gte('created_at', sinceIso),
    supabase.from('daily_reward_claims').select('claim_date, streak_day').gte('claim_date', since),
    // Staff RLS; row count bounded by users × daily cap × 30 days.
    supabase.from('ad_reward_events').select('amount, user_id').gte('created_at', sinceIso),
  ])

  const days = (daily ?? []) as unknown as DayRow[]
  const latest = days[days.length - 1]
  const shortDay = (d: string) => d.slice(5)

  const totalWatch = days.reduce((sum, d) => sum + Number(d.watch_seconds), 0)
  const totalSpent = days.reduce((sum, d) => sum + Number(d.credits_consumed), 0)
  const totalGranted = days.reduce((sum, d) => sum + Number(d.credits_granted), 0)
  const totalUnlocks = days.reduce((sum, d) => sum + Number(d.unlocks), 0)
  const totalSignups = days.reduce((sum, d) => sum + Number(d.new_registrations), 0)

  // ── series-grain aggregation ────────────────────────────────────────────
  interface SeriesAgg {
    seriesId: string
    views: number
    watch: number
    coins: number
    completions: number
    byEpisode: Map<number, number> // episode_number → views
  }
  const bySeries = new Map<string, SeriesAgg>()
  let totalViews = 0
  let totalCompletions = 0
  for (const row of (vds ?? []) as unknown as Array<{
    views: number
    watch_seconds: number
    credits_earned: number
    completions: number
    videos: { title: string; series_id: string | null; episode_number: number | null } | null
  }>) {
    totalViews += Number(row.views)
    totalCompletions += Number(row.completions)
    const sid = row.videos?.series_id
    if (!sid) continue
    const agg = bySeries.get(sid) ?? {
      seriesId: sid,
      views: 0,
      watch: 0,
      coins: 0,
      completions: 0,
      byEpisode: new Map<number, number>(),
    }
    agg.views += Number(row.views)
    agg.watch += Number(row.watch_seconds)
    agg.coins += Number(row.credits_earned)
    agg.completions += Number(row.completions)
    const ep = row.videos?.episode_number
    if (ep != null) agg.byEpisode.set(ep, (agg.byEpisode.get(ep) ?? 0) + Number(row.views))
    bySeries.set(sid, agg)
  }

  // Titles + pricing for the aggregated series, one read.
  const seriesIds = [...bySeries.keys()]
  const { data: seriesMeta } = seriesIds.length
    ? await supabase
        .from('series')
        .select('id, title, free_episode_count, episode_credit_cost')
        .in('id', seriesIds)
    : { data: [] as Array<{ id: string; title: string; free_episode_count: number; episode_credit_cost: number }> }
  const metaById = new Map((seriesMeta ?? []).map((s) => [s.id, s]))

  const topByViews = [...bySeries.values()].sort((a, b) => b.views - a.views).slice(0, 8)
  const topByCoins = [...bySeries.values()].filter((s) => s.coins > 0).sort((a, b) => b.coins - a.coins).slice(0, 8)

  // The binge funnel: episode-by-episode views for the biggest show.
  const funnelSeries = topByViews[0]
  const funnelMeta = funnelSeries ? metaById.get(funnelSeries.seriesId) : undefined
  const funnelRows = funnelSeries
    ? [...funnelSeries.byEpisode.entries()]
        .sort((a, b) => a[0] - b[0])
        .slice(0, 12)
        .map(([ep, views]) => ({
          label: `${episodeLabel(ep)}${funnelMeta && ep === funnelMeta.free_episode_count + 1 ? ' 🔒' : ''}`,
          value: views,
          hint:
            funnelMeta && ep > funnelMeta.free_episode_count
              ? `paid — ${creditLabel(funnelMeta.episode_credit_cost)}`
              : 'free window',
        }))
    : []

  // ── engagement: check-ins per day + streak depth (live, staff RLS) ─────
  const claimRows = (claims ?? []) as Array<{ claim_date: string; streak_day: number }>
  const claimsByDay = new Map<string, number>()
  for (const c of claimRows) claimsByDay.set(c.claim_date, (claimsByDay.get(c.claim_date) ?? 0) + 1)
  const checkinPoints = days.map((d) => ({ label: shortDay(d.day), value: claimsByDay.get(d.day) ?? 0 }))
  const deepStreaks = claimRows.filter((c) => c.streak_day >= 3).length

  const completionRate = totalViews > 0 ? totalCompletions / totalViews : null

  // ── rewarded ads (30d): watches, coins minted, distinct watchers ────────
  const adRows = (adRewards ?? []) as Array<{ amount: number; user_id: string }>
  const adCoins = adRows.reduce((sum, r) => sum + Number(r.amount), 0)
  const adWatchers = new Set(adRows.map((r) => r.user_id)).size

  const divergence =
    latest?.bunny_watch_seconds != null && Number(latest.watch_seconds) > 0
      ? Math.abs(Number(latest.watch_seconds) - Number(latest.bunny_watch_seconds)) / Number(latest.watch_seconds)
      : null

  return (
    <div>
      <h2 className="text-lg font-semibold tracking-tight">Analytics</h2>
      <p className="mt-1 text-xs text-ink-muted">
        Rolled up nightly (03:10 platform time) from validated watch sessions — the clamped numbers,
        not the client&apos;s claims. Series trending refreshes hourly. Bunny&apos;s figures are the
        audit, not the source.
      </p>

      {days.length === 0 ? (
        <p className="mt-6 text-sm text-ink-muted">
          No rollups yet — the first nightly run lands tomorrow, or trigger one now:
          POST /functions/v1/analytics-rollup with the ops secret.
        </p>
      ) : (
        <>
          {/* ── audience tiles ───────────────────────────────────────────── */}
          <div className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-5">
            <StatTile label="DAU (yesterday)" value={String(latest?.dau ?? 0)} sub={`MAU ${latest?.mau ?? 0}`} />
            <StatTile label="Watch time (30d)" value={durationLabel(totalWatch)} />
            <StatTile
              label="Completion rate (30d)"
              value={completionRate != null ? `${(completionRate * 100).toFixed(0)}%` : '—'}
              sub="views finishing ≥90% of an episode"
            />
            <StatTile label="New signups (30d)" value={String(totalSignups)} />
            <StatTile
              label="Bunny storage"
              value={latest?.storage_bytes != null ? `${(Number(latest.storage_bytes) / 1e9).toFixed(2)} GB` : '—'}
              sub={
                divergence != null
                  ? `watch-time divergence ${(divergence * 100).toFixed(0)}%${divergence > 0.2 ? ' ⚠ investigate' : ''}`
                  : undefined
              }
              warn={divergence != null && divergence > 0.2}
            />
          </div>

          {/* ── economy tiles ────────────────────────────────────────────── */}
          <div className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-5">
            <StatTile label="Unlocks (30d)" value={String(totalUnlocks)} sub="paid + free-window entitlements" />
            <StatTile
              label="Coin economy (30d)"
              value={`${totalSpent} spent`}
              sub={`${totalGranted} granted — ${totalGranted > 0 ? `${((totalSpent / totalGranted) * 100).toFixed(0)}% sink` : 'no grants yet'}`}
            />
            <StatTile
              label="Series follows"
              value={String(followsTotal.count ?? 0)}
              sub={`+${followsRecent.count ?? 0} in 30d`}
            />
            <StatTile
              label="Check-ins (30d)"
              value={String(claimRows.length)}
              sub={`${deepStreaks} at streak day 3+`}
            />
            <StatTile
              label="Ad rewards (30d)"
              value={String(adRows.length)}
              sub={adRows.length > 0 ? `${adCoins} coins to ${adWatchers} ${adWatchers === 1 ? 'user' : 'users'}` : 'no ad watches yet'}
            />
          </div>

          {/* ── time series: small multiples, one hue each ───────────────── */}
          <div className="mt-6 grid gap-4 lg:grid-cols-2">
            <div className="rounded-xl border border-line p-4" style={{ background: SURFACE }}>
              <h3 className="text-sm font-medium text-ink-secondary">Daily active users</h3>
              <div className="mt-2">
                <AreaChart points={days.map((d) => ({ label: shortDay(d.day), value: d.dau }))} color={PINK} format={(v) => String(v)} />
              </div>
              <DataTable rows={days} />
            </div>

            <div className="rounded-xl border border-line p-4" style={{ background: SURFACE }}>
              <h3 className="text-sm font-medium text-ink-secondary">Watch time per day</h3>
              <div className="mt-2">
                <AreaChart points={days.map((d) => ({ label: shortDay(d.day), value: Number(d.watch_seconds) }))} color={TEAL} format={(v) => durationLabel(v)} />
              </div>
              <DataTable rows={days} />
            </div>

            <div className="rounded-xl border border-line p-4" style={{ background: SURFACE }}>
              <h3 className="text-sm font-medium text-ink-secondary">Unlocks per day</h3>
              <p className="mt-0.5 text-xs text-ink-faint">every entitlement written — the platform&apos;s heartbeat metric</p>
              <div className="mt-2">
                <AreaChart points={days.map((d) => ({ label: shortDay(d.day), value: Number(d.unlocks) }))} color={PINK} format={(v) => String(v)} />
              </div>
            </div>

            <div className="rounded-xl border border-line p-4" style={{ background: SURFACE }}>
              <h3 className="text-sm font-medium text-ink-secondary">Check-ins per day</h3>
              <p className="mt-0.5 text-xs text-ink-faint">daily reward claims — the habit loop the streak ladder feeds</p>
              <div className="mt-2">
                <AreaChart points={checkinPoints} color={TEAL} format={(v) => String(v)} />
              </div>
            </div>
          </div>

          {/* ── series leaderboards ──────────────────────────────────────── */}
          <div className="mt-6 grid gap-4 lg:grid-cols-2">
            <div className="rounded-xl border border-line bg-surface p-4">
              <h3 className="text-sm font-medium text-ink-secondary">Top series by views (30d)</h3>
              <div className="mt-3">
                {topByViews.length === 0 ? (
                  <p className="text-sm text-ink-muted">No views recorded yet.</p>
                ) : (
                  <BarList
                    rows={topByViews.map((s) => ({
                      label: metaById.get(s.seriesId)?.title ?? '—',
                      value: s.views,
                      hint: `${durationLabel(s.watch)} watched · ${s.coins} coins earned · ${s.views > 0 ? Math.round((s.completions / s.views) * 100) : 0}% completion`,
                    }))}
                    format={(v) => String(v)}
                  />
                )}
              </div>
            </div>

            <div className="rounded-xl border border-line bg-surface p-4">
              <h3 className="text-sm font-medium text-ink-secondary">Top earners (coins, 30d)</h3>
              <p className="mt-0.5 text-xs text-ink-faint">committed unlock spend attributed to the episode&apos;s series</p>
              <div className="mt-3">
                {topByCoins.length === 0 ? (
                  <p className="text-sm text-ink-muted">No coins earned yet — free windows don&apos;t write ledger rows.</p>
                ) : (
                  <BarList
                    rows={topByCoins.map((s) => ({
                      label: metaById.get(s.seriesId)?.title ?? '—',
                      value: s.coins,
                      hint: `${s.views} views`,
                    }))}
                    format={(v) => creditLabel(v)}
                    color={TEAL}
                  />
                )}
              </div>
            </div>
          </div>

          {/* ── the binge funnel + trending ──────────────────────────────── */}
          <div className="mt-6 grid gap-4 lg:grid-cols-2">
            <div className="rounded-xl border border-line bg-surface p-4">
              <h3 className="text-sm font-medium text-ink-secondary">
                Episode drop-off{funnelMeta ? ` — ${funnelMeta.title}` : ''} (30d)
              </h3>
              <p className="mt-0.5 text-xs text-ink-faint">
                views per episode of the top show; 🔒 marks the first paid episode — the cliff there is
                the price talking
              </p>
              <div className="mt-3">
                {funnelRows.length === 0 ? (
                  <p className="text-sm text-ink-muted">No episode views yet.</p>
                ) : (
                  <BarList rows={funnelRows} format={(v) => String(v)} />
                )}
              </div>
            </div>

            <div className="rounded-xl border border-line bg-surface p-4">
              <h3 className="text-sm font-medium text-ink-secondary">Trending now (series)</h3>
              <p className="mt-0.5 text-xs text-ink-faint">7-day views, recency-weighted (~2-day half-life), refreshed hourly</p>
              <div className="mt-3">
                {(trending ?? []).length === 0 ? (
                  <p className="text-sm text-ink-muted">Nothing trending yet.</p>
                ) : (
                  <BarList
                    rows={(trending ?? []).map((t) => ({ label: t.title, value: Number(t.trend_score) }))}
                    format={(v) => v.toFixed(1)}
                    color={TEAL}
                  />
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
