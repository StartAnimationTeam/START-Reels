'use client'

import { useMemo, useState } from 'react'

import { Dialog } from '@/components/ui/Dialog'
import { comingSoonLabel } from '@/lib/labels'

/**
 * The premiere picker — replaces the raw datetime-local input. Zero
 * dependencies, same native-<dialog> primitive as everything else.
 *
 * ALL times here are PLATFORM time (platform_settings.platform_timezone,
 * normally Asia/Manila) — never the admin's device clock (trap #17: a
 * schedule set from a laptop abroad must mean the same evening the PH
 * audience experiences). The calendar math converts platform wall-time to
 * a UTC instant via Intl, two-pass so DST-shifting zones stay correct;
 * Manila itself has no DST, so PH scheduling is exact by construction.
 *
 * Nothing is scheduled until "Publish later" is pressed; past moments
 * disable themselves and can never be confirmed.
 */

const DAYS_AHEAD = 14
const DEFAULT_HOUR = 20 // premieres are an evening ritual

interface CalendarDay {
  y: number
  m: number // 0-based
  d: number
}

function zoneOffsetMinutes(timeZone: string, at: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const parts = Object.fromEntries(dtf.formatToParts(at).map((p) => [p.type, p.value]))
  const asUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  )
  return (asUTC - at.getTime()) / 60_000
}

/** The UTC instant of `y-m-d h:min` ON THE PLATFORM's wall clock. */
function zonedInstant(timeZone: string, day: CalendarDay, hour: number, minute: number): Date {
  let ts = Date.UTC(day.y, day.m, day.d, hour, minute)
  const offset = zoneOffsetMinutes(timeZone, new Date(ts))
  ts -= offset * 60_000
  const offset2 = zoneOffsetMinutes(timeZone, new Date(ts))
  if (offset2 !== offset) ts = Date.UTC(day.y, day.m, day.d, hour, minute) - offset2 * 60_000
  return new Date(ts)
}

/** Today's calendar date as the PLATFORM sees it. */
function zonedToday(timeZone: string): CalendarDay {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value]),
  )
  return { y: Number(parts.year), m: Number(parts.month) - 1, d: Number(parts.day) }
}

function hourLabel(hour: number): string {
  return new Date(2000, 0, 1, hour, 0).toLocaleTimeString(undefined, { hour: 'numeric' })
}

export function SchedulePicker({
  open,
  onClose,
  onConfirm,
  busy,
  title,
  timeZone,
}: {
  open: boolean
  onClose: () => void
  onConfirm: (when: Date) => void
  busy: boolean
  title: string
  /** IANA zone from platform_settings.platform_timezone (e.g. Asia/Manila). */
  timeZone: string
}) {
  const days = useMemo<CalendarDay[]>(() => {
    const today = zonedToday(timeZone)
    return Array.from({ length: DAYS_AHEAD }, (_, i) => {
      // Date.UTC as a pure calendar container — it normalises month/day
      // overflow for us; the zone conversion happens in zonedInstant.
      const c = new Date(Date.UTC(today.y, today.m, today.d + i))
      return { y: c.getUTCFullYear(), m: c.getUTCMonth(), d: c.getUTCDate() }
    })
  }, [timeZone])

  const [dayIdx, setDayIdx] = useState(0)
  const [hour, setHour] = useState(DEFAULT_HOUR)
  const [minute, setMinute] = useState(0)

  const chosen = useMemo(
    () => zonedInstant(timeZone, days[dayIdx] ?? days[0], hour, minute),
    [timeZone, days, dayIdx, hour, minute],
  )
  const inPast = chosen.getTime() <= Date.now()

  const zoneShort = useMemo(() => {
    const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' })
      .formatToParts(new Date())
      .find((p) => p.type === 'timeZoneName')
    return part?.value ?? timeZone
  }, [timeZone])

  const presets = useMemo(() => {
    const list: Array<{ label: string; dayIdx: number; hour: number; minute: number }> = [
      { label: 'Tonight 8 PM', dayIdx: 0, hour: DEFAULT_HOUR, minute: 0 },
      { label: 'Tomorrow 8 PM', dayIdx: 1, hour: DEFAULT_HOUR, minute: 0 },
    ]
    // The platform's next Saturday (weekday from the calendar container).
    const satIdx = days.findIndex(
      (d, i) => i > 0 && new Date(Date.UTC(d.y, d.m, d.d)).getUTCDay() === 6,
    )
    if (satIdx > 1) list.push({ label: 'Saturday 8 PM', dayIdx: satIdx, hour: DEFAULT_HOUR, minute: 0 })
    return list.filter(
      (p) => zonedInstant(timeZone, days[p.dayIdx], p.hour, p.minute).getTime() > Date.now(),
    )
  }, [days, timeZone])

  const dayLabel = (day: CalendarDay, index: number) => {
    if (index === 0) return 'Today'
    if (index === 1) return 'Tomorrow'
    return new Date(Date.UTC(day.y, day.m, day.d)).toLocaleDateString(undefined, {
      weekday: 'short',
      day: 'numeric',
      timeZone: 'UTC', // the container IS the calendar date — no re-shifting
    })
  }

  const chip = (active: boolean, disabled = false) =>
    `rounded-lg border px-2.5 py-1.5 text-xs tabular-nums transition-colors ${
      active
        ? 'border-transparent font-medium text-white'
        : disabled
          ? 'cursor-not-allowed border-line text-ink-faint opacity-50'
          : 'border-line-strong text-ink-secondary hover:border-brand hover:text-ink'
    }`
  const chipStyle = (active: boolean) => (active ? { background: 'var(--brand-gradient)' } : undefined)

  return (
    <Dialog open={open} onClose={onClose} labelledBy="schedule-title">
      <h2 id="schedule-title" className="text-lg font-semibold tracking-tight">
        Publish later
      </h2>
      <p className="mt-1 truncate text-sm text-ink-muted">{title}</p>
      <p className="mt-1 text-xs text-ink-faint">
        All times are Philippine time ({zoneShort}). Pick freely — nothing is scheduled until you
        press “Publish later” below.
      </p>

      {/* ── quick presets ─────────────────────────────────────────────── */}
      {presets.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-1.5">
          {presets.map((p) => {
            const active = dayIdx === p.dayIdx && hour === p.hour && minute === p.minute
            return (
              <button
                key={p.label}
                onClick={() => {
                  setDayIdx(p.dayIdx)
                  setHour(p.hour)
                  setMinute(p.minute)
                }}
                className={chip(active)}
                style={chipStyle(active)}
              >
                {p.label}
              </button>
            )
          })}
        </div>
      )}

      {/* ── day strip ─────────────────────────────────────────────────── */}
      <p className="mt-4 text-xs font-medium text-ink-secondary">Day</p>
      <div className="no-scrollbar -mx-6 mt-1.5 flex gap-1.5 overflow-x-auto px-6 pb-1">
        {days.map((d, i) => (
          <button
            key={`${d.y}-${d.m}-${d.d}`}
            onClick={() => setDayIdx(i)}
            className={`shrink-0 ${chip(dayIdx === i)}`}
            style={chipStyle(dayIdx === i)}
          >
            {dayLabel(d, i)}
          </button>
        ))}
      </div>

      {/* ── hour grid ─────────────────────────────────────────────────── */}
      <div className="mt-3 flex items-baseline justify-between">
        <p className="text-xs font-medium text-ink-secondary">Time</p>
        <div className="flex gap-1">
          {[0, 30].map((m) => (
            <button key={m} onClick={() => setMinute(m)} className={chip(minute === m)} style={chipStyle(minute === m)}>
              :{String(m).padStart(2, '0')}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-1.5 grid grid-cols-6 gap-1.5">
        {Array.from({ length: 24 }, (_, h) => {
          const past = zonedInstant(timeZone, days[dayIdx] ?? days[0], h, minute).getTime() <= Date.now()
          const active = hour === h
          return (
            <button key={h} disabled={past} onClick={() => setHour(h)} className={chip(active, past)} style={chipStyle(active)}>
              {hourLabel(h)}
            </button>
          )
        })}
      </div>

      {/* ── the promise, verbatim ─────────────────────────────────────── */}
      <p
        className="mt-4 rounded-xl border px-3 py-2.5 text-sm font-medium"
        style={
          inPast
            ? { borderColor: 'var(--danger)', color: 'var(--danger)' }
            : { borderColor: 'var(--accent-pink)', color: 'var(--accent-pink)' }
        }
      >
        {inPast
          ? 'That moment has already passed — pick a later time.'
          : `⏱ ${comingSoonLabel(chosen.toISOString(), timeZone)}`}
      </p>

      <div className="mt-4 flex gap-3">
        <button
          onClick={onClose}
          disabled={busy}
          className="flex-1 rounded-lg border border-line-strong px-4 py-2.5 text-sm text-ink-secondary transition-colors hover:text-ink disabled:opacity-40"
        >
          Cancel
        </button>
        <button
          onClick={() => onConfirm(chosen)}
          disabled={busy || inPast}
          className="flex-1 rounded-lg px-4 py-2.5 text-sm font-medium text-white shadow-[var(--shadow-brand)] transition-transform enabled:hover:scale-[1.01] disabled:opacity-40"
          style={{ background: 'var(--brand-gradient)' }}
        >
          {busy ? 'Scheduling…' : 'Publish later'}
        </button>
      </div>
    </Dialog>
  )
}
