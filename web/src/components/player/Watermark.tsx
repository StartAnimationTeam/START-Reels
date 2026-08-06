'use client'

import { useEffect, useState } from 'react'

/**
 * Forensic watermark — the honest anti-capture answer for the web.
 *
 * No website can block the OS screenshot/recorder (that is hardware DRM,
 * Widevine/FairPlay — trap #16 says don't pretend otherwise). What a
 * platform CAN do is make every capture self-identifying: the viewer's
 * account tag drifts across the frame, so a leaked screenshot or screen
 * recording names the account that leaked it. Faint enough to ignore
 * while watching; present enough to survive a crop that keeps any real
 * picture.
 *
 * The drift also defeats "wait for it to move away" cropping — position
 * changes every few seconds, on a cycle, never leaving the frame.
 */

const SPOTS: Array<{ top: string; left: string }> = [
  { top: '12%', left: '8%' },
  { top: '38%', left: '58%' },
  { top: '64%', left: '12%' },
  { top: '22%', left: '40%' },
  { top: '55%', left: '48%' },
  { top: '78%', left: '30%' },
]

export function Watermark({ label }: { label: string }) {
  const [spot, setSpot] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => setSpot((s) => (s + 1) % SPOTS.length), 7000)
    return () => clearInterval(timer)
  }, [])

  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-[5] overflow-hidden">
      <span
        className="absolute select-none whitespace-nowrap text-[11px] font-medium tracking-widest text-white/25 transition-all duration-[2000ms] ease-in-out"
        style={{
          top: SPOTS[spot].top,
          left: SPOTS[spot].left,
          transform: 'rotate(-14deg)',
          textShadow: '0 0 3px rgba(0,0,0,0.5)',
        }}
      >
        {label}
      </span>
    </div>
  )
}

/** The account tag burned into captures: site + enough id to trace it. */
export function watermarkLabel(userId: string | null): string {
  return userId ? `startreels.com · ${userId.slice(-8)}` : 'startreels.com'
}
