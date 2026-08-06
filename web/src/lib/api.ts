'use client'

import { useAuth } from '@clerk/nextjs'
import { useCallback } from 'react'

/**
 * Client-side caller for the Edge Functions — the endpoints that move value
 * or state. Reads never come through here; they go via the RLS-scoped
 * Supabase clients.
 *
 * Responses carry stable machine codes ({ error: "insufficient_credits" }).
 * Translation to English happens in lib/labels.ts at the render site, never
 * here — so a code travels intact through any component boundary.
 */

const FN_BASE = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1`

export class ApiError extends Error {
  constructor(
    public code: string,
    public status: number,
  ) {
    super(code)
  }
}

export interface UnlockResult {
  entitlement_id: string
  ledger_id: string | null
  charged: number
  already_unlocked: boolean
  expires_at: string
}

export interface PlaybackResult {
  url: string
  expires: number
  sessionId: string
  durationSeconds: number | null
}

export interface AdClaimResult {
  status: 'granted' | 'duplicate'
  amount: number
  today_count?: number
  daily_cap?: number
}

export function useApi() {
  const { getToken } = useAuth()

  const call = useCallback(
    async <T>(fn: string, body: unknown): Promise<T> => {
      const token = await getToken()
      if (!token) throw new ApiError('unauthorized', 401)

      const res = await fetch(`${FN_BASE}/${fn}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      })

      const data = await res.json().catch(() => null)
      if (!res.ok) {
        throw new ApiError(data?.error ?? 'unknown_error', res.status)
      }
      return data as T
    },
    [getToken],
  )

  return {
    unlockVideo: (videoId: string) => call<UnlockResult>('video-unlock', { videoId }),
    startPlayback: (videoId: string, device?: string) =>
      call<PlaybackResult>('video-playback', { videoId, device }),
    // The web rewarded-ad claim: claimToken is a client-minted UUID per ad
    // load, making event double-fires and fetch retries idempotent. The
    // server owns every real rule (caps, intervals, amounts).
    claimAdReward: (claimToken: string) => call<AdClaimResult>('ads-claim', { claimToken }),

    heartbeat: (sessionId: string, seconds: number, position: number, ended = false) =>
      call<{ credited: number; settled: boolean }>('watch-heartbeat', {
        sessionId,
        seconds,
        position,
        ended,
      }),
  }
}

/**
 * Final flush on pagehide. sendBeacon can't carry an Authorization header, so
 * the server accepts this shape ONLY for ended:true and credits zero seconds
 * from it — closing early is harmless, crediting requires the JWT.
 */
export function sendEndBeacon(sessionId: string, position: number) {
  navigator.sendBeacon(
    `${FN_BASE}/watch-heartbeat`,
    JSON.stringify({ sessionId, position, ended: true }),
  )
}
