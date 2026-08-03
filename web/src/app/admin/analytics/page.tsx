import type { Metadata } from 'next'

import { createServerSupabase } from '@/lib/supabase-server'
import { durationLabel } from '@/lib/labels'

export const metadata: Metadata = { title: 'Analytics · Admin' }

/**
 * The analytics dashboard, rendered as inline SVG in a server component.
 *
 * Built to the dataviz method:
 *   - DAU and watch-time are DIFFERENT SCALES → two single-series charts
 *     stacked (small multiples), never a dual-axis chart.
 *   - Palette validated: #af28ea (brand) + #2497aa (brand teal) pass all six
 *     checks on the dark chart surface (CVD ΔE 14.4, contrast ≥3:1). One hue
 *     per chart; the bar list is one hue because magnitude lives in length.
 *   - Single series per plot → no legend; the title names the series.
 *   - Marks: 2px lines, quiet area fills, 4px-rounded bars anchored to the
 *     baseline with 2px gaps, recessive grid, text in ink tokens.
 *   - Hover: native <title> per mark. Table view under each chart.
 */

const PURPLE = '#af28ea'
const TEAL = '#2497aa'
const SURFACE = '#140d1c'

interface DayRow {
  day: string
  dau: number
  watch_seconds: number
  credits_consumed: number
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

  // Recessive grid: three quiet horizontal rules.
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
        // Hit target bigger than the mark; native tooltip carries the value.
        <g key={p.label}>
          <circle cx={x(i)} cy={y(p.value)} r="10" fill="transparent">
            <title>{`${p.label}: ${format(p.value)}`}</title>
          </circle>
          {p.value === max && (
            // Selective direct label: the peak only, in ink — never every point.
            <text x={x(i)} y={y(p.value) - 8} textAnchor="middle" fontSize="11" fill="var(--text-secondary)">
              {format(p.value)}
            </text>
          )}
          <circle cx={x(i)} cy={y(p.value)} r={p.value === max ? 3.5 : 0} fill={color} stroke={SURFACE} strokeWidth="2" />
        </g>
      ))}

      {/* First and last date, quiet */}
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
}: {
  rows: Array<{ label: string; value: number; hint?: string }>
  format: (v: number) => string
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
              style={{ width: `${Math.max(2, (row.value / max) * 100)}%`, background: PURPLE }}
            />
          </div>
          {/* value in ink, beside the bar — text never wears the series color */}
          <span className="w-20 shrink-0 text-right text-sm tabular-nums text-ink-secondary">{format(row.value)}</span>
        </div>
      ))}
    </div>
  )
}

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <p className="text-xs text-ink-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-ink">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-ink-faint">{sub}</p>}
    </div>
  )
}

function DataTable({ rows }: { rows: DayRow[] }) {
  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-xs text-ink-faint hover:text-ink-muted">table view</summary>
      <div className="mt-2 overflow-x-auto rounded-lg border border-line">
        <table className="w-full min-w-[520px] text-xs">
          <thead>
            <tr className="border-b border-line bg-surface text-left text-ink-muted">
              <th className="px-3 py-1.5 font-medium">Day</th>
              <th className="px-3 py-1.5 text-right font-medium">DAU</th>
              <th className="px-3 py-1.5 text-right font-medium">Watch time</th>
              <th className="px-3 py-1.5 text-right font-medium">Credits</th>
              <th className="px-3 py-1.5 text-right font-medium">Signups</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)]">
            {rows.map((row) => (
              <tr key={row.day}>
                <td className="px-3 py-1.5 text-ink-secondary">{row.day}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-ink-secondary">{row.dau}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-ink-secondary">{durationLabel(row.watch_seconds)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-ink-secondary">{row.credits_consumed}</td>
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

  const since = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10)
  const [{ data: daily }, { data: topVideos }, { data: trending }] = await Promise.all([
    supabase
      .from('platform_daily_stats')
      .select('day, dau, mau, watch_seconds, credits_consumed, new_registrations, storage_bytes, bunny_watch_seconds')
      .gte('day', since)
      .order('day', { ascending: true }),
    supabase
      .from('video_daily_stats')
      .select('video_id, views:views.sum(), watch:watch_seconds.sum(), videos (title)')
      .gte('day', since)
      .order('views', { ascending: false })
      .limit(8),
    supabase.from('mv_trending_videos').select('title, trend_score').order('trend_score', { ascending: false }).limit(5),
  ])

  const days = (daily ?? []) as unknown as (DayRow & { mau: number })[]
  const latest = days[days.length - 1]

  const totalWatch = days.reduce((sum, d) => sum + Number(d.watch_seconds), 0)
  const totalCredits = days.reduce((sum, d) => sum + Number(d.credits_consumed), 0)
  const totalSignups = days.reduce((sum, d) => sum + Number(d.new_registrations), 0)

  const shortDay = (d: string) => d.slice(5) // MM-DD

  const top = ((topVideos ?? []) as unknown as Array<{
    views: number | null
    watch: number | null
    videos: { title: string } | null
  }>).filter((r) => r.videos)

  const divergence =
    latest?.bunny_watch_seconds != null && Number(latest.watch_seconds) > 0
      ? Math.abs(Number(latest.watch_seconds) - Number(latest.bunny_watch_seconds)) / Number(latest.watch_seconds)
      : null

  return (
    <div>
      <h2 className="text-lg font-semibold tracking-tight">Analytics</h2>
      <p className="mt-1 text-xs text-ink-muted">
        Rolled up nightly (03:10 platform time) from validated watch sessions — the clamped numbers,
        not the client&apos;s claims. Bunny&apos;s figures are the audit, not the source.
      </p>

      {days.length === 0 ? (
        <p className="mt-6 text-sm text-ink-muted">
          No rollups yet — the first nightly run lands tomorrow, or trigger one now:
          POST /functions/v1/analytics-rollup with the ops secret.
        </p>
      ) : (
        <>
          {/* ── KPI tiles: headline numbers are tiles, not charts ────────── */}
          <div className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-5">
            <StatTile label="DAU (yesterday)" value={String(latest?.dau ?? 0)} sub={`MAU ${latest?.mau ?? 0}`} />
            <StatTile label="Watch time (30d)" value={durationLabel(totalWatch)} />
            <StatTile label="Credits consumed (30d)" value={String(totalCredits)} />
            <StatTile label="New signups (30d)" value={String(totalSignups)} />
            <StatTile
              label="Bunny storage"
              value={latest?.storage_bytes != null ? `${(Number(latest.storage_bytes) / 1e9).toFixed(2)} GB` : '—'}
              sub={
                divergence != null
                  ? `watch-time divergence ${(divergence * 100).toFixed(0)}%${divergence > 0.2 ? ' ⚠ investigate' : ''}`
                  : undefined
              }
            />
          </div>

          {/* ── small multiples: one measure per plot, one hue per measure ── */}
          <div className="mt-6 grid gap-4 lg:grid-cols-2">
            <div className="rounded-xl border border-line p-4" style={{ background: SURFACE }}>
              <h3 className="text-sm font-medium text-ink-secondary">Daily active users</h3>
              <div className="mt-2">
                <AreaChart
                  points={days.map((d) => ({ label: shortDay(d.day), value: d.dau }))}
                  color={PURPLE}
                  format={(v) => String(v)}
                />
              </div>
              <DataTable rows={days} />
            </div>

            <div className="rounded-xl border border-line p-4" style={{ background: SURFACE }}>
              <h3 className="text-sm font-medium text-ink-secondary">Watch time per day</h3>
              <div className="mt-2">
                <AreaChart
                  points={days.map((d) => ({ label: shortDay(d.day), value: Number(d.watch_seconds) }))}
                  color={TEAL}
                  format={(v) => durationLabel(v)}
                />
              </div>
              <DataTable rows={days} />
            </div>
          </div>

          {/* ── most viewed: bar list, magnitude in length, one hue ───────── */}
          <div className="mt-6 grid gap-4 lg:grid-cols-2">
            <div className="rounded-xl border border-line bg-surface p-4">
              <h3 className="text-sm font-medium text-ink-secondary">Most viewed (30d)</h3>
              <div className="mt-3">
                {top.length === 0 ? (
                  <p className="text-sm text-ink-muted">No views recorded yet.</p>
                ) : (
                  <BarList
                    rows={top.map((r) => ({
                      label: r.videos!.title,
                      value: Number(r.views ?? 0),
                      hint: `${durationLabel(Number(r.watch ?? 0))} watched`,
                    }))}
                    format={(v) => `${v}`}
                  />
                )}
              </div>
            </div>

            <div className="rounded-xl border border-line bg-surface p-4">
              <h3 className="text-sm font-medium text-ink-secondary">Trending now</h3>
              <p className="mt-0.5 text-xs text-ink-faint">7-day views, recency-weighted (~2-day half-life), refreshed hourly</p>
              <div className="mt-3">
                {(trending ?? []).length === 0 ? (
                  <p className="text-sm text-ink-muted">Nothing trending yet.</p>
                ) : (
                  <BarList
                    rows={(trending ?? []).map((t) => ({ label: t.title, value: Number(t.trend_score) }))}
                    format={(v) => v.toFixed(1)}
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
