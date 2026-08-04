'use client'

import * as tus from 'tus-js-client'

import type { UploadTicket } from './admin'

/**
 * The TUS byte-mover, extracted from UploadForm so the single-file form and
 * the episode queue share one implementation. The bytes NEVER touch Vercel
 * or Supabase — serverless bodies cap at ~4.5MB, so a route-handler upload
 * isn't slow, it is impossible (CLAUDE.md trap #5).
 *
 * Resumable on purpose: findPreviousUploads keys on the file fingerprint,
 * so retrying the SAME file against the SAME ticket picks up where the
 * connection dropped.
 */
export function uploadToBunny(
  file: File,
  ticket: UploadTicket,
  onProgress: (pct: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const upload = new tus.Upload(file, {
      endpoint: ticket.upload.tusEndpoint,
      retryDelays: [0, 3000, 8000, 15000, 30000],
      chunkSize: 50 * 1024 * 1024,
      headers: {
        AuthorizationSignature: ticket.upload.headers.AuthorizationSignature,
        AuthorizationExpire: String(ticket.upload.headers.AuthorizationExpire),
        VideoId: ticket.upload.headers.VideoId,
        LibraryId: ticket.upload.headers.LibraryId,
      },
      metadata: {
        filetype: file.type,
        title: file.name,
      },
      onProgress: (sent, total) => onProgress(Math.round((sent / total) * 100)),
      onError: (err) => reject(new Error(err.message)),
      onSuccess: () => resolve(),
    })

    void upload
      .findPreviousUploads()
      .then((previous) => {
        if (previous.length > 0) upload.resumeFromPreviousUpload(previous[0])
        upload.start()
      })
      .catch(() => upload.start())
  })
}

/**
 * "S01E03_final-v2.mp4" → "S01E03 final v2". Good enough as a default the
 * uploader can edit; the server refuses blank titles, hence the fallback.
 */
export function titleFromFilename(name: string): string {
  const base = name.replace(/\.[^.]+$/, '')
  const cleaned = base.replace(/[-_.]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)
  return cleaned || 'Episode'
}
