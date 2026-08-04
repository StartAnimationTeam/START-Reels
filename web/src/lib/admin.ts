'use client'

import { useAuth } from '@clerk/nextjs'
import { useCallback } from 'react'

import { ApiError } from './api'
import type { AccessTier } from './database.types'

/**
 * Client for the admin Edge Functions. Same contract as lib/api.ts: stable
 * machine codes in, lib/labels.ts turns them into English at the render site.
 * The functions verify roles server-side against user_roles on every call —
 * this client carries the token, nothing more.
 */

const FN_BASE = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1`

export interface UploadTicket {
  videoId: string
  /** Present on episode uploads: the number the server assigned. */
  episodeNumber?: number
  upload: {
    tusEndpoint: string
    headers: {
      AuthorizationSignature: string
      AuthorizationExpire: number
      VideoId: string
      LibraryId: string
    }
    maxBytes: number
  }
}

export function useAdminApi() {
  const { getToken } = useAuth()

  const call = useCallback(
    async <T>(fn: string, body: unknown): Promise<T> => {
      const token = await getToken()
      if (!token) throw new ApiError('unauthorized', 401)
      const res = await fetch(`${FN_BASE}/${fn}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new ApiError(data?.error ?? 'unknown_error', res.status)
      return data as T
    },
    [getToken],
  )

  return {
    // With seriesId this mints an EPISODE: the server auto-assigns the next
    // number when episodeNumber is omitted (NOT parallel-safe — create
    // tickets strictly one at a time) and overwrites tier/cost with the
    // series-resolved price, so episode callers omit them.
    createUpload: (meta: {
      title: string
      description?: string
      accessTier?: AccessTier
      creditCost?: number
      seriesId?: string
      episodeNumber?: number
    }) => call<UploadTicket>('video-upload', meta),

    series: (action: string, extra: Record<string, unknown> = {}) =>
      call<{
        ok: true
        series?: { id: string } & Record<string, unknown>
        entitlements_revoked?: number
      }>('series-manage', { action, ...extra }),

    video: (action: string, videoId: string, extra: Record<string, unknown> = {}) =>
      call<{ ok: true }>('admin-videos', { action, videoId, ...extra }),

    user: (action: string, userId: string, extra: Record<string, unknown> = {}) =>
      call<{ ok: true }>('admin-users', { action, userId, ...extra }),

    moderation: (action: string, extra: Record<string, unknown> = {}) =>
      call<{ ok: true }>('moderation', { action, ...extra }),

    platform: (action: string, extra: Record<string, unknown> = {}) =>
      call<{ ok: true; campaign?: { id: string; code: string } }>('admin-platform', { action, ...extra }),
  }
}
