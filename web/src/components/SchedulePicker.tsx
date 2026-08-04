'use client'

import { useMemo, useState } from 'react'

import { Dialog } from '@/components/ui/Dialog'
import { comingSoonLabel } from '@/lib/labels'

/**
 * The premiere picker — replaces the raw datetime-local input, which
 * renders as an unstyled dd/mm/yyyy --:-- box and looks broken against the
 * brand. Zero dependencies, same native-<dialog> primitive as everything
 * else: quick presets, a 14-day strip, an hour grid, and a live
 * "Premieres …" preview so what you confirm is what viewers will read.
 *
 * Past combinations disable themselves; Confirm can never submit a moment
 * that already happened.
 */

const DAYS_AHEAD = 14
const DEFAULT_HOUR = 20 // premieres are an evening ritual

function startOfDay(d: Date): Date {
  const copy = new Date(d)
  copy.setHours(0, 0, 0, 0)
  return copy
}

function hourLabel(hour: number, minute: number): string {
  const d = new Date(2000, 0, 1, hour, minute)
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: minute ? '2-digit' : undefined })
}

export function SchedulePicker({
  open,
  onClose,
  onConfirm,
  busy,
  title,
}: {
  open: boolean
  onClose: () => void
  onConfirm: (when: Date) => void
  busy: boolean
  title: string
}) {
  const now = new Date()
  const [day, setDay] = useState<Date>(() => startOfDay(now))
  const [hour, setHour] = useState(DEFAULT_HOUR)
  const [minute, setMinute] = useState(0)

  const days = useMemo(() => {
    const today = startOfDay(new Date())
    return Array.from({ length: DAYS_AHEAD }, (_, i) => {
      const d = new Date(today)
      d.setDate(today.getDate() + i)
      return d
    })
  }, [])

  const chosen = useMemo(() => {
    const d = new Date(day)
    d.setHours(hour, minute, 0, 0)
    return d
  }, [day, hour, minute])
  const inPast = chosen.getTime() <= Date.now()

  const presets = useMemo(() => {
    const inOneHour = new Date(Date.now() + 60 * 60 * 1000)
    inOneHour.setMinutes(0, 0, 0)
    const tonight = new Date()
    tonight.setHours(DEFAULT_HOUR, 0, 0, 0)
    const tomorrow = new Date(tonight)
    tomorrow.setDate(tomorrow.getDate() + 1)
    const saturday = new Date(tonight)
    saturday.setDate(saturday.getDate() + ((6 - saturday.getDay() + 7) % 7 || 7))
    return [
      { label: 'In an hour', when: inOneHour },
      { label: 'Tonight 8 PM', when: tonight },
      { label: 'Tomorrow 8 PM', when: tomorrow },
      { label: 'Saturday 8 PM', when: saturday },
    ].filter((p) => p.when.getTime() > Date.now())
  }, [])

  const applyPreset = (when: Date) => {
    setDay(startOfDay(when))
    setHour(when.getHours())
    setMinute(when.getMinutes())
  }

  const dayLabel = (d: Date, index: number) => {
    if (index === 0) return 'Today'
    if (index === 1) return 'Tomorrow'
    return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })
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

  const sameDay = (a: Date, b: Date) => a.getTime() === b.getTime()
  const isToday = sameDay(day, startOfDay(new Date()))

  return (
    <Dialog open={open} onClose={onClose} labelledBy="schedule-title">
      <h2 id="schedule-title" className="text-lg font-semibold tracking-tight">
        Publish later
      </h2>
      <p className="mt-1 truncate text-sm text-ink-muted">{title}</p>
      <p className="mt-1 text-xs text-ink-faint">
        Pick freely — nothing is scheduled until you press “Publish later” below.
      </p>

      {/* ── quick presets ─────────────────────────────────────────────── */}
      {presets.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-1.5">
          {presets.map((p) => {
            const active = chosen.getTime() === p.when.getTime()
            return (
              <button key={p.label} onClick={() => applyPreset(p.when)} className={chip(active)} style={chipStyle(active)}>
                {p.label}
              </button>
            )
          })}
        </div>
      )}

      {/* ── day strip ─────────────────────────────────────────────────── */}
      <p className="mt-4 text-xs font-medium text-ink-secondary">Day</p>
      <div className="no-scrollbar -mx-6 mt-1.5 flex gap-1.5 overflow-x-auto px-6 pb-1">
        {days.map((d, i) => {
          const active = sameDay(d, day)
          return (
            <button
              key={d.getTime()}
              onClick={() => setDay(d)}
              className={`shrink-0 ${chip(active)}`}
              style={chipStyle(active)}
            >
              {dayLabel(d, i)}
            </button>
          )
        })}
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
          const past = isToday && new Date(new Date(day).setHours(h, minute, 0, 0)).getTime() <= Date.now()
          const active = hour === h
          return (
            <button
              key={h}
              disabled={past}
              onClick={() => setHour(h)}
              className={chip(active, past)}
              style={chipStyle(active)}
            >
              {hourLabel(h, 0)}
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
        {inPast ? 'That moment has already passed — pick a later time.' : `⏱ ${comingSoonLabel(chosen.toISOString())}`}
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
